//! Offline and recovery notification state machine.
//!
//! Connection state is kept separately from the agent map so timers never hold
//! the agent lock while they touch SQLite or wait for Telegram. SQLite keeps
//! the durable "confirmed offline" transition; the in-memory generation only
//! invalidates timers left behind by an old connection.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{FixedOffset, Utc};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use crate::db::DeliveryFailure;
use crate::Shared;

pub(crate) const TELEGRAM_RETRY_DELAYS_SECONDS: [i64; 2] = [60, 120];
pub(crate) const TELEGRAM_TOTAL_ATTEMPTS: i64 = TELEGRAM_RETRY_DELAYS_SECONDS.len() as i64 + 1;

#[derive(Clone, Default)]
pub struct NotificationManager {
    states: Arc<Mutex<HashMap<i64, ConnectionState>>>,
}

#[derive(Debug, Default)]
struct ConnectionState {
    generation: u64,
    session: Option<u64>,
    /// Session IDs are process-global and monotonic. Retaining the last one
    /// prevents an older handshake from moving notification state backwards.
    last_session: Option<u64>,
    /// Changes whenever an exclusion setting is saved for this node. Unlike
    /// the connection generation, this value stays advanced after an
    /// exclusion is removed so an old queued event cannot be replayed.
    filter_generation: u64,
    delivery: Option<mpsc::UnboundedSender<Event>>,
    offline_queued: bool,
}

#[derive(Clone, Copy, Debug)]
struct Event {
    kind: EventKind,
    filter_generation: u64,
    failure_count: i64,
    connection_generation: Option<u64>,
}

#[derive(Clone, Copy, Debug)]
enum EventKind {
    Offline,
    Online,
}

impl Event {
    fn offline(filter_generation: u64) -> Self {
        Self { kind: EventKind::Offline, filter_generation, failure_count: 0, connection_generation: None }
    }

    fn online(filter_generation: u64, connection_generation: u64) -> Self {
        Self {
            kind: EventKind::Online,
            filter_generation,
            failure_count: 0,
            connection_generation: Some(connection_generation),
        }
    }

    fn label(self) -> &'static str {
        match self.kind {
            EventKind::Offline => "离线",
            EventKind::Online => "上线",
        }
    }

    fn emoji(self) -> &'static str {
        match self.kind {
            EventKind::Offline => "🔴",
            EventKind::Online => "🟢",
        }
    }
}

impl NotificationManager {
    /// Retries confirmed outages whose Telegram delivery has not succeeded.
    /// The durable bit is the source of truth, so a hub restart cannot lose a
    /// failed notification and a reconnect can cancel it safely.
    pub fn start(&self, app: Shared) {
        let manager = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(60));
            tick.tick().await;
            loop {
                tick.tick().await;
                manager.retry_undelivered(app.clone()).await;
            }
        });
    }

    /// Schedules pending offline transitions found before the hub was started.
    /// This is called before the listener accepts any agent connection, so a
    /// newly connected session can invalidate one of these generations safely.
    pub async fn resume_pending(&self, app: Shared) {
        let pending = match tokio::task::spawn_blocking({
            let app = app.clone();
            move || app.db.pending_notification_states()
        })
        .await
        {
            Ok(Ok(pending)) => pending,
            Ok(Err(error)) => {
                warn!("loading pending notification states failed: {error:#}");
                return;
            }
            Err(error) => {
                warn!("loading pending notification states task failed: {error:#}");
                return;
            }
        };
        let config = match tokio::task::spawn_blocking({
            let app = app.clone();
            move || crate::api::notification_config(&app)
        })
        .await
        {
            Ok(config) => config,
            Err(error) => {
                warn!("loading notification configuration task failed: {error:#}");
                return;
            }
        };
        for pending in pending {
            let node_id = pending.node_id;
            if config.excluded_node_ids.contains(&node_id) || !config.enabled || !config.offline_enabled {
                let result = tokio::task::spawn_blocking({
                    let app = app.clone();
                    move || app.db.take_notification_offline(node_id).map(|_| ())
                })
                .await;
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        warn!("node {node_id}: clearing excluded pending state failed: {error:#}")
                    }
                    Err(error) => {
                        warn!("node {node_id}: clearing excluded pending state task failed: {error:#}")
                    }
                }
                continue;
            }
            let generation = self.set_disconnected(node_id);
            if pending.offline_confirmed && !pending.offline_notified && !pending.offline_failed {
                let event = Event::offline(self.filter_generation(node_id));
                let retry_at = pending.offline_next_retry_at.unwrap_or_else(|| Utc::now().timestamp());
                self.schedule_event(app.clone(), node_id, event, retry_at);
            } else if let Some(pending_since) = pending.pending_since {
                self.schedule_offline(
                    app.clone(),
                    node_id,
                    generation,
                    pending_since,
                    config.offline_delay_seconds,
                );
            }
        }
    }

    async fn retry_undelivered(&self, app: Shared) {
        let pending = match tokio::task::spawn_blocking({
            let app = app.clone();
            move || app.db.pending_notification_states()
        })
        .await
        {
            Ok(Ok(pending)) => pending,
            Ok(Err(error)) => {
                warn!("loading undelivered offline notifications failed: {error:#}");
                return;
            }
            Err(error) => {
                warn!("loading undelivered offline notifications task failed: {error:#}");
                return;
            }
        };
        let config = tokio::task::block_in_place(|| crate::api::notification_config(&app));
        for pending in pending {
            let node_id = pending.node_id;
            if !pending.offline_confirmed || pending.offline_notified || pending.offline_failed {
                continue;
            }
            if config.excluded_node_ids.contains(&node_id) || !config.enabled || !config.offline_enabled {
                let _ = tokio::task::block_in_place(|| app.db.take_notification_offline(node_id));
                continue;
            }
            if pending.offline_next_retry_at.is_some_and(|retry_at| retry_at <= Utc::now().timestamp()) {
                self.queue_event(&app, node_id, Event::offline(self.filter_generation(node_id)));
            }
        }
    }

    /// Applies channel and exclusion changes to work that is already queued.
    /// Disabling global/offline delivery also drops durable outage transitions
    /// so turning the switch back on cannot replay an event from the disabled
    /// period.
    pub fn refresh_settings(&self, app: Shared, excluded_node_ids: &HashSet<i64>) {
        let config = tokio::task::block_in_place(|| crate::api::notification_config(&app));
        let mut states = self.states.lock().unwrap_or_else(|error| error.into_inner());
        if !config.enabled || !config.offline_enabled {
            for state in states.values_mut() {
                state.generation = state.generation.wrapping_add(1);
                state.filter_generation = state.filter_generation.wrapping_add(1);
            }
            if let Err(error) = tokio::task::block_in_place(|| app.db.clear_notification_states()) {
                warn!("clearing disabled notification states failed: {error:#}");
            }
        } else if !config.online_enabled {
            for state in states.values_mut() {
                state.filter_generation = state.filter_generation.wrapping_add(1);
            }
        }
        for &node_id in excluded_node_ids {
            let state = states.entry(node_id).or_default();
            state.generation = state.generation.wrapping_add(1);
            state.filter_generation = state.filter_generation.wrapping_add(1);
            if let Err(error) = tokio::task::block_in_place(|| app.db.take_notification_offline(node_id)) {
                warn!("node {node_id}: clearing excluded notification state failed: {error:#}");
            }
        }
    }

    /// Invalidates lifecycle and queued-delivery work for one administrative
    /// node teardown without touching the real agent map or its database row.
    pub fn invalidate_node(&self, node_id: i64) {
        let mut states = self.states.lock().unwrap_or_else(|error| error.into_inner());
        let state = states.entry(node_id).or_default();
        state.generation = state.generation.wrapping_add(1);
        state.filter_generation = state.filter_generation.wrapping_add(1);
        state.session = None;
    }

    /// Invalidates all in-memory work before a database restore, after which
    /// pending rows from the restored database are scheduled again.
    pub fn invalidate_all(&self) {
        let mut states = self.states.lock().unwrap_or_else(|error| error.into_inner());
        for state in states.values_mut() {
            state.generation = state.generation.wrapping_add(1);
            state.filter_generation = state.filter_generation.wrapping_add(1);
            state.session = None;
        }
    }

    /// Records a new connection before it is exposed in the agent map. The
    /// durable transition is cleared even when the online event is turned off,
    /// so a disabled channel cannot emit a stale recovery notification much
    /// later when it is enabled again.
    pub fn connected(&self, app: Shared, node_id: i64, session: u64) -> bool {
        let config = tokio::task::block_in_place(|| crate::api::notification_config(&app));
        let mut states = self.states.lock().unwrap_or_else(|error| error.into_inner());
        let state = states.entry(node_id).or_default();
        if state.last_session.is_some_and(|last| session < last) {
            return false;
        }
        state.last_session = Some(session);
        state.generation = state.generation.wrapping_add(1);
        state.session = Some(session);
        let (was_offline, _offline_notified, _offline_failed) =
            match tokio::task::block_in_place(|| app.db.take_notification_offline(node_id)) {
                Ok(state) => state,
                Err(error) => {
                    warn!("node {node_id}: clearing offline notification state failed: {error:#}");
                    // Keep the new session current. A database error must not make
                    // a healthy agent look stale to the connection map.
                    return true;
                }
            };
        if was_offline
            && !config.excluded_node_ids.contains(&node_id)
            && config.enabled
            && config.online_enabled
        {
            let filter_generation = state.filter_generation;
            let event = Event::online(filter_generation, state.generation);
            let sender = self.delivery_sender(&app, node_id, state);
            if sender.send(event).is_err() {
                warn!("node {node_id}: online notification queue is closed");
            }
        }
        true
    }

    /// Records a successfully released connection and starts its grace timer.
    /// The session check happens before this method is called in `agent_ws`,
    /// while this second check closes the race with a newer connection arriving
    /// between `release` and the database write.
    pub fn disconnected(&self, app: Shared, node_id: i64, session: u64) {
        let config = tokio::task::block_in_place(|| crate::api::notification_config(&app));
        let mut states = self.states.lock().unwrap_or_else(|error| error.into_inner());
        let state = states.entry(node_id).or_default();
        if state.session != Some(session) {
            return;
        }
        state.generation = state.generation.wrapping_add(1);
        state.session = None;
        let generation = state.generation;

        if config.excluded_node_ids.contains(&node_id) {
            // Exclusions clear both pending and confirmed state. A later
            // removal of the exclusion must not replay this old transition.
            let _ = tokio::task::block_in_place(|| app.db.take_notification_offline(node_id));
            return;
        }

        if !config.enabled || !config.offline_enabled {
            // No pending transition is created while this event is disabled.
            let _ = tokio::task::block_in_place(|| app.db.discard_notification_pending(node_id, None));
            return;
        }

        let pending_since = Utc::now().timestamp();
        match tokio::task::block_in_place(|| app.db.mark_notification_pending(node_id, pending_since)) {
            Ok(true) => {
                self.schedule_offline(app, node_id, generation, pending_since, config.offline_delay_seconds)
            }
            Ok(false) => debug!("node {node_id}: offline notification is already confirmed"),
            Err(error) => warn!("node {node_id}: storing offline notification state failed: {error:#}"),
        }
    }

    fn set_disconnected(&self, node_id: i64) -> u64 {
        let mut states = self.states.lock().unwrap_or_else(|error| error.into_inner());
        let state = states.entry(node_id).or_default();
        state.generation = state.generation.wrapping_add(1);
        state.session = None;
        state.generation
    }

    fn filter_generation(&self, node_id: i64) -> u64 {
        let states = self.states.lock().unwrap_or_else(|error| error.into_inner());
        states.get(&node_id).map_or(0, |state| state.filter_generation)
    }

    fn queue_event(&self, app: &Shared, node_id: i64, event: Event) {
        let mut states = self.states.lock().unwrap_or_else(|error| error.into_inner());
        let state = states.entry(node_id).or_default();
        if matches!(event.kind, EventKind::Offline) && state.offline_queued {
            return;
        }
        let sender = self.delivery_sender(app, node_id, state);
        if matches!(event.kind, EventKind::Offline) {
            state.offline_queued = true;
        }
        if sender.send(event).is_err() {
            if matches!(event.kind, EventKind::Offline) {
                state.offline_queued = false;
            }
            warn!("node {node_id}: {} notification queue is closed", event.label());
        }
    }

    fn delivery_sender(
        &self,
        app: &Shared,
        node_id: i64,
        state: &mut ConnectionState,
    ) -> mpsc::UnboundedSender<Event> {
        if let Some(sender) = &state.delivery {
            return sender.clone();
        }
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let worker_app = app.clone();
        let manager = self.clone();
        tokio::spawn(async move {
            while let Some(event) = receiver.recv().await {
                Self::send_event(manager.clone(), worker_app.clone(), node_id, event).await;
                if matches!(event.kind, EventKind::Offline) {
                    let mut states = manager.states.lock().unwrap_or_else(|error| error.into_inner());
                    if let Some(state) = states.get_mut(&node_id) {
                        state.offline_queued = false;
                    }
                }
            }
        });
        state.delivery = Some(sender.clone());
        sender
    }

    fn schedule_offline(&self, app: Shared, node_id: i64, generation: u64, pending_since: i64, delay: i64) {
        let manager = self.clone();
        tokio::spawn(async move {
            let elapsed = Utc::now().timestamp().saturating_sub(pending_since).max(0);
            let wait = delay.saturating_sub(elapsed) as u64;
            if wait > 0 {
                tokio::time::sleep(Duration::from_secs(wait)).await;
            }
            manager.offline_due(app, node_id, generation, pending_since).await;
        });
    }

    fn schedule_event(&self, app: Shared, node_id: i64, event: Event, retry_at: i64) {
        let manager = self.clone();
        tokio::spawn(async move {
            let wait = retry_at.saturating_sub(Utc::now().timestamp()).max(0) as u64;
            if wait > 0 {
                tokio::time::sleep(Duration::from_secs(wait)).await;
            }
            manager.queue_event(&app, node_id, event);
        });
    }

    async fn offline_due(&self, app: Shared, node_id: i64, generation: u64, pending_since: i64) {
        // Keep the notification state lock through the live-agent check and
        // the conditional SQLite claim. New connections establish their
        // generation before entering `agents`, so they cannot appear in this
        // interval without first invalidating this timer.
        let _ = {
            let mut states = self.states.lock().unwrap_or_else(|error| error.into_inner());
            let Some(state) = states.get_mut(&node_id) else { return };
            if state.generation != generation || state.session.is_some() {
                return;
            }

            if app.agents.read().unwrap_or_else(|error| error.into_inner()).contains_key(&node_id) {
                let _ = tokio::task::block_in_place(|| {
                    app.db.discard_notification_pending(node_id, Some(pending_since))
                });
                false
            } else {
                let config = tokio::task::block_in_place(|| crate::api::notification_config(&app));
                if config.excluded_node_ids.contains(&node_id) || !config.enabled || !config.offline_enabled {
                    let _ = tokio::task::block_in_place(|| {
                        app.db.discard_notification_pending(node_id, Some(pending_since))
                    });
                    false
                } else {
                    // Claim the transition before the HTTP request. This
                    // makes a timer retry, a process race, or a repeated
                    // teardown unable to send twice.
                    match tokio::task::block_in_place(|| {
                        app.db.confirm_notification_offline(node_id, pending_since)
                    }) {
                        Ok(true) => {
                            let filter_generation = state.filter_generation;
                            let sender = self.delivery_sender(&app, node_id, state);
                            if sender.send(Event::offline(filter_generation)).is_err() {
                                warn!("node {node_id}: offline notification queue is closed");
                            }
                            true
                        }
                        Ok(false) => false,
                        Err(error) => {
                            warn!("node {node_id}: claiming offline notification state failed: {error:#}");
                            false
                        }
                    }
                }
            }
        };
    }

    fn event_current(&self, node_id: i64, event: Event) -> bool {
        let states = self.states.lock().unwrap_or_else(|error| error.into_inner());
        states.get(&node_id).is_some_and(|state| {
            state.filter_generation == event.filter_generation
                && event
                    .connection_generation
                    .is_none_or(|generation| state.generation == generation && state.session.is_some())
        })
    }

    fn event_allowed(app: &Shared, node_id: i64, event: Event) -> bool {
        let config = tokio::task::block_in_place(|| crate::api::notification_config(app));
        config.enabled
            && !config.excluded_node_ids.contains(&node_id)
            && match event.kind {
                EventKind::Offline => {
                    config.offline_enabled
                        && tokio::task::block_in_place(|| {
                            app.db.notification_offline_delivery_pending(node_id)
                        })
                }
                EventKind::Online => config.online_enabled,
            }
    }

    async fn send_event(manager: NotificationManager, app: Shared, node_id: i64, event: Event) {
        // A queued event can outlive a settings save. The filter generation
        // remains advanced even after an exclusion is removed, so old work
        // cannot be replayed as if it were a new disconnect.
        if !manager.event_current(node_id, event) || !Self::event_allowed(&app, node_id, event) {
            return;
        }
        let node = match tokio::task::block_in_place(|| app.db.node(node_id)) {
            Ok(node) => node,
            Err(error) => {
                warn!("node {node_id}: loading name for {} notification failed: {error:#}", event.label());
                return;
            }
        };
        let Some(node) = node else {
            // The node may have been deleted while a timer was waiting.
            return;
        };
        let text = event_message(event, &node.name);
        if !manager.event_current(node_id, event) || !Self::event_allowed(&app, node_id, event) {
            return;
        }
        match crate::api::send_telegram_message(&app, &text).await {
            Ok(()) => {
                if matches!(event.kind, EventKind::Offline) {
                    if let Err(error) =
                        tokio::task::block_in_place(|| app.db.mark_notification_offline_delivered(node_id))
                    {
                        warn!("node {node_id}: recording offline notification delivery failed: {error:#}");
                    }
                }
            }
            Err(error) => match event.kind {
                EventKind::Offline => {
                    let outcome = tokio::task::block_in_place(|| {
                        app.db.record_notification_offline_failure(
                            node_id,
                            Utc::now().timestamp(),
                            &TELEGRAM_RETRY_DELAYS_SECONDS,
                        )
                    });
                    match outcome {
                        Ok(Some(DeliveryFailure::Retry { failure_count, retry_at })) => {
                            warn!(
                                node_id,
                                node = %log_node_name(&node.name),
                                failure_count,
                                max_attempts = TELEGRAM_TOTAL_ATTEMPTS,
                                retry_at,
                                "offline notification send failed: {error}; retry scheduled"
                            );
                            manager.schedule_event(app, node_id, event, retry_at);
                        }
                        Ok(Some(DeliveryFailure::Abandoned { failure_count })) => {
                            warn!(
                                node_id,
                                node = %log_node_name(&node.name),
                                failure_count,
                                max_attempts = TELEGRAM_TOTAL_ATTEMPTS,
                                "offline notification marked failed and abandoned after retry limit: {error}"
                            );
                        }
                        Ok(None) => debug!(node_id, "stale offline notification failure was ignored"),
                        Err(store_error) => warn!(
                            node_id,
                            node = %log_node_name(&node.name),
                            "recording offline notification failure failed: {store_error:#}; send error: {error}"
                        ),
                    }
                }
                EventKind::Online => {
                    let failure_count = event.failure_count.saturating_add(1);
                    if let Some(delay) = TELEGRAM_RETRY_DELAYS_SECONDS.get((failure_count - 1) as usize) {
                        let retry_at = Utc::now().timestamp().saturating_add(*delay);
                        warn!(
                            node_id,
                            node = %log_node_name(&node.name),
                            failure_count,
                            max_attempts = TELEGRAM_TOTAL_ATTEMPTS,
                            retry_at,
                            "online notification send failed: {error}; retry scheduled"
                        );
                        let retry = Event { failure_count, ..event };
                        manager.schedule_event(app, node_id, retry, retry_at);
                    } else {
                        warn!(
                            node_id,
                            node = %log_node_name(&node.name),
                            failure_count,
                            max_attempts = TELEGRAM_TOTAL_ATTEMPTS,
                            "online notification marked failed and abandoned after retry limit: {error}"
                        );
                    }
                }
            },
        }
    }
}

fn event_message(event: Event, name: &str) -> String {
    let offset = FixedOffset::east_opt(8 * 3_600).expect("UTC+8 is a valid fixed offset");
    let time = Utc::now().with_timezone(&offset).format("%Y-%m-%d %H:%M:%S (UTC+8)");
    format!("{} {}通知\n服务器：{}\n时间：{time}", event.emoji(), event.label(), escape_node_name(name))
}

/// Node names are operator-controlled input but are sent with Telegram's HTML
/// parser enabled. Control characters are removed to keep the three-line
/// message shape, and HTML delimiters are escaped before the request leaves.
fn escape_node_name(name: &str) -> String {
    let name: String = name.chars().filter(|character| !character.is_control()).take(128).collect();
    let name = if name.trim().is_empty() { "未命名节点" } else { name.as_str() };
    name.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn log_node_name(name: &str) -> String {
    let name: String = name.chars().filter(|character| !character.is_control()).take(128).collect();
    if name.trim().is_empty() {
        "未命名节点".to_owned()
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delayed_online_retry_is_cancelled_by_the_next_disconnect() {
        let manager = NotificationManager::default();
        {
            let mut states = manager.states.lock().unwrap();
            let state = states.entry(7).or_default();
            state.generation = 3;
            state.session = Some(9);
        }
        let event = Event::online(0, 3);
        assert!(manager.event_current(7, event));

        {
            let mut states = manager.states.lock().unwrap();
            let state = states.get_mut(&7).unwrap();
            state.generation = 4;
            state.session = None;
        }
        assert!(!manager.event_current(7, event));
    }
}
