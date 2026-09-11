//! Durable notifications shared by billing, traffic and administrator login events.
//!
//! Connection lifecycle and load-rule notifications have their own state
//! machines. This module owns only the general notification outbox and the
//! scheduler that turns its claimed rows into Telegram messages.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::{FixedOffset, NaiveDate, Timelike, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tracing::{debug, warn};

use crate::db::{CommonNotificationEvent, DeliveryFailure, Node};
use crate::notification::{TELEGRAM_RETRY_DELAYS_SECONDS, TELEGRAM_TOTAL_ATTEMPTS};
use crate::{App, Shared};

pub(crate) const RENEW_ENABLED_KEY: &str = "common_renew_enabled";
pub(crate) const EXPIRY_ENABLED_KEY: &str = "common_expiry_enabled";
pub(crate) const EXPIRY_LEAD_DAYS_KEY: &str = "common_expiry_lead_days";
pub(crate) const EXPIRY_CHECK_TIME_KEY: &str = "common_expiry_check_time";
const EXPIRY_LAST_CHECK_DATE_KEY: &str = "common_expiry_last_check_date";
pub(crate) const TRAFFIC_ENABLED_KEY: &str = "common_traffic_enabled";
pub(crate) const TRAFFIC_START_PERCENT_KEY: &str = "common_traffic_start_percent";
pub(crate) const LOGIN_ENABLED_KEY: &str = "common_login_enabled";
pub(crate) const DEFAULT_EXPIRY_LEAD_DAYS: i64 = 7;
pub(crate) const DEFAULT_EXPIRY_CHECK_MINUTES: u16 = 0;
pub(crate) const MAX_EXPIRY_LEAD_DAYS: i64 = 365;
pub(crate) const DEFAULT_TRAFFIC_START_PERCENT: i64 = 80;
pub(crate) const MAX_TRAFFIC_START_PERCENT: i64 = 100;
pub(crate) const TRAFFIC_STEP_PERCENT: i64 = 5;
const EVALUATION_TICK_SECONDS: u64 = 60;
const SEND_SLOTS: usize = 8;
const CLAIM_STALE_AFTER: i64 = 600;
const MAX_EXPIRY_MESSAGE_CHARS: usize = 3_800;

#[derive(Debug, Clone, Copy)]
pub(crate) struct CommonNotificationConfig {
    pub global_enabled: bool,
    pub renew_enabled: bool,
    pub expiry_enabled: bool,
    pub expiry_lead_days: i64,
    pub expiry_check_minutes: u16,
    pub traffic_enabled: bool,
    pub traffic_start_percent: i64,
    pub login_enabled: bool,
}

#[derive(Clone)]
pub struct CommonNotificationManager {
    send_slots: Arc<Semaphore>,
    generation: Arc<AtomicU64>,
}

#[derive(Debug, Clone)]
struct PlannedEvent {
    id: String,
    kind: String,
    node_id: Option<i64>,
    period_key: String,
    bucket: i64,
    payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExpiryItem {
    name: String,
    days: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct TrafficItem {
    name: String,
    used: i64,
    limit: i64,
    percent: f64,
    bucket: i64,
    mode: String,
    period: String,
    #[serde(default)]
    start_percent: i64,
}

#[derive(Debug, Deserialize)]
struct LoginItem {
    ip: String,
    auth_method: String,
}

impl Default for CommonNotificationManager {
    fn default() -> Self {
        Self { send_slots: Arc::new(Semaphore::new(SEND_SLOTS)), generation: Arc::new(AtomicU64::new(0)) }
    }
}

impl CommonNotificationManager {
    /// Invalidates evaluation and delivery tasks that may still hold rows from
    /// the database being replaced by a restore.
    pub fn invalidate_all(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::Acquire) == generation
    }

    /// One global scheduler avoids one timer per node and replays durable
    /// pending renew/login events after a process restart.
    pub fn start(&self, app: Shared) {
        let manager = self.clone();
        tokio::spawn(async move {
            manager.run_once(app.clone()).await;
            let mut tick = tokio::time::interval(Duration::from_secs(EVALUATION_TICK_SECONDS));
            tick.tick().await;
            loop {
                tick.tick().await;
                manager.run_once(app.clone()).await;
            }
        });
    }

    /// Runs one evaluation cycle. It is public so the hourly housekeeping task
    /// can immediately drain a renewal outbox row created by its date update.
    pub async fn run_once(&self, app: Shared) {
        let generation = self.generation.load(Ordering::Acquire);
        let result = tokio::task::spawn_blocking({
            let app = app.clone();
            move || prepare_events(&app)
        })
        .await;
        let events = match result {
            Ok(Ok(events)) => events,
            Ok(Err(error)) => {
                warn!("common notification evaluation failed: {error:#}");
                return;
            }
            Err(error) => {
                warn!("common notification evaluation task failed: {error:#}");
                return;
            }
        };

        // A restore can finish while the blocking evaluation is running. Do
        // not release or otherwise touch rows in the restored database: the
        // old claims belong to the invalidated generation.
        if !self.is_current(generation) {
            return;
        }

        for event in events {
            if !self.is_current(generation) {
                return;
            }
            let Ok(permit) = self.send_slots.clone().try_acquire_owned() else {
                warn!(event_id = %event.id, "common notification send queue is full; releasing claim");
                release_event(self, &app, &event.id, generation);
                continue;
            };
            let manager = self.clone();
            let app = app.clone();
            tokio::spawn(async move {
                let _permit = permit;
                deliver(manager, app, event, generation).await;
            });
        }
    }

    fn schedule_run(&self, app: Shared, generation: u64, retry_at: i64) {
        let manager = self.clone();
        tokio::spawn(async move {
            let wait = retry_at.saturating_sub(Utc::now().timestamp()).max(0) as u64;
            if wait > 0 {
                tokio::time::sleep(Duration::from_secs(wait)).await;
            }
            if manager.is_current(generation) {
                manager.run_once(app).await;
            }
        });
    }
}

pub(crate) fn config(app: &App) -> CommonNotificationConfig {
    CommonNotificationConfig {
        global_enabled: crate::api::notification_config(app).enabled,
        renew_enabled: setting_enabled(app, RENEW_ENABLED_KEY, false),
        expiry_enabled: setting_enabled(app, EXPIRY_ENABLED_KEY, false),
        expiry_lead_days: app
            .db
            .get(EXPIRY_LEAD_DAYS_KEY)
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|value| (0..=MAX_EXPIRY_LEAD_DAYS).contains(value))
            .unwrap_or(DEFAULT_EXPIRY_LEAD_DAYS),
        expiry_check_minutes: app
            .db
            .get(EXPIRY_CHECK_TIME_KEY)
            .and_then(|value| parse_expiry_check_time(&value))
            .unwrap_or(DEFAULT_EXPIRY_CHECK_MINUTES),
        traffic_enabled: setting_enabled(app, TRAFFIC_ENABLED_KEY, false),
        traffic_start_percent: app
            .db
            .get(TRAFFIC_START_PERCENT_KEY)
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|value| (0..=MAX_TRAFFIC_START_PERCENT).contains(value))
            .unwrap_or(DEFAULT_TRAFFIC_START_PERCENT),
        login_enabled: setting_enabled(app, LOGIN_ENABLED_KEY, false),
    }
}

pub(crate) fn settings_json(app: &App) -> serde_json::Value {
    let cfg = config(app);
    serde_json::json!({
        "global_enabled": cfg.global_enabled,
        "renew_enabled": cfg.renew_enabled,
        "expiry_enabled": cfg.expiry_enabled,
        "expiry_lead_days": cfg.expiry_lead_days,
        "expiry_check_time": format_expiry_check_time(cfg.expiry_check_minutes),
        "traffic_enabled": cfg.traffic_enabled,
        "traffic_start_percent": cfg.traffic_start_percent,
        "traffic_step_percent": TRAFFIC_STEP_PERCENT,
        "login_enabled": cfg.login_enabled,
    })
}

fn setting_enabled(app: &App, key: &str, default: bool) -> bool {
    match app.db.get(key).as_deref() {
        Some("on" | "true" | "1") => true,
        Some("off" | "false" | "0") => false,
        _ => default,
    }
}

pub(crate) fn parse_expiry_check_time(value: &str) -> Option<u16> {
    let bytes = value.as_bytes();
    if bytes.len() != 5
        || bytes[2] != b':'
        || !bytes[..2].iter().all(|byte| byte.is_ascii_digit())
        || !bytes[3..].iter().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let hour = u16::from(bytes[0] - b'0') * 10 + u16::from(bytes[1] - b'0');
    let minute = u16::from(bytes[3] - b'0') * 10 + u16::from(bytes[4] - b'0');
    if hour < 24 && minute < 60 {
        Some(hour * 60 + minute)
    } else {
        None
    }
}

pub(crate) fn format_expiry_check_time(minutes: u16) -> String {
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

fn beijing_offset() -> FixedOffset {
    FixedOffset::east_opt(8 * 3_600).expect("UTC+8 is a valid fixed offset")
}

fn beijing_now() -> chrono::DateTime<FixedOffset> {
    Utc::now().with_timezone(&beijing_offset())
}

#[cfg(test)]
fn beijing_today() -> NaiveDate {
    beijing_now().date_naive()
}

fn expiry_check_is_due(now: chrono::DateTime<FixedOffset>, check_minutes: u16) -> bool {
    let current_minutes = (now.hour() * 60 + now.minute()) as u16;
    current_minutes >= check_minutes
}

fn event_allowed(cfg: CommonNotificationConfig, kind: &str) -> bool {
    cfg.global_enabled
        && match kind {
            "renew" => cfg.renew_enabled,
            "expiry" => cfg.expiry_enabled,
            "traffic" => cfg.traffic_enabled,
            "login" => cfg.login_enabled,
            _ => false,
        }
}

/// Returns the current 5% reminder bucket once the configured first threshold
/// has been reached. A zero threshold disables traffic reminders entirely.
fn traffic_bucket(percent: f64, start_percent: i64) -> Option<i64> {
    if start_percent <= 0 || percent < start_percent as f64 {
        return None;
    }
    let first_grid_bucket =
        ((start_percent + TRAFFIC_STEP_PERCENT - 1) / TRAFFIC_STEP_PERCENT * TRAFFIC_STEP_PERCENT).min(100);
    let current_bucket =
        ((percent / TRAFFIC_STEP_PERCENT as f64).floor() as i64 * TRAFFIC_STEP_PERCENT).min(100);
    // A custom threshold such as 83% must first say "83%", not claim the
    // future 85% bucket was reached. Once the next grid point is real, normal
    // five-percent reminders continue from there.
    Some(if current_bucket < first_grid_bucket { start_percent } else { current_bucket })
}

fn prepare_events(app: &App) -> Result<Vec<PlannedEvent>> {
    let cfg = config(app);
    let kinds = ["renew", "expiry", "traffic", "login"];
    for kind in kinds {
        if !event_allowed(cfg, kind) {
            for event in app.db.pending_common_events(kind)? {
                app.db.complete_common_event(&event.id, Utc::now().timestamp())?;
            }
        }
    }
    if !cfg.global_enabled {
        return Ok(Vec::new());
    }

    if event_allowed(cfg, "expiry") {
        enqueue_expiry_event(app, cfg.expiry_lead_days, cfg.expiry_check_minutes)?;
    }
    if event_allowed(cfg, "traffic") {
        enqueue_traffic_events(app, cfg.traffic_start_percent)?;
    }

    let mut planned = Vec::new();
    let mut claimed = HashSet::new();
    let mut claimed_ids = Vec::new();
    for kind in kinds {
        if !event_allowed(cfg, kind) {
            continue;
        }
        let events = match app.db.pending_common_events(kind) {
            Ok(events) => events,
            Err(error) => {
                release_claims(app, &claimed_ids);
                return Err(error.into());
            }
        };
        for event in events {
            if !claimed.insert(event.id.clone()) {
                continue;
            }
            let is_claimed =
                match app.db.claim_common_event(&event.id, Utc::now().timestamp(), CLAIM_STALE_AFTER) {
                    Ok(is_claimed) => is_claimed,
                    Err(error) => {
                        release_claims(app, &claimed_ids);
                        return Err(error.into());
                    }
                };
            if is_claimed {
                claimed_ids.push(event.id.clone());
                planned.push(planned_event(event));
            }
        }
    }
    Ok(planned)
}

fn release_claims(app: &App, ids: &[String]) {
    for id in ids {
        if let Err(error) = app.db.release_common_event(id) {
            warn!(event_id = %id, "releasing common notification claim after evaluation failure failed: {error:#}");
        }
    }
}

fn planned_event(event: CommonNotificationEvent) -> PlannedEvent {
    PlannedEvent {
        id: event.id,
        kind: event.kind,
        node_id: event.node_id,
        period_key: event.period_key,
        bucket: event.bucket,
        payload: event.payload,
    }
}

fn enqueue_expiry_event(app: &App, lead_days: i64, check_minutes: u16) -> Result<()> {
    let now = beijing_now();
    if !expiry_check_is_due(now, check_minutes) {
        return Ok(());
    }
    let today = now.date_naive();
    let today_key = today.to_string();
    if app.db.get(EXPIRY_LAST_CHECK_DATE_KEY).as_deref() == Some(today_key.as_str()) {
        return Ok(());
    }

    let mut items = Vec::new();
    for node in app.db.nodes()? {
        let Some(expires) = node.expires_at.as_deref().and_then(|value| value.parse::<NaiveDate>().ok())
        else {
            continue;
        };
        let days = expires.signed_duration_since(today).num_days();
        if (0..=lead_days).contains(&days) {
            items.push(ExpiryItem { name: display_name(&node), days });
        }
    }
    if items.is_empty() {
        app.db.set(EXPIRY_LAST_CHECK_DATE_KEY, &today_key)?;
        return Ok(());
    }
    items.sort_by(|left, right| left.days.cmp(&right.days).then_with(|| left.name.cmp(&right.name)));

    // Telegram rejects a message over 4096 characters. Keep margin for the
    // HTML parser and put each segment in its own durable event so a failed
    // segment does not resend segments that were already delivered.
    let mut segments: Vec<Vec<ExpiryItem>> = Vec::new();
    let mut current = Vec::new();
    for item in items {
        let mut candidate = current.clone();
        candidate.push(item.clone());
        if !current.is_empty() && expiry_message(&candidate).chars().count() > MAX_EXPIRY_MESSAGE_CHARS {
            segments.push(current);
            current = Vec::new();
        }
        current.push(item);
    }
    if !current.is_empty() {
        segments.push(current);
    }

    for (segment, items) in segments.into_iter().enumerate() {
        let payload = serde_json::to_string(&items)?;
        let id = format!("expiry:{today}:{}", segment + 1);
        app.db.enqueue_common_event(
            &id,
            "expiry",
            None,
            &today.to_string(),
            segment as i64,
            &payload,
            Utc::now().timestamp(),
        )?;
    }
    app.db.set(EXPIRY_LAST_CHECK_DATE_KEY, &today_key)?;
    Ok(())
}

fn enqueue_traffic_events(app: &App, start_percent: i64) -> Result<()> {
    let traffic = app.db.all_traffic();
    for node in app.db.nodes()? {
        if node.traffic_limit <= 0 {
            continue;
        }
        let Some(current) = traffic.get(&node.id) else { continue };
        let used = traffic_used(&node.traffic_mode, current.month_rx, current.month_tx);
        if used <= 0 {
            continue;
        }
        let percent = used as f64 / node.traffic_limit as f64 * 100.0;
        let Some(bucket) = traffic_bucket(percent, start_percent) else { continue };
        let period = current.month_start.clone();
        let item = TrafficItem {
            name: display_name(&node),
            used,
            limit: node.traffic_limit,
            percent,
            bucket,
            mode: node.traffic_mode.clone(),
            period,
            start_percent,
        };
        let payload = serde_json::to_string(&item)?;
        let id = format!("traffic:{}:{}:{}", node.id, item.period, bucket);
        app.db.enqueue_common_event(
            &id,
            "traffic",
            Some(node.id),
            &item.period,
            bucket,
            &payload,
            Utc::now().timestamp(),
        )?;
    }
    Ok(())
}

fn traffic_used(mode: &str, month_rx: i64, month_tx: i64) -> i64 {
    match mode {
        "max" => month_rx.max(month_tx),
        "up" => month_tx,
        "down" => month_rx,
        _ => month_rx.saturating_add(month_tx),
    }
    .max(0)
}

fn display_name(node: &Node) -> String {
    let name: String = node.name.chars().filter(|character| !character.is_control()).take(128).collect();
    if name.trim().is_empty() {
        "未命名节点".to_owned()
    } else {
        name
    }
}

async fn deliver(manager: CommonNotificationManager, app: Shared, event: PlannedEvent, generation: u64) {
    if !manager.is_current(generation) {
        return;
    }
    let cfg = config(&app);
    if !event_allowed(cfg, &event.kind) {
        complete_event(&manager, &app, &event.id, generation).await;
        return;
    }

    if event.kind == "traffic" {
        match tokio::task::block_in_place(|| traffic_event_is_current(&app, &event)) {
            Ok(true) => {}
            Ok(false) => {
                discard_event(&manager, &app, &event.id, generation);
                return;
            }
            Err(error) => {
                warn!(event_id = %event.id, "validating common traffic notification failed: {error:#}");
                release_event(&manager, &app, &event.id, generation);
                return;
            }
        }
    }

    let text = match event_message(&app, &event).await {
        Ok(Some(text)) => text,
        Ok(None) => {
            complete_event(&manager, &app, &event.id, generation).await;
            return;
        }
        Err(error) => {
            warn!(event_id = %event.id, "building common notification failed: {error:#}");
            release_event(&manager, &app, &event.id, generation);
            return;
        }
    };

    if !manager.is_current(generation) {
        return;
    }
    if !event_allowed(config(&app), &event.kind) {
        complete_event(&manager, &app, &event.id, generation).await;
        return;
    }
    if event.kind == "traffic" {
        match tokio::task::block_in_place(|| traffic_event_is_current(&app, &event)) {
            Ok(true) => {}
            Ok(false) => {
                discard_event(&manager, &app, &event.id, generation);
                return;
            }
            Err(error) => {
                warn!(event_id = %event.id, "revalidating common traffic notification failed: {error:#}");
                release_event(&manager, &app, &event.id, generation);
                return;
            }
        }
    }
    match crate::api::send_telegram_message(&app, &text).await {
        Ok(()) => {
            if manager.is_current(generation) {
                complete_event(&manager, &app, &event.id, generation).await;
            }
        }
        Err(error) => {
            let outcome = if manager.is_current(generation) {
                tokio::task::block_in_place(|| {
                    app.db.record_common_event_failure(
                        &event.id,
                        Utc::now().timestamp(),
                        error,
                        &TELEGRAM_RETRY_DELAYS_SECONDS,
                    )
                })
            } else {
                return;
            };
            match outcome {
                Ok(Some(DeliveryFailure::Retry { failure_count, retry_at })) => {
                    warn!(
                        event_id = %event.id,
                        kind = %event.kind,
                        node_id = ?event.node_id,
                        failure_count,
                        max_attempts = TELEGRAM_TOTAL_ATTEMPTS,
                        retry_at,
                        "common notification send failed: {error}; retry scheduled"
                    );
                    manager.schedule_run(app, generation, retry_at);
                }
                Ok(Some(DeliveryFailure::Abandoned { failure_count })) => warn!(
                    event_id = %event.id,
                    kind = %event.kind,
                    node_id = ?event.node_id,
                    failure_count,
                    max_attempts = TELEGRAM_TOTAL_ATTEMPTS,
                    "common notification marked failed and abandoned after retry limit: {error}"
                ),
                Ok(None) => debug!(event_id = %event.id, "stale common notification failure was ignored"),
                Err(store_error) => warn!(
                    event_id = %event.id,
                    kind = %event.kind,
                    node_id = ?event.node_id,
                    "recording common notification failure failed: {store_error:#}; send error: {error}"
                ),
            }
        }
    }
}

fn traffic_event_is_current(app: &App, event: &PlannedEvent) -> Result<bool> {
    let item: TrafficItem = serde_json::from_str(&event.payload)?;
    let Some(node_id) = event.node_id else { return Ok(false) };
    let Some(node) = app.db.node(node_id)? else { return Ok(false) };
    let cfg = config(app);
    if node.traffic_limit <= 0
        || node.traffic_limit != item.limit
        || node.traffic_mode != item.mode
        || item.start_percent != cfg.traffic_start_percent
        || event.period_key != item.period
    {
        return Ok(false);
    }
    let mut traffic = app.db.all_traffic();
    let Some(current) = traffic.remove(&node_id) else { return Ok(false) };
    if current.month_start != event.period_key {
        return Ok(false);
    }
    let used = traffic_used(&node.traffic_mode, current.month_rx, current.month_tx);
    if used <= 0 {
        return Ok(false);
    }
    let percent = used as f64 / node.traffic_limit as f64 * 100.0;
    let Some(bucket) = traffic_bucket(percent, cfg.traffic_start_percent) else { return Ok(false) };
    Ok(item.start_percent == cfg.traffic_start_percent
        && item.bucket == event.bucket
        && bucket >= event.bucket)
}

async fn event_message(app: &Shared, event: &PlannedEvent) -> Result<Option<String>> {
    match event.kind.as_str() {
        "renew" => {
            let Some(node_id) = event.node_id else { return Ok(None) };
            let node = tokio::task::block_in_place(|| app.db.node(node_id))?;
            let Some(node) = node else { return Ok(None) };
            Ok(Some(renew_message(&display_name(&node), &event.period_key)))
        }
        "expiry" => {
            let items: Vec<ExpiryItem> = serde_json::from_str(&event.payload)?;
            Ok(Some(expiry_message(&items)))
        }
        "traffic" => {
            let item: TrafficItem = serde_json::from_str(&event.payload)?;
            Ok(Some(traffic_message(&item)))
        }
        "login" => {
            let item: LoginItem = serde_json::from_str(&event.payload)?;
            Ok(Some(login_message(&item)))
        }
        _ => Ok(None),
    }
}

fn escape_html(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn time_text() -> String {
    beijing_now().format("%Y-%m-%d %H:%M:%S (UTC+8)").to_string()
}

fn renew_message(name: &str, date: &str) -> String {
    format!(
        "⏰ <b>服务已自动续费</b>\n\n服务器：<b>{}</b>\n\n信息：有效期顺延至 <b>{}</b>\n\n时间：{}",
        escape_html(name),
        escape_html(date),
        time_text(),
    )
}

fn expiry_message(items: &[ExpiryItem]) -> String {
    let information = items
        .iter()
        .map(|item| format!("• {} ({}天)", escape_html(&item.name), item.days))
        .collect::<Vec<_>>()
        .join("\n");
    format!("🚨 <b>服务到期提醒</b>\n\n信息：\n\n{information}\n\n时间：{}", time_text())
}

fn mode_text(mode: &str) -> &'static str {
    match mode {
        "max" => "上下行取较大值",
        "up" => "仅上行",
        "down" => "仅下行",
        _ => "上下行相加",
    }
}

fn format_bytes(value: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut number = value.max(0) as f64;
    let mut index = 0;
    while number >= 1024.0 && index < UNITS.len() - 1 {
        number /= 1024.0;
        index += 1;
    }
    if index == 0 {
        format!("{} {}", number as i64, UNITS[index])
    } else {
        format!("{number:.2} {}", UNITS[index])
    }
}

fn traffic_message(item: &TrafficItem) -> String {
    format!(
        "🚥 <b>流量用量</b>\n\n服务器：<b>{}</b>\n\n信息：\n• 当前用量：<b>{}</b>\n• 有效额度：<b>{}</b>\n• 使用比例：<b>{:.2}%</b>\n• 本次提醒：达到 <b>{}%</b>\n• 统计方式：{}\n• 当前计费周期：<b>{}</b> 起\n\n时间：{}",
        escape_html(&item.name),
        format_bytes(item.used),
        format_bytes(item.limit),
        item.percent,
        item.bucket,
        mode_text(&item.mode),
        escape_html(&item.period),
        time_text(),
    )
}

fn login_message(item: &LoginItem) -> String {
    let ip = if item.ip.trim().is_empty() { "未知" } else { item.ip.trim() };
    let method = match item.auth_method {
        ref method if method == "github" => "GitHub",
        ref method if method == "password" => "应急密码",
        _ => "其它方式",
    };
    format!(
        "🚥 <b>后台登录提醒</b>\n\n登录IP：<b>{}</b>\n登录方式：<b>{method}</b>\n\n时间：{}",
        escape_html(ip),
        time_text(),
    )
}

fn release_event(manager: &CommonNotificationManager, app: &Shared, id: &str, generation: u64) {
    if !manager.is_current(generation) {
        return;
    }
    if let Err(error) = tokio::task::block_in_place(|| app.db.release_common_event(id)) {
        warn!(event_id = %id, "releasing common notification claim failed: {error:#}");
    }
}

fn discard_event(manager: &CommonNotificationManager, app: &Shared, id: &str, generation: u64) {
    if !manager.is_current(generation) {
        return;
    }
    if let Err(error) = tokio::task::block_in_place(|| app.db.delete_common_event(id)) {
        warn!(event_id = %id, "discarding stale common notification event failed: {error:#}");
        release_event(manager, app, id, generation);
    }
}

async fn complete_event(manager: &CommonNotificationManager, app: &Shared, id: &str, generation: u64) {
    for attempt in 0..3 {
        if !manager.is_current(generation) {
            return;
        }
        match tokio::task::block_in_place(|| app.db.complete_common_event(id, Utc::now().timestamp())) {
            Ok(()) => return,
            Err(error) if attempt < 2 => {
                debug!(event_id = %id, attempt = attempt + 1, "completing common notification event failed; retrying: {error:#}");
                tokio::time::sleep(Duration::from_millis(50 * (attempt + 1))).await;
            }
            Err(error) => {
                warn!(event_id = %id, "completing common notification event failed after retries: {error:#}");
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traffic_modes_and_five_percent_buckets_are_stable() {
        assert_eq!(traffic_used("sum", 7, 5), 12);
        assert_eq!(traffic_used("max", 7, 5), 7);
        assert_eq!(traffic_used("up", 7, 5), 5);
        assert_eq!(traffic_used("down", 7, 5), 7);
        assert_eq!(traffic_bucket(4.99, 5), None);
        assert_eq!(traffic_bucket(5.0, 5), Some(5));
        assert_eq!(traffic_bucket(79.99, 80), None);
        assert_eq!(traffic_bucket(80.0, 80), Some(80));
        assert_eq!(traffic_bucket(83.0, 83), Some(83));
        assert_eq!(traffic_bucket(84.0, 83), Some(83));
        assert_eq!(traffic_bucket(85.0, 83), Some(85));
        assert_eq!(traffic_bucket(0.0, 0), None);
        assert_eq!(traffic_bucket(103.0, 80), Some(100));
    }

    #[test]
    fn templates_use_beijing_time_and_escape_operator_text() {
        let renew = renew_message("a<b", "2026-09-25");
        assert!(renew.contains("a&lt;b"));
        assert!(renew.contains("UTC+8"));
        let expiry = expiry_message(&[ExpiryItem { name: "node".into(), days: 5 }]);
        assert!(expiry.contains("(5天)"));
        let login = login_message(&LoginItem { ip: "127.0.0.1".into(), auth_method: "password".into() });
        assert!(login.contains("登录IP"));
        assert!(login.contains("UTC+8"));
    }
}

#[cfg(test)]
mod scheduler_tests {
    use chrono::Days;

    use super::*;
    use crate::db::{Db, Node, NodePatch, TrafficPatch};

    fn app() -> App {
        App::for_test(Db::open(":memory:").unwrap())
    }

    fn enable(app: &App, key: &str) {
        app.db.set("notification_enabled", "on").unwrap();
        app.db.set(key, "on").unwrap();
    }

    #[test]
    fn expiry_is_filtered_by_beijing_date_and_claimed_once_until_released() {
        let app = app();
        enable(&app, EXPIRY_ENABLED_KEY);
        let expiry = beijing_today().checked_add_days(Days::new(5)).unwrap().to_string();
        app.db
            .create_node(
                &Node { name: "acck".into(), expires_at: Some(expiry), ..Node::default() },
                "expiry-token",
            )
            .unwrap();
        app.db
            .create_node(
                &Node { name: "unlimited".into(), expires_at: None, ..Node::default() },
                "unlimited-token",
            )
            .unwrap();

        let events = prepare_events(&app).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "expiry");
        assert!(events[0].payload.contains("\"days\":5"));
        assert!(prepare_events(&app).unwrap().is_empty(), "a live claim must suppress duplicate sends");

        app.db.release_common_event(&events[0].id).unwrap();
        assert_eq!(prepare_events(&app).unwrap().len(), 1, "a failed delivery is retryable");
    }

    #[test]
    fn expiry_events_are_split_below_telegram_limit() {
        let app = app();
        enable(&app, EXPIRY_ENABLED_KEY);
        let expiry = beijing_today().checked_add_days(Days::new(5)).unwrap().to_string();
        for index in 0..70 {
            app.db
                .create_node(
                    &Node {
                        name: format!("node-{index}-{}", "x".repeat(120)),
                        expires_at: Some(expiry.clone()),
                        ..Node::default()
                    },
                    &format!("expiry-token-{index}"),
                )
                .unwrap();
        }

        let events = prepare_events(&app).unwrap();
        assert!(events.len() > 1, "a large expiry list must become multiple events");
        let mut total = 0;
        for event in events {
            let items: Vec<ExpiryItem> = serde_json::from_str(&event.payload).unwrap();
            total += items.len();
            assert!(expiry_message(&items).chars().count() <= MAX_EXPIRY_MESSAGE_CHARS);
        }
        assert_eq!(total, 70);
    }

    #[test]
    fn pending_traffic_event_is_invalid_when_current_configuration_changes() {
        let app = app();
        enable(&app, TRAFFIC_ENABLED_KEY);
        app.db.set(TRAFFIC_START_PERCENT_KEY, "5").unwrap();
        let id = app
            .db
            .create_node(
                &Node {
                    name: "metered".into(),
                    traffic_limit: 100,
                    traffic_mode: "sum".into(),
                    ..Node::default()
                },
                "traffic-config-token",
            )
            .unwrap();
        app.db.set_traffic(id, &TrafficPatch { month_rx: Some(5), ..TrafficPatch::default() }).unwrap();
        let events = prepare_events(&app).unwrap();
        assert_eq!(events.len(), 1);

        app.db.update_node(id, &NodePatch { traffic_limit: Some(0), ..NodePatch::default() }).unwrap();
        assert!(!traffic_event_is_current(&app, &events[0]).unwrap());
    }

    #[test]
    fn traffic_start_percent_controls_first_bucket_and_zero_disables_reminders() {
        let app = app();
        enable(&app, TRAFFIC_ENABLED_KEY);
        app.db.set(TRAFFIC_START_PERCENT_KEY, "80").unwrap();
        let id = app
            .db
            .create_node(
                &Node {
                    name: "thresholded".into(),
                    traffic_limit: 100,
                    traffic_mode: "sum".into(),
                    ..Node::default()
                },
                "traffic-threshold-token",
            )
            .unwrap();

        app.db.set_traffic(id, &TrafficPatch { month_rx: Some(79), ..TrafficPatch::default() }).unwrap();
        assert!(prepare_events(&app).unwrap().is_empty());

        app.db.set_traffic(id, &TrafficPatch { month_rx: Some(80), ..TrafficPatch::default() }).unwrap();
        let first = prepare_events(&app).unwrap();
        assert_eq!(first.len(), 1);
        let first_item: TrafficItem = serde_json::from_str(&first[0].payload).unwrap();
        assert_eq!(first_item.bucket, 80);
        assert_eq!(first_item.start_percent, 80);
        app.db.complete_common_event(&first[0].id, Utc::now().timestamp()).unwrap();

        app.db.set(TRAFFIC_START_PERCENT_KEY, "0").unwrap();
        app.db.set_traffic(id, &TrafficPatch { month_rx: Some(90), ..TrafficPatch::default() }).unwrap();
        assert!(prepare_events(&app).unwrap().is_empty());
    }

    #[test]
    fn traffic_uses_the_current_period_and_each_five_percent_bucket_once() {
        let app = app();
        enable(&app, TRAFFIC_ENABLED_KEY);
        app.db.set(TRAFFIC_START_PERCENT_KEY, "5").unwrap();
        let id = app
            .db
            .create_node(
                &Node {
                    name: "metered".into(),
                    traffic_limit: 100,
                    traffic_mode: "sum".into(),
                    ..Node::default()
                },
                "traffic-token",
            )
            .unwrap();
        app.db.set_traffic(id, &TrafficPatch { month_rx: Some(5), ..TrafficPatch::default() }).unwrap();
        let first = prepare_events(&app).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].kind, "traffic");
        let first_item: TrafficItem = serde_json::from_str(&first[0].payload).unwrap();
        assert_eq!(first_item.bucket, 5);
        app.db.complete_common_event(&first[0].id, Utc::now().timestamp()).unwrap();

        app.db.set_traffic(id, &TrafficPatch { month_rx: Some(10), ..TrafficPatch::default() }).unwrap();
        let second = prepare_events(&app).unwrap();
        assert_eq!(second.len(), 1);
        let second_item: TrafficItem = serde_json::from_str(&second[0].payload).unwrap();
        assert_eq!(second_item.bucket, 10);
        app.db.complete_common_event(&second[0].id, Utc::now().timestamp()).unwrap();

        app.db.set_traffic(id, &TrafficPatch { month_rx: Some(10), ..TrafficPatch::default() }).unwrap();
        assert!(prepare_events(&app).unwrap().is_empty(), "the same bucket must not repeat");
    }
}

#[cfg(test)]
mod expiry_check_tests {
    use chrono::{TimeZone, Utc};

    use super::*;
    use crate::db::{Db, Node};

    fn app() -> App {
        App::for_test(Db::open(":memory:").unwrap())
    }

    fn enable_expiry(app: &App) {
        app.db.set("notification_enabled", "on").unwrap();
        app.db.set(EXPIRY_ENABLED_KEY, "on").unwrap();
    }

    #[test]
    fn expiry_check_time_accepts_hh_mm_and_rejects_invalid_values() {
        assert_eq!(parse_expiry_check_time("00:00"), Some(0));
        assert_eq!(parse_expiry_check_time("09:30"), Some(570));
        assert_eq!(parse_expiry_check_time("23:59"), Some(1_439));
        assert_eq!(format_expiry_check_time(570), "09:30");
        for value in ["24:00", "12:60", "9:30", "12:6", "12:60:00"] {
            assert_eq!(parse_expiry_check_time(value), None, "invalid time: {value}");
        }
    }

    #[test]
    fn expiry_check_uses_the_utc_plus_eight_minute_boundary() {
        let before =
            Utc.with_ymd_and_hms(2026, 9, 9, 1, 29, 59).single().unwrap().with_timezone(&beijing_offset());
        let at_check_time =
            Utc.with_ymd_and_hms(2026, 9, 9, 1, 30, 0).single().unwrap().with_timezone(&beijing_offset());

        assert!(!expiry_check_is_due(before, 9 * 60 + 30));
        assert!(expiry_check_is_due(at_check_time, 9 * 60 + 30));
    }

    #[test]
    fn expiry_daily_marker_prevents_recreating_completed_events() {
        let app = app();
        enable_expiry(&app);
        let today_key = beijing_today().to_string();
        let expiry = beijing_today().checked_add_days(chrono::Days::new(1)).unwrap().to_string();
        app.db
            .create_node(
                &Node { name: "expiring".into(), expires_at: Some(expiry), ..Node::default() },
                "expiry-marker-token",
            )
            .unwrap();

        let events = prepare_events(&app).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(app.db.get(EXPIRY_LAST_CHECK_DATE_KEY).as_deref(), Some(today_key.as_str()));
        app.db.complete_common_event(&events[0].id, Utc::now().timestamp()).unwrap();

        assert!(prepare_events(&app).unwrap().is_empty());
    }
}
