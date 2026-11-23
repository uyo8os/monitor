//! Subscription dates, rule validation and admin endpoints.
mod store;

use anyhow::Result;
use axum::extract::{rejection::JsonRejection, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{Datelike, Days, Local, Months, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::api::{answer, fail, Admin};
use crate::Shared;

pub use store::SCHEMA;

const MAX_SUBSCRIPTIONS: usize = 2000;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    Recurring,
    KeepNumber,
    OneTime,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Unit {
    Days,
    Months,
    Years,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
struct Cycle {
    count: u32,
    unit: Unit,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Plan {
    pub name: String,
    category: String,
    kind: Kind,
    cycle: Option<Cycle>,
    pub due_on: Option<NaiveDate>,
    purchased_on: Option<NaiveDate>,
    anchor_day: Option<u32>,
    month_end: bool,
    amount: String,
    currency: String,
    enabled: bool,
    reminder_days: Vec<i64>,
    overdue_reminder: bool,
    notes: String,
}

impl Plan {
    fn normalize(mut self, today: NaiveDate) -> Result<Self> {
        self.name = clean(self.name, 100, "名称", true)?;
        self.category = clean(self.category, 50, "分类", false)?;
        self.notes = self.notes.trim().to_owned();
        if self.notes.chars().count() > 1000
            || self.notes.chars().any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
        {
            refuse!("备注不能超过 1000 个字符或包含特殊控制字符");
        }
        self.amount = amount(&self.amount)?;
        self.currency = self.currency.trim().to_ascii_uppercase();
        if self.currency.len() != 3 || !self.currency.bytes().all(|b| b.is_ascii_uppercase()) {
            refuse!("币种应为三位字母代码");
        }
        if self.kind == Kind::OneTime {
            let Some(purchased) = self.purchased_on else { refuse!("请选择购买日期") };
            if !supported_date(purchased) || purchased > today {
                refuse!("购买日期无效或晚于今天");
            }
            self.cycle = None;
            self.due_on = None;
            self.anchor_day = None;
            self.month_end = false;
            self.reminder_days.clear();
            self.overdue_reminder = false;
        } else {
            let Some(cycle) = self.cycle else { refuse!("请填写续费周期") };
            let max = match cycle.unit {
                Unit::Days => 3650,
                Unit::Months => 120,
                Unit::Years => 10,
            };
            if !(1..=max).contains(&cycle.count) {
                refuse!("续费周期必须在 1 到 {max} 之间");
            }
            let Some(due) = self.due_on else { refuse!("请选择当前到期日") };
            if !supported_date(due) {
                refuse!("到期日期无效");
            }
            self.purchased_on = None;
            if self.kind == Kind::Recurring && !matches!(cycle.unit, Unit::Days) {
                let anchor = self.anchor_day.unwrap_or_else(|| due.day());
                if !(1..=31).contains(&anchor) {
                    refuse!("账单日必须在 1 到 31 之间");
                }
                self.anchor_day = Some(anchor);
            } else {
                self.anchor_day = None;
                self.month_end = false;
            }
            if self.reminder_days.len() > 20
                || self.reminder_days.iter().any(|days| !(0..=365).contains(days))
            {
                refuse!("提醒最多设置 20 个时间点，须为到期前 0 到 365 天");
            }
            self.reminder_days.sort_unstable();
            self.reminder_days.dedup();
        }
        Ok(self)
    }

    fn next_date(&self, paid_on: NaiveDate, periods: u32) -> Result<NaiveDate> {
        let (Some(due), Some(cycle)) = (self.due_on, self.cycle) else {
            refuse!("一次性买断项目无需续费");
        };
        let base = if self.kind == Kind::KeepNumber { paid_on } else { due };
        let count = cycle.count.saturating_mul(periods);
        let next = match cycle.unit {
            Unit::Days => base.checked_add_days(Days::new(count.into())),
            Unit::Months | Unit::Years => {
                let months = count.saturating_mul(if matches!(cycle.unit, Unit::Years) { 12 } else { 1 });
                let target = base.with_day(1).and_then(|first| first.checked_add_months(Months::new(months)));
                target.and_then(|first| {
                    let last = (28..=31).rev().find(|&day| first.with_day(day).is_some())?;
                    let anchor =
                        if self.month_end { last } else { self.anchor_day.unwrap_or_else(|| base.day()) };
                    first.with_day(anchor.min(last))
                })
            }
        };
        match next.filter(|d| supported_date(*d)) {
            Some(next) => Ok(next),
            None => refuse!("续费后日期超出支持范围"),
        }
    }

    fn milestone(&self, today: NaiveDate) -> Option<i64> {
        if !self.enabled {
            return None;
        }
        let left = (self.due_on? - today).num_days();
        if left < 0 {
            return self.overdue_reminder.then_some(-1);
        }
        self.reminder_days.iter().copied().filter(|days| left <= *days).min()
    }
}

fn supported_date(date: NaiveDate) -> bool {
    (1900..=9999).contains(&date.year())
}

fn clean(value: String, max: usize, field: &str, required: bool) -> Result<String> {
    let value = value.trim();
    if required && value.is_empty() {
        refuse!("{field}不能为空");
    }
    if value.chars().count() > max || value.chars().any(char::is_control) {
        refuse!("{field}不能超过 {max} 个字符或包含控制字符");
    }
    Ok(value.to_owned())
}

fn amount(value: &str) -> Result<String> {
    let value = value.trim();
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let (whole, fraction) = value.split_once('.').map_or((value, None), |(w, f)| (w, Some(f)));
    if !digits(whole) || whole.len() > 12 || fraction.is_some_and(|s| !digits(s) || s.len() > 4) {
        refuse!("金额须为非负数字，最多 12 位整数和 4 位小数");
    }
    let whole = whole.trim_start_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };
    Ok(fraction.map_or_else(|| whole.to_owned(), |fraction| format!("{whole}.{fraction}")))
}

fn period_amount(value: &str, periods: u32) -> Result<String> {
    let value = amount(value)?;
    let (whole, fraction) = value.split_once('.').unwrap_or((&value, ""));
    let scale = 10_u64.pow(fraction.len() as u32);
    let units = whole.parse::<u64>()? * scale;
    let fraction_units = if fraction.is_empty() { 0 } else { fraction.parse::<u64>()? };
    let total = (units + fraction_units) * u64::from(periods);
    let whole = total / scale;
    let formatted = if fraction.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{:0width$}", total % scale, width = fraction.len())
    };
    amount(&formatted)
}

#[derive(Deserialize)]
struct Target {
    id: i64,
    revision: i64,
}

#[derive(Deserialize)]
pub struct Edit {
    revision: i64,
    #[serde(flatten)]
    plan: Plan,
}

#[derive(Deserialize)]
pub struct Batch {
    items: Vec<Target>,
    #[serde(flatten)]
    action: Action,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Action {
    Enable,
    Disable,
    Category { category: String },
    Delete,
}

#[derive(Deserialize)]
pub struct Order {
    ids: Vec<i64>,
    previous: Vec<i64>,
}

#[derive(Deserialize)]
pub struct Renewal {
    paid_on: NaiveDate,
    periods: u32,
    items: Vec<RenewalItem>,
}

#[derive(Deserialize)]
struct RenewalItem {
    #[serde(flatten)]
    target: Target,
    amount: Option<String>,
}

#[derive(Serialize)]
struct RenewalPreview {
    id: i64,
    name: String,
    previous_due: NaiveDate,
    next_due: NaiveDate,
    amount: String,
    currency: String,
}

async fn respond<T: Serialize + Send + 'static>(op: impl FnOnce() -> Result<T> + Send + 'static) -> Response {
    match tokio::task::spawn_blocking(op).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => fail(error),
        Err(error) => fail(error),
    }
}

fn bad_body() -> Response {
    answer(StatusCode::BAD_REQUEST, "订阅表单格式不正确，请检查日期和数字")
}

pub async fn list(_: Admin, State(app): State<Shared>) -> Response {
    respond(move || {
        Ok(json!({
            "items": app.db.subscriptions()?,
            "today": Local::now().date_naive(),
            "notifications_configured": crate::notify::has_channels(&app),
        }))
    })
    .await
}

pub async fn create(
    _: Admin,
    State(app): State<Shared>,
    body: Result<Json<Plan>, JsonRejection>,
) -> Response {
    let Ok(Json(plan)) = body else { return bad_body() };
    respond(move || {
        let plan = plan.normalize(Local::now().date_naive())?;
        Ok(json!({"id":app.db.create_subscription(&plan)?}))
    })
    .await
}

pub async fn edit(
    _: Admin,
    State(app): State<Shared>,
    Path(id): Path<i64>,
    body: Result<Json<Edit>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = body else { return bad_body() };
    respond(move || {
        let plan = input.plan.normalize(Local::now().date_naive())?;
        app.db.edit_subscription(Target { id, revision: input.revision }, &plan)?;
        Ok(json!({"ok":true}))
    })
    .await
}

pub async fn history(_: Admin, State(app): State<Shared>, Path(id): Path<i64>) -> Response {
    respond(move || Ok(json!({"history":app.db.subscription_history(id)?}))).await
}

pub async fn batch(
    _: Admin,
    State(app): State<Shared>,
    body: Result<Json<Batch>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = body else { return bad_body() };
    respond(move || {
        app.db.batch_subscriptions(input)?;
        Ok(json!({"ok":true}))
    })
    .await
}

pub async fn order(
    _: Admin,
    State(app): State<Shared>,
    body: Result<Json<Order>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = body else { return bad_body() };
    respond(move || {
        app.db.order_subscriptions(&input.ids, &input.previous)?;
        Ok(json!({"ok":true}))
    })
    .await
}

pub async fn preview(
    _: Admin,
    State(app): State<Shared>,
    body: Result<Json<Renewal>, JsonRejection>,
) -> Response {
    renew_response(app, body, false).await
}

pub async fn renew(
    _: Admin,
    State(app): State<Shared>,
    body: Result<Json<Renewal>, JsonRejection>,
) -> Response {
    renew_response(app, body, true).await
}

async fn renew_response(app: Shared, body: Result<Json<Renewal>, JsonRejection>, apply: bool) -> Response {
    let Ok(Json(input)) = body else { return bad_body() };
    respond(move || {
        let today = Local::now().date_naive();
        Ok(json!({"items": app.db.renew_subscriptions(input, today, apply)?}))
    })
    .await
}
