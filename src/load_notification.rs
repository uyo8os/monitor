//! Evaluates resource usage against configured windows and queues notifications.
use crate::db::{
    Db, LoadEvaluation, LoadMetricSample, LoadNoteKey, LoadNotificationAction, LoadNotificationKind, Node,
};
use crate::{notify, Shared};
use anyhow::Result;
use chrono::Utc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tracing::warn;

#[derive(Clone, Default)]
pub struct LoadNotificationManager {
    lock: Arc<Mutex<()>>,
    generation: Arc<AtomicU64>,
}

impl LoadNotificationManager {
    /// A restore waits for any evaluation before replacing its database rows.
    pub fn restore_guard(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }
    pub fn invalidate_all(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }
    pub fn start(&self, app: Shared) {
        let manager = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(30));
            loop {
                tick.tick().await;
                let app = app.clone();
                let manager = manager.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let _guard = manager.restore_guard();
                    let now = Utc::now().timestamp();
                    let actions = evaluate_due(&app.db, now)?;
                    for action in actions {
                        if notify::try_send(&app, note(&action, manager.generation())) {
                            app.db.complete_load_notification(
                                action.rule_id,
                                action.node_id,
                                action.kind,
                                now,
                            )?;
                        } else {
                            app.db.retry_load_enqueue(action.rule_id, action.node_id)?;
                        }
                    }
                    Ok::<_, anyhow::Error>(())
                })
                .await;
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => warn!("load evaluation failed: {error:#}"),
                    Err(error) => warn!("load evaluation task failed: {error:#}"),
                }
            }
        });
    }
}

pub(crate) fn evaluate_due(db: &Db, now: i64) -> Result<Vec<LoadNotificationAction>> {
    let mut actions = Vec::new();
    for rule in db.load_rules()?.into_iter().filter(|r| r.enabled) {
        for target in rule.nodes.iter().filter(|n| n.enabled) {
            if !db.load_alert_due(rule.id, target.node_id, now)? {
                continue;
            }
            let Some(node) = db.node(target.node_id)? else {
                continue;
            };
            // The hub stamps completed minute buckets at their ending minute.
            let end = now.div_euclid(60) * 60;
            let samples = db.load_metric_samples(
                target.node_id,
                end.saturating_sub(rule.interval_minutes * 60).saturating_add(1),
                end,
            )?;
            let last = db.last_load_sample(rule.id, target.node_id)?;
            // Old rows within the window do not prove the node recovered.
            if !samples.last().is_some_and(|sample| sample.ts > last && now.saturating_sub(sample.ts) < 120) {
                continue;
            }
            let values: Vec<f64> = samples
                .iter()
                .filter_map(|sample| metric_value(&rule.metric, sample, &node))
                .filter(|v| v.is_finite() && *v >= 0.0)
                .collect();
            if values.is_empty() {
                continue;
            }
            let matched = values.iter().filter(|value| **value >= rule.threshold).count();
            let active = matched >= ((values.len() as f64) * rule.ratio).ceil().max(1.0) as usize;
            if let Some(mut action) = db.apply_load_evaluation(LoadEvaluation {
                rule_id: rule.id,
                node_id: target.node_id,
                revision: rule.revision,
                active,
                latest_value: values.last().copied(),
                matched_samples: matched as i64,
                total_samples: values.len() as i64,
                now,
            })? {
                action.node_name = node.name;
                actions.push(action);
            }
            if let Some(sample) = samples.last() {
                db.set_last_load_sample(rule.id, target.node_id, rule.revision, sample.ts)?;
            }
        }
    }
    Ok(actions)
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

#[derive(Debug, Clone)]
pub struct LoadNote {
    rule_id: i64,
    node_id: i64,
    revision: i64,
    token: i64,
    episode: i64,
    active: bool,
    generation: u64,
}

impl LoadNote {
    pub fn delivered(&self, app: &Shared, channel: &str) {
        if self.active && self.generation == app.load_notifications.generation() {
            if let Err(error) =
                app.db.mark_load_delivered(self.rule_id, self.node_id, self.revision, self.episode, channel)
            {
                warn!("recording load delivery failed: {error:#}");
            }
        }
    }
    pub fn allowed(&self, app: &Shared, channel: &str) -> bool {
        self.generation == app.load_notifications.generation()
            && app
                .db
                .load_note_allowed(
                    &LoadNoteKey {
                        rule_id: self.rule_id,
                        node_id: self.node_id,
                        revision: self.revision,
                        token: self.token,
                        active: self.active,
                    },
                    channel,
                    Utc::now().timestamp(),
                )
                .unwrap_or(false)
    }
}

fn note(action: &LoadNotificationAction, generation: u64) -> notify::Note {
    let (event, title) = match action.kind {
        LoadNotificationKind::Alert => ("load_alert", "负载告警"),
        LoadNotificationKind::Recovery => ("load_recovery", "负载恢复"),
    };
    let unit = if matches!(action.metric.as_str(), "net_in" | "net_out") { "Mbps" } else { "%" };
    notify::Note {
        event,
        node: action.node_name.clone(),
        title: title.into(),
        load: Some(LoadNote { rule_id: action.rule_id, node_id: action.node_id, revision: action.revision, token: action.token, episode: action.episode, active: action.kind == LoadNotificationKind::Alert, generation }),
        message: format!("服务器：{}\n规则：{}\n监控项：{}\n当前值：{:.2} {}\n阈值：{:.2} {}\n采样占比：{}/{}\n评估窗口：{} 分钟", action.node_name, action.rule_name, action.metric, action.latest_value, unit, action.threshold, unit, action.matched_samples, action.total_samples, action.interval_minutes),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{LoadRule, LoadRuleNode};
    use serde_json::json;

    fn rule(node: i64, interval: i64) -> LoadRule {
        LoadRule {
            id: 0,
            name: "cpu".into(),
            metric: "cpu".into(),
            threshold: 80.0,
            ratio: 0.5,
            interval_minutes: interval,
            enabled: true,
            default_enabled: true,
            revision: 1,
            created_at: 0,
            updated_at: 0,
            nodes: vec![LoadRuleNode { node_id: node, enabled: true }],
        }
    }
    fn node(db: &Db, name: &str) -> i64 {
        db.create_node(&Node { name: name.into(), ..Node::default() }, name).unwrap()
    }
    fn allowed(
        db: &Db,
        id: i64,
        node: i64,
        action: &LoadNotificationAction,
        channel: &str,
        active: bool,
        now: i64,
    ) -> bool {
        db.load_note_allowed(
            &LoadNoteKey {
                rule_id: id,
                node_id: node,
                revision: action.revision,
                token: action.token,
                active,
            },
            channel,
            now,
        )
        .unwrap()
    }
    #[test]
    fn minute_window_uses_end_stamp_and_no_new_sample_never_recovers() {
        let db = Db::open(":memory:").unwrap();
        let n = node(&db, "a");
        let id = db.create_load_rule(&rule(n, 2)).unwrap();
        db.insert_metric(n, 180, &json!({"cpu": 90})).unwrap();
        let first = evaluate_due(&db, 185).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].kind, LoadNotificationKind::Alert);
        db.complete_load_notification(id, n, first[0].kind, 185).unwrap();
        assert!(evaluate_due(&db, 305).unwrap().is_empty());
        let alerts = db.current_load_alerts(500).unwrap();
        assert_eq!(alerts.len(), 1);
        assert!(alerts[0].stale);
        db.insert_metric(n, 360, &json!({"cpu": 20})).unwrap();
        let recovered = evaluate_due(&db, 365).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].kind, LoadNotificationKind::Recovery);
    }
    #[test]
    fn one_minute_rule_accepts_new_boundary_and_retries_full_queue() {
        let db = Db::open(":memory:").unwrap();
        let n = node(&db, "b");
        let id = db.create_load_rule(&rule(n, 1)).unwrap();
        db.insert_metric(n, 120, &json!({"cpu": 90})).unwrap();
        let first = evaluate_due(&db, 130).unwrap();
        assert_eq!(first.len(), 1);
        db.retry_load_enqueue(id, n).unwrap();
        assert_eq!(evaluate_due(&db, 140).unwrap().len(), 1);
    }
    #[test]
    fn default_targets_and_queued_event_checks_follow_edits_and_deletions() {
        let db = Db::open(":memory:").unwrap();
        let first = node(&db, "c");
        let id = db.create_load_rule(&rule(first, 1)).unwrap();
        let second = node(&db, "d");
        assert!(db.load_rules().unwrap()[0].nodes.iter().any(|n| n.node_id == second));
        db.insert_metric(first, 120, &json!({"cpu": 90})).unwrap();
        let action = evaluate_due(&db, 130).unwrap().remove(0);
        assert!(allowed(&db, id, first, &action, "Telegram", true, 130));
        db.set_load_alert_silence(id, first, None, true, 131).unwrap();
        assert!(!allowed(&db, id, first, &action, "Telegram", true, 131));
        let mut changed = db.load_rules().unwrap().remove(0);
        changed.threshold = 95.0;
        db.update_load_rule(id, &changed).unwrap();
        assert!(db.current_load_alerts(132).unwrap().is_empty());
        db.delete_node(second).unwrap();
        assert!(!db.load_rules().unwrap()[0].nodes.iter().any(|n| n.node_id == second));
        db.delete_load_rule(id).unwrap();
        assert!(!allowed(&db, id, first, &action, "Telegram", true, 132));
        let next = db.create_load_rule(&rule(first, 1)).unwrap();
        assert_ne!(id, next);
    }
    #[test]
    fn old_offline_samples_do_not_create_fresh_alerts() {
        let db = Db::open(":memory:").unwrap();
        let n = node(&db, "old");
        db.create_load_rule(&rule(n, 120)).unwrap();
        db.insert_metric(n, 600, &json!({"cpu": 90})).unwrap();
        assert!(evaluate_due(&db, 1800).unwrap().is_empty());
        assert!(db.current_load_alerts(1800).unwrap().is_empty());
    }

    #[test]
    fn queued_repeats_remain_valid_and_recovery_requires_delivery_per_channel() {
        let db = Db::open(":memory:").unwrap();
        let n = node(&db, "delivery");
        let id = db.create_load_rule(&rule(n, 1)).unwrap();
        db.insert_metric(n, 120, &json!({"cpu": 90})).unwrap();
        let first = evaluate_due(&db, 130).unwrap().remove(0);
        db.complete_load_notification(id, n, first.kind, 130).unwrap();
        db.insert_metric(n, 180, &json!({"cpu": 95})).unwrap();
        let repeat = evaluate_due(&db, 190).unwrap().remove(0);
        assert_eq!(first.token, repeat.token);
        assert!(allowed(&db, id, n, &first, "Telegram", true, 190));
        db.complete_load_notification(id, n, repeat.kind, 190).unwrap();
        db.mark_load_delivered(id, n, first.revision, first.episode, "Telegram").unwrap();
        db.insert_metric(n, 240, &json!({"cpu": 10})).unwrap();
        let recovery = evaluate_due(&db, 250).unwrap().remove(0);
        db.complete_load_notification(id, n, recovery.kind, 250).unwrap();
        assert!(!allowed(&db, id, n, &first, "Telegram", true, 250));
        assert!(allowed(&db, id, n, &recovery, "Telegram", false, 250));
        assert!(!allowed(&db, id, n, &recovery, "Webhook", false, 250));
        db.insert_metric(n, 300, &json!({"cpu": 90})).unwrap();
        let new_alert = evaluate_due(&db, 310).unwrap().remove(0);
        assert_ne!(first.episode, new_alert.episode);
        assert!(!allowed(&db, id, n, &recovery, "Telegram", false, 310));
        assert!(!allowed(&db, id, n, &first, "Telegram", true, 310));
    }

    #[test]
    fn metric_values_use_percent_and_megabits() {
        let sample = LoadMetricSample {
            ts: 0,
            cpu: 80.0,
            mem_used: 50,
            disk_used: 25,
            net_rx: 1_000_000,
            net_tx: 2_000_000,
        };
        let node = Node { mem_total: 100, disk_total: 50, ..Default::default() };
        assert_eq!(metric_value("cpu", &sample, &node), Some(80.0));
        assert_eq!(metric_value("ram", &sample, &node), Some(50.0));
        assert_eq!(metric_value("disk", &sample, &node), Some(50.0));
        assert_eq!(metric_value("net_in", &sample, &node), Some(8.0));
        assert_eq!(metric_value("net_out", &sample, &node), Some(16.0));
    }
}
