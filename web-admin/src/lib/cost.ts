import type { Node } from "./api.ts"
import { cycleMonths } from "./format.ts"

export type CostStatus = "free" | "active" | "soon" | "expired" | "unconfigured"
export type CostRow = {
  node: Node
  currency: string
  price: number
  monthly: number | null
  yearly: number | null
  cycle: string
  status: CostStatus
  expiry: string
  daysLeft: number | null
}
export type DisplayCostRow = CostRow & { displayMonthly: number | null; displayYearly: number | null }

function expiry(node: Node): { status: CostStatus; label: string; daysLeft: number | null } {
  if (!node.price || node.price < 0) return { status: "free", label: "免费", daysLeft: null }
  if (!node.expires_at) return { status: "active", label: "长期有效", daysLeft: null }
  // The hub calculates this on its calendar, independent of the browser's clock and time zone.
  const daysLeft = node.expires_in
  if (daysLeft === null) return { status: "active", label: node.expires_at, daysLeft: null }
  if (daysLeft < 0) return { status: "expired", label: "已过期", daysLeft }
  if (daysLeft === 0) return { status: "soon", label: "今天到期", daysLeft }
  return { status: daysLeft <= 7 ? "soon" : "active", label: `${daysLeft} 天后到期`, daysLeft }
}

function cycleLabel(months: number): string {
  if (!Number.isFinite(months) || months < 0) return "未知周期"
  if (months === 0) return "一次性"
  if (months === 1) return "月付"
  if (months === 3) return "季付"
  if (months === 6) return "半年付"
  if (months % 12 === 0) return months === 12 ? "年付" : `${months / 12} 年付`
  return `${months} 个月付`
}

export function rowFor(node: Node): CostRow {
  const price = Number.isFinite(node.price) && node.price > 0 ? node.price : 0
  const months = cycleMonths(node.billing_cycle)
  const status = expiry({ ...node, price })
  const configured = price > 0 && Number.isFinite(months) && months > 0
  return {
    node,
    currency: node.currency.trim().toUpperCase() || "未设置",
    price,
    monthly: configured ? price / months : null,
    yearly: configured ? price * 12 / months : null,
    cycle: cycleLabel(months),
    status: configured ? status.status : price === 0 ? "free" : "unconfigured",
    expiry: price > 0 ? status.label : "不计费",
    daysLeft: status.daysLeft,
  }
}

export function convertAmount(amount: number, sourceCurrency: string, targetCurrency: string, rates: Record<string, number>): number | null {
  const source = sourceCurrency.trim().toUpperCase()
  if (!Number.isFinite(amount) || amount < 0) return null
  if (source === targetCurrency) return amount
  const sourceRate = rates[source]
  const targetRate = rates[targetCurrency]
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) return null
  return amount * targetRate / sourceRate
}

export function budgetTotals(rows: DisplayCostRow[]) {
  let monthly = 0, yearly = 0, convertedNodes = 0, missingRates = 0, invalidCycles = 0
  for (const row of rows) {
    if (row.monthly === null || row.yearly === null) { invalidCycles++; continue }
    if (row.displayMonthly === null || row.displayYearly === null) { missingRates++; continue }
    monthly += row.displayMonthly
    yearly += row.displayYearly
    convertedNodes++
  }
  return { monthly, yearly, convertedNodes, missingRates, invalidCycles }
}

export function matchesExpiry(row: CostRow, filter: "all" | "7" | "30" | "90") {
  if (filter === "all") return true
  return row.daysLeft !== null && row.daysLeft >= 0 && row.daysLeft <= Number(filter)
}
