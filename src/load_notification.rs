//! Resource-load notification evaluation and delivery.
//!
//! This module deliberately stays separate from the connection lifecycle
//! notification state machine. It reads the minute metric history, keeps one
//! durable state per rule/node pair, and uses the existing Telegram sender.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::Utc;
use tokio::sync::Semaphore;
use tracing::{debug, warn};

use crate::db::{Db, LoadMetricSample, LoadNotificationAction, LoadNotificationKind, Node};
use crate::Shared;

const EVALUATION_TICK_SECONDS: u64 = 30;
const SEND_SLOTS: usize = 8;

#[derive(Clone)]
pub struct LoadNotificationManager {
    send_slots: Arc<Semaphore>,
}

impl Default for LoadNotificationManager {
    fn default() -> Self {
        Self { send_slots: Arc::new(Semaphore::new(SEND_SLOTS)) }
    }
}

impl LoadNotificationManager {
    /// Starts one scheduler for the hub. The scheduler is intentionally
    /// global rather than one Tokio task per rule: editing many rules cannot
    /// leak timers, and the durable last-evaluated timestamp remains the
    /// single source of truth after a restart.
    pub fn start(&self, app: Shared) {
        let manager = self.clone();
        tokio::spawn(async move {
            manager.evaluate_once(app.clone(), false).await;
            let mut tick = tokio::time::interval(Duration::from_secs(EVALUATION_TICK_SECONDS));
            tick.tick().await;
            loop {
                tick.tick().await;
                manager.evaluate_once(app.clone(), true).await;
            }
        });
    }

    async fn evaluate_once(&self, app: Shared, send_notifications: bool) {
        let now = Utc::now().timestamp();
        let result = tokio::task::spawn_blocking({
            let app = app.clone();
            move || evaluate_due(&app.db, now, send_notifications)
        })
        .await;
        let actions = match result {
            Ok(Ok(actions)) => actions,
            Ok(Err(error)) => {
                warn!("load notification evaluation failed: {error:#}");
                return;
            }
            Err(error) => {
                warn!("load notification evaluation task failed: {error:#}");
                return;
            }
        };
        for action in actions {
            let Ok(permit) = self.send_slots.clone().try_acquire_owned() else {
                warn!(
                    rule_id = action.rule_id,
                    node_id = action.node_id,
                    "load notification send queue is full; releasing claim for the next evaluation"
                );
                let _ = tokio::task::block_in_place(|| {
                    app.db.release_load_notification_claim(action.rule_id, action.node_id)
                });
                continue;
            };
            let app = app.clone();
            tokio::spawn(async move {
                let _permit = permit;
                deliver(app, action).await;
            });
        }
    }
}

fn evaluate_due(db: &Db, now: i64, send_notifications: bool) -> Result<Vec<LoadNotificationAction>> {
    let rules = db.load_rules()?;
    let mut actions = Vec::new();
    for rule in rules {
        if !rule.enabled {
            continue;
        }
        for target in rule.nodes.iter().filter(|target| target.enabled) {
            if !db.load_alert_due(rule.id, target.node_id, now)? {
                continue;
            }
            let Some(node) = db.node(target.node_id)? else {
                continue;
            };
            let samples = db.load_metric_samples(
                target.node_id,
                now.saturating_sub(rule.interval_minutes.saturating_mul(60)),
                now,
            )?;
            let mut values = Vec::with_capacity(samples.len());
            for sample in &samples {
                if let Some(value) = metric_value(&rule.metric, sample, &node) {
                    if value.is_finite() && value >= 0.0 {
                        values.push(value);
                    }
                }
            }
            let total_samples = values.len() as i64;
            let matched_samples = values.iter().filter(|value| **value >= rule.threshold).count() as i64;
            let active = load_is_active(&values, rule.threshold, rule.ratio);
            let latest_value = values.last().copied();
            if let Some(mut action) = db.apply_load_evaluation(
                rule.id,
                target.node_id,
                rule.revision,
                active,
                latest_value,
                matched_samples,
                total_samples,
                now,
                send_notifications,
            )? {
                action.node_name = node.name;
                actions.push(action);
            }
        }
    }
    Ok(actions)
}

fn required_samples(total_samples: usize, ratio: f64) -> usize {
    ((total_samples as f64) * ratio).ceil().max(1.0) as usize
}

fn load_is_active(values: &[f64], threshold: f64, ratio: f64) -> bool {
    if values.is_empty() {
        return false;
    }
    let matched = values.iter().filter(|value| **value >= threshold).count();
    matched >= required_samples(values.len(), ratio)
}

fn metric_value(metric: &str, sample: &LoadMetricSample, node: &Node) -> Option<f64> {
    match metric {
        "cpu" => Some(sample.cpu),
        "ram" if node.mem_total > 0 => Some(sample.mem_used as f64 / node.mem_total as f64 * 100.0),
        "disk" if node.disk_total > 0 => Some(sample.disk_used as f64 / node.disk_total as f64 * 100.0),
        "net_in" => Some(sample.net_rx as f64 * 8.0 / 1_000_000.0),
        "net_out" => Some(sample.net_tx as f64 * 8.0 / 1_000_000.0),
        _ => None,
    }
}

async fn deliver(app: Shared, action: LoadNotificationAction) {
    if !crate::api::notification_config(&app).enabled {
        release_claim(&app, &action);
        return;
    }
    if !claim_allowed(&app, &action) {
        release_claim(&app, &action);
        return;
    }
    let text = message(&action);
    for attempt in 0..3 {
        if !crate::api::notification_config(&app).enabled || !claim_allowed(&app, &action) {
            release_claim(&app, &action);
            return;
        }
        match crate::api::send_telegram_message(&app, &text).await {
            Ok(()) => {
                let result = tokio::task::block_in_place(|| {
                    app.db.complete_load_notification(
                        action.rule_id,
                        action.node_id,
                        action.kind,
                        Utc::now().timestamp(),
                    )
                });
                if let Err(error) = result {
                    warn!(
                        rule_id = action.rule_id,
                        node_id = action.node_id,
                        "recording load notification delivery failed: {error:#}"
                    );
                }
                return;
            }
            Err(error) if attempt < 2 => {
                debug!(
                    rule_id = action.rule_id,
                    node_id = action.node_id,
                    attempt = attempt + 1,
                    "load notification send failed: {error}; retrying"
                );
                tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
            }
            Err(error) => {
                warn!(
                    rule_id = action.rule_id,
                    node_id = action.node_id,
                    "load notification send failed: {error}"
                );
                release_claim(&app, &action);
                return;
            }
        }
    }
}

fn claim_allowed(app: &Shared, action: &LoadNotificationAction) -> bool {
    tokio::task::block_in_place(|| {
        app.db.load_notification_claim_allowed(action.rule_id, action.node_id, action.kind).unwrap_or(false)
    })
}

fn release_claim(app: &Shared, action: &LoadNotificationAction) {
    let _ = tokio::task::block_in_place(|| {
        app.db.release_load_notification_claim(action.rule_id, action.node_id)
    });
}

fn escape_html(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn format_value(metric: &str, value: f64) -> String {
    let unit = if matches!(metric, "net_in" | "net_out") { "Mbps" } else { "%" };
    format!("{value:.2} {unit}")
}

fn message(action: &LoadNotificationAction) -> String {
    let metric = escape_html(&action.metric);
    let rule = escape_html(&action.rule_name);
    let node = escape_html(&action.node_name);
    let kind = match action.kind {
        LoadNotificationKind::Alert => "⚠️ <b>负载告警</b>",
        LoadNotificationKind::Recovery => "✅ <b>负载恢复</b>",
    };
    let state = format!("{}/{} 个采样点达到阈值", action.matched_samples, action.total_samples);
    format!(
        "{kind}\n服务器：<b>{node}</b>\n规则：<b>{rule}</b>\n监控项：{metric}\n当前值：{}\n阈值：{}\n时间占比：{:.2}（{state}）\n评估窗口：{} 分钟",
        format_value(&action.metric, action.latest_value),
        format_value(&action.metric, action.threshold),
        action.ratio,
        action.interval_minutes,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metric_units_are_converted_without_treating_network_as_percent() {
        let sample = LoadMetricSample {
            ts: 0,
            cpu: 80.0,
            mem_used: 50,
            disk_used: 25,
            net_rx: 1_000_000,
            net_tx: 2_000_000,
        };
        let node = Node { mem_total: 100, disk_total: 50, ..Node::default() };
        assert_eq!(metric_value("cpu", &sample, &node), Some(80.0));
        assert_eq!(metric_value("ram", &sample, &node), Some(50.0));
        assert_eq!(metric_value("disk", &sample, &node), Some(50.0));
        assert_eq!(metric_value("net_in", &sample, &node), Some(8.0));
        assert_eq!(metric_value("net_out", &sample, &node), Some(16.0));
        assert_eq!(metric_value("ram", &sample, &Node::default()), None);
    }

    #[test]
    fn ratio_uses_ceil_minimum_one_and_inclusive_threshold() {
        assert_eq!(required_samples(0, 0.5), 1);
        assert_eq!(required_samples(3, 0.5), 2);
        assert_eq!(required_samples(4, 0.25), 1);
        assert!(load_is_active(&[80.0, 80.0, 79.0], 80.0, 2.0 / 3.0));
        assert!(!load_is_active(&[80.0, 79.0, 79.0], 80.0, 2.0 / 3.0));
        assert!(load_is_active(&[80.0], 80.0, 1.0));
    }

    #[test]
    fn no_samples_do_not_alert_and_partial_windows_are_evaluated() {
        assert!(!load_is_active(&[], 80.0, 0.5));
        // A complete interval is not required: one of two available samples
        // is enough for a 50% ratio, and equality meets the threshold.
        assert!(load_is_active(&[80.0, 70.0], 80.0, 0.5));
    }
}
