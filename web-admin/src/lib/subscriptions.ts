import { api } from "./api"

export type SubscriptionKind = "recurring" | "keep_number" | "one_time"
export type CycleUnit = "days" | "months" | "years"
export type SubscriptionPlan = {
  name: string
  category: string
  kind: SubscriptionKind
  cycle: { count: number; unit: CycleUnit } | null
  due_on: string | null
  purchased_on: string | null
  anchor_day: number | null
  month_end: boolean
  amount: string
  currency: string
  enabled: boolean
  reminder_days: number[]
  overdue_reminder: boolean
  notes: string
}

export type Target = { id: number; revision: number }
export type Subscription = Target & SubscriptionPlan
export type SubscriptionList = { items: Subscription[]; today: string; notifications_configured: boolean }
export type BatchAction = "enable" | "disable" | "category" | "delete"
export type RenewalRequest = { paid_on: string; periods: number; items: (Target & { amount?: string })[] }
export type RenewalPreview = {
  id: number
  name: string
  previous_due: string
  next_due: string
  amount: string
  currency: string
}
export type RenewalHistory = Omit<RenewalPreview, "name"> & { paid_on: string; periods: number; recorded_at: number }

export const KINDS: Record<SubscriptionKind, string> = { recurring: "周期订阅", keep_number: "号码保号", one_time: "一次性买断" }
const UNITS: Record<CycleUnit, string> = { days: "天", months: "个月", years: "年" }

export function cycleLabel(item: Subscription) {
  if (!item.cycle) return KINDS[item.kind]
  const { count, unit } = item.cycle
  const cycle = count === 1 && unit !== "days" ? (unit === "months" ? "每月" : "每年") : `每 ${count} ${UNITS[unit]}`
  return `${item.kind === "keep_number" ? "保号" : "周期"} · ${cycle}`
}

export type DueStatus = "late" | "today" | "soon" | "active" | "bought" | "paused"
export const STATUSES: Record<DueStatus, string> = {
  late: "已逾期", today: "今天到期", soon: "未来 7 天", active: "正常", bought: "已买断", paused: "已停用",
}

export function daysLeft(due: string, today: string) {
  return (Date.parse(due) - Date.parse(today)) / 86_400_000
}

export function dueStatus(item: Subscription, today: string): DueStatus {
  if (!item.enabled) return "paused"
  if (!item.due_on) return "bought"
  const days = daysLeft(item.due_on, today)
  if (days < 0) return "late"
  if (days === 0) return "today"
  if (days <= 7) return "soon"
  return "active"
}

export const listSubscriptions = (signal?: AbortSignal) => api<SubscriptionList>("/subscriptions", { signal })
export function saveSubscription(plan: SubscriptionPlan, item?: Target) {
  return api(item ? `/subscriptions/${item.id}` : "/subscriptions", {
    method: item ? "PUT" : "POST",
    body: JSON.stringify(item ? { ...plan, revision: item.revision } : plan),
  })
}

export function batchSubscriptions(action: BatchAction, items: Target[], category?: string) {
  return api("/subscriptions/batch", {
    method: "POST",
    body: JSON.stringify({ action, items: items.map(targetOf), category }),
  })
}

export function reorderSubscriptions(ids: number[], previous: number[]) {
  return api("/subscriptions/order", { method: "PUT", body: JSON.stringify({ ids, previous }) })
}

export function renewSubscriptions(input: RenewalRequest, preview: boolean) {
  return api<{ items: RenewalPreview[] }>(preview ? "/subscriptions/renew/preview" : "/subscriptions/renew", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export const subscriptionHistory = (id: number) => api<{ history: RenewalHistory[] }>(`/subscriptions/${id}/history`)
export const targetOf = ({ id, revision }: Target): Target => ({ id, revision })
export const currencyAmount = (amount: string, currency: string) => `${currency} ${amount}`
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试"
