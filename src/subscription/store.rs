use std::collections::HashSet;

use anyhow::Result;
use chrono::{NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

use super::{
    amount, clean, period_amount, supported_date, Action, Batch, Plan, Renewal, RenewalPreview, Target,
    MAX_SUBSCRIPTIONS,
};
use crate::db::{next_id, Db};

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS subscription (
    id INTEGER PRIMARY KEY,
    position INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    plan TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscription_renewal (
    id INTEGER PRIMARY KEY,
    subscription_id INTEGER NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
    paid_on TEXT NOT NULL,
    periods INTEGER NOT NULL,
    previous_due TEXT NOT NULL,
    next_due TEXT NOT NULL,
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subscription_renewal_item ON subscription_renewal(subscription_id, id DESC);
CREATE TABLE IF NOT EXISTS subscription_reminder (
    subscription_id INTEGER NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
    due_on TEXT NOT NULL,
    milestone INTEGER NOT NULL,
    channel TEXT NOT NULL,
    PRIMARY KEY (subscription_id, due_on, milestone, channel)
) WITHOUT ROWID;
"#;

#[derive(Serialize)]
pub(super) struct Entry {
    id: i64,
    revision: i64,
    #[serde(flatten)]
    plan: Plan,
}

#[derive(Serialize)]
pub(super) struct History {
    id: i64,
    paid_on: String,
    periods: u32,
    previous_due: String,
    next_due: String,
    amount: String,
    currency: String,
    recorded_at: i64,
}

pub(crate) struct Reminder {
    pub id: i64,
    pub name: String,
    pub due: NaiveDate,
    milestone: i64,
}

fn entry(row: &Row<'_>) -> rusqlite::Result<Entry> {
    let raw: String = row.get(2)?;
    let plan = serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(Entry { id: row.get(0)?, revision: row.get(1)?, plan })
}

fn entries(conn: &Connection) -> Result<Vec<Entry>> {
    let mut stmt = conn.prepare("SELECT id, revision, plan FROM subscription ORDER BY position, id")?;
    let rows = stmt.query_map([], entry)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn checked_entry(conn: &Connection, target: &Target) -> Result<Entry> {
    let row = conn
        .query_row("SELECT id, revision, plan FROM subscription WHERE id=?1", [target.id], entry)
        .optional()?;
    match row {
        Some(row) if row.revision == target.revision => Ok(row),
        _ => refuse!("订阅已更新或删除，请刷新页面后重试"),
    }
}

fn checked_selection<'a>(targets: impl IntoIterator<Item = &'a Target>) -> Result<()> {
    let mut ids = HashSet::new();
    for target in targets {
        if target.id <= 0 || target.revision <= 0 || !ids.insert(target.id) {
            refuse!("订阅选项无效或重复");
        }
    }
    if ids.is_empty() || ids.len() > 500 {
        refuse!("每次请选择 1 到 500 条订阅");
    }
    Ok(())
}

fn update(conn: &Connection, id: i64, plan: &Plan) -> Result<()> {
    conn.execute(
        "UPDATE subscription SET plan=?2, revision=revision+1 WHERE id=?1",
        params![id, serde_json::to_string(plan)?],
    )?;
    Ok(())
}

impl Db {
    pub(super) fn subscriptions(&self) -> Result<Vec<Entry>> {
        entries(&self.conn())
    }

    pub(super) fn create_subscription(&self, plan: &Plan) -> Result<i64> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let (count, position): (i64, i64) =
            tx.query_row("SELECT COUNT(*), COALESCE(MAX(position),0)+1 FROM subscription", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        if count >= MAX_SUBSCRIPTIONS as i64 {
            refuse!("最多保存 {MAX_SUBSCRIPTIONS} 条订阅");
        }
        let id = next_id(&tx, "subscription")?;
        tx.execute(
            "INSERT INTO subscription (id, position, plan) VALUES (?1,?2,?3)",
            params![id, position, serde_json::to_string(plan)?],
        )?;
        tx.commit()?;
        Ok(id)
    }

    pub(super) fn edit_subscription(&self, target: Target, plan: &Plan) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        checked_entry(&tx, &target)?;
        update(&tx, target.id, plan)?;
        tx.commit()?;
        Ok(())
    }

    pub(super) fn batch_subscriptions(&self, input: Batch) -> Result<()> {
        checked_selection(&input.items)?;
        let action = match input.action {
            Action::Category { category } => {
                Action::Category { category: clean(category, 50, "分类", false)? }
            }
            action => action,
        };
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for target in &input.items {
            let Entry { id, mut plan, .. } = checked_entry(&tx, target)?;
            match &action {
                Action::Delete => {
                    tx.execute("DELETE FROM subscription WHERE id=?1", [id])?;
                    continue;
                }
                Action::Enable => plan.enabled = true,
                Action::Disable => plan.enabled = false,
                Action::Category { category } => plan.category.clone_from(category),
            }
            update(&tx, id, &plan)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(super) fn order_subscriptions(&self, ids: &[i64], previous: &[i64]) -> Result<()> {
        if ids.len() > MAX_SUBSCRIPTIONS || previous.len() != ids.len() {
            refuse!("订阅排序无效");
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let current: Vec<i64> = {
            let mut stmt = tx.prepare("SELECT id FROM subscription ORDER BY position, id")?;
            let rows = stmt.query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
            rows
        };
        if current != previous || ids.iter().collect::<HashSet<_>>() != current.iter().collect() {
            refuse!("订阅列表或顺序已更新，请刷新页面后重试");
        }
        for (position, id) in ids.iter().enumerate() {
            tx.execute("UPDATE subscription SET position=?2 WHERE id=?1", params![id, position as i64])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(super) fn subscription_history(&self, id: i64) -> Result<Vec<History>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, paid_on, periods, previous_due, next_due, amount, currency, recorded_at
             FROM subscription_renewal WHERE subscription_id=?1 ORDER BY id DESC LIMIT 100",
        )?;
        let rows = stmt
            .query_map([id], |r| {
                Ok(History {
                    id: r.get(0)?,
                    paid_on: r.get(1)?,
                    periods: r.get(2)?,
                    previous_due: r.get(3)?,
                    next_due: r.get(4)?,
                    amount: r.get(5)?,
                    currency: r.get(6)?,
                    recorded_at: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub(super) fn renew_subscriptions(
        &self,
        input: Renewal,
        today: NaiveDate,
        apply: bool,
    ) -> Result<Vec<RenewalPreview>> {
        checked_selection(input.items.iter().map(|item| &item.target))?;
        if !(1..=120).contains(&input.periods) {
            refuse!("续费周期数须在 1 到 120 之间");
        }
        if !supported_date(input.paid_on) || input.paid_on > today {
            refuse!("付款日无效或晚于今天");
        }
        let paid_on = input.paid_on.to_string();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut previews = Vec::with_capacity(input.items.len());
        for item in input.items {
            let Entry { id, mut plan, .. } = checked_entry(&tx, &item.target)?;
            let Some(previous_due) = plan.due_on else {
                refuse!("{} 是一次性买断项目，不能续费", plan.name)
            };
            if plan.kind == super::Kind::KeepNumber {
                let last: Option<String> = tx.query_row(
                    "SELECT MAX(paid_on) FROM subscription_renewal WHERE subscription_id=?1",
                    [id],
                    |r| r.get(0),
                )?;
                if last.is_some_and(|last| last > paid_on) {
                    refuse!("{} 的付款日不能早于上一笔保号付款", plan.name);
                }
            }
            let next_due = plan.next_date(input.paid_on, input.periods)?;
            let paid_amount = item
                .amount
                .map_or_else(|| period_amount(&plan.amount, input.periods), |value| amount(&value))?;
            if apply {
                tx.execute(
                    "INSERT INTO subscription_renewal
                        (subscription_id, paid_on, periods, previous_due, next_due, amount, currency, recorded_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![id, paid_on, input.periods, previous_due.to_string(), next_due.to_string(), paid_amount,
                        plan.currency, Utc::now().timestamp()],
                )?;
                plan.due_on = Some(next_due);
                update(&tx, id, &plan)?;
            }
            previews.push(RenewalPreview {
                id,
                name: plan.name,
                previous_due,
                next_due,
                amount: paid_amount,
                currency: plan.currency,
            });
        }
        tx.commit()?;
        Ok(previews)
    }

    pub(crate) fn subscription_reminders(&self, today: NaiveDate, channel: &str) -> Result<Vec<Reminder>> {
        let conn = self.conn();
        let mut seen = conn.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM subscription_reminder
             WHERE subscription_id=?1 AND due_on=?2 AND milestone=?3 AND channel=?4)",
        )?;
        let mut pending = Vec::new();
        for Entry { id, plan, .. } in entries(&conn)? {
            let (Some(due), Some(milestone)) = (plan.due_on, plan.milestone(today)) else { continue };
            if !seen.query_row(params![id, due.to_string(), milestone, channel], |r| r.get::<_, bool>(0))? {
                pending.push(Reminder { id, name: plan.name, due, milestone });
            }
        }
        pending.sort_unstable_by_key(|entry| (entry.due, entry.id));
        Ok(pending)
    }

    pub(crate) fn mark_subscription_reminders(&self, entries: &[Reminder], channel: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for entry in entries {
            tx.execute(
                "INSERT OR IGNORE INTO subscription_reminder (subscription_id,due_on,milestone,channel)
                 SELECT id,?2,?3,?4 FROM subscription WHERE id=?1",
                params![entry.id, entry.due.to_string(), entry.milestone, channel],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn date(iso: &str) -> NaiveDate {
        iso.parse().unwrap()
    }

    fn plan(kind: &str, due: &str, unit: &str, count: u32) -> Plan {
        serde_json::from_value::<Plan>(json!({
            "name":"Test", "category":"通信", "kind":kind, "cycle":{"unit":unit,"count":count},
            "due_on":due, "purchased_on":null, "anchor_day":null, "month_end":false,
            "amount":"10.00", "currency":"HKD", "enabled":true,
            "reminder_days":[7,3,0], "overdue_reminder":true, "notes":"",
        }))
        .unwrap()
        .normalize(date("2027-01-01"))
        .unwrap()
    }

    fn renewal(id: i64, revision: i64, paid_on: &str) -> Renewal {
        serde_json::from_value(json!({"paid_on":paid_on,"periods":1,"items":[{"id":id,"revision":revision}]}))
            .unwrap()
    }

    #[test]
    fn calendar_anchors_survive_short_months_and_leap_years() {
        let mut monthly = plan("recurring", "2027-01-31", "months", 1);
        let paid = date("2027-01-15");
        assert_eq!(monthly.next_date(paid, 1).unwrap(), date("2027-02-28"));
        monthly.due_on = Some(date("2027-02-28"));
        assert_eq!(monthly.next_date(paid, 1).unwrap(), date("2027-03-31"));
        let mut yearly = plan("recurring", "2024-02-29", "years", 1);
        yearly.due_on = Some(date("2025-02-28"));
        assert_eq!(yearly.next_date(paid, 3).unwrap(), date("2028-02-29"));
        monthly.month_end = true;
        monthly.anchor_day = Some(28);
        assert_eq!(monthly.next_date(paid, 1).unwrap(), date("2027-03-31"));
    }

    #[test]
    fn preview_and_commit_rebase_keep_number_from_paid_date_and_reject_stale_revisions() {
        let db = Db::open(":memory:").unwrap();
        let id = db.create_subscription(&plan("keep_number", "2026-11-20", "days", 90)).unwrap();
        let today = date("2026-11-23");
        let early = db.renew_subscriptions(renewal(id, 1, "2026-11-01"), today, false).unwrap();
        assert_eq!(early[0].next_due, date("2027-01-30"));
        assert!(db.subscription_history(id).unwrap().is_empty());
        let late = db.renew_subscriptions(renewal(id, 1, "2026-11-23"), today, true).unwrap();
        assert_eq!(late[0].next_due, date("2027-02-21"));
        assert!(db.renew_subscriptions(renewal(id, 1, "2026-11-23"), today, true).is_err());
        assert!(db.renew_subscriptions(renewal(id, 2, "2026-11-21"), today, true).is_err());
        assert_eq!(db.subscription_history(id).unwrap().len(), 1);
    }

    #[test]
    fn reminder_catches_up_to_current_milestone_and_tracks_each_channel() {
        let db = Db::open(":memory:").unwrap();
        let id = db.create_subscription(&plan("recurring", "2027-01-10", "months", 1)).unwrap();
        let today = date("2027-01-08");
        let reminders = db.subscription_reminders(today, "Telegram").unwrap();
        assert_eq!(reminders[0].milestone, 3);
        db.mark_subscription_reminders(&reminders, "Telegram").unwrap();
        assert!(db.subscription_reminders(today, "Telegram").unwrap().is_empty());
        assert_eq!(db.subscription_reminders(today, "Webhook").unwrap().len(), 1);
        let due = db.subscription_reminders(date("2027-01-10"), "Telegram").unwrap();
        assert_eq!(due[0].milestone, 0);
        db.batch_subscriptions(Batch { items: vec![Target { id, revision: 1 }], action: Action::Disable })
            .unwrap();
        assert!(db.subscription_reminders(date("2027-01-11"), "Webhook").unwrap().is_empty());
    }

    #[test]
    fn batches_are_atomic_and_manual_order_cannot_overwrite_a_newer_list() {
        let db = Db::open(":memory:").unwrap();
        let plan = plan("recurring", "2027-01-10", "months", 1);
        let first = db.create_subscription(&plan).unwrap();
        let second = db.create_subscription(&plan).unwrap();
        let items = vec![Target { id: first, revision: 1 }, Target { id: second, revision: 2 }];
        assert!(db.batch_subscriptions(Batch { items, action: Action::Delete }).is_err());
        assert_eq!(db.subscriptions().unwrap().len(), 2);
        db.order_subscriptions(&[second, first], &[first, second]).unwrap();
        assert!(db.order_subscriptions(&[first, second], &[first, second]).is_err());
        assert_eq!(db.subscriptions().unwrap()[0].id, second);
    }
}
