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

use crate::Shared;

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
}

#[derive(Clone, Copy, Debug)]
struct Event {
    kind: EventKind,
    filter_generation: u64,
}

#[derive(Clone, Copy, Debug)]
enum EventKind {
    Offline,
    Online,
}

impl Event {
    fn offline(filter_generation: u64) -> Self {
        Self { kind: EventKind::Offline, filter_generation }
    }

    fn online(filter_generation: u64) -> Self {
        Self { kind: EventKind::Online, filter_generation }
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
        for (node_id, pending_since) in pending {
            if config.excluded_node_ids.contains(&node_id) {
                let result = tokio::task::spawn_blocking({
                    let app = app.clone();
                    move || app.db.discard_notification_pending(node_id, Some(pending_since))
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
            self.schedule_offline(
                app.clone(),
                node_id,
                generation,
                pending_since,
                config.offline_delay_seconds,
            );
        }
    }

    /// Invalidates timers and durable transitions for every node that is now
    /// excluded. This deliberately does not synthesize a recovery or offline
    /// event: changing the filter only affects future disconnects.
    pub fn refresh_exclusions(&self, app: Shared, excluded_node_ids: &HashSet<i64>) {
        let mut states = self.states.lock().unwrap_or_else(|error| error.into_inner());
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
        let was_offline = match tokio::task::block_in_place(|| app.db.take_notification_offline(node_id)) {
            Ok(was_offline) => was_offline,
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
            let sender = self.delivery_sender(&app, node_id, state);
            if sender.send(Event::online(filter_generation)).is_err() {
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

    fn event_filter_current(&self, node_id: i64, filter_generation: u64) -> bool {
        let states = self.states.lock().unwrap_or_else(|error| error.into_inner());
        states.get(&node_id).is_some_and(|state| state.filter_generation == filter_generation)
    }

    async fn send_event(manager: NotificationManager, app: Shared, node_id: i64, event: Event) {
        // A queued event can outlive a settings save. The filter generation
        // remains advanced even after an exclusion is removed, so old work
        // cannot be replayed as if it were a new disconnect.
        if !manager.event_filter_current(node_id, event.filter_generation)
            || tokio::task::block_in_place(|| crate::api::notification_config(&app))
                .excluded_node_ids
                .contains(&node_id)
        {
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
        for attempt in 0..3 {
            if !manager.event_filter_current(node_id, event.filter_generation)
                || tokio::task::block_in_place(|| crate::api::notification_config(&app))
                    .excluded_node_ids
                    .contains(&node_id)
            {
                return;
            }
            match crate::api::send_telegram_message(&app, &text).await {
                Ok(()) => return,
                Err(error) if attempt < 2 => {
                    debug!(
                        "node {node_id}: {} notification attempt {} failed: {error}; retrying",
                        event.label(),
                        attempt + 1
                    );
                    tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
                }
                Err(error) => {
                    warn!("node {node_id}: {} notification failed: {error}", event.label());
                    return;
                }
            }
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
