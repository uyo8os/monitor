/// <reference types="node" />
import assert from "node:assert/strict"
import type { Node } from "./api.ts"
import { budgetTotals, convertAmount, matchesExpiry, rowFor } from "./cost.ts"

const node = (values: Partial<Node>): Node => ({
  id: 1, name: "test", price: 120, currency: "USD", billing_cycle: "yearly",
  expires_at: "2026-11-19", expires_in: 0, ...values,
} as Node)

const annual = rowFor(node({}))
assert.equal(annual.monthly, 10)
assert.equal(annual.yearly, 120)
assert.equal(annual.expiry, "今天到期")
assert.equal(annual.status, "soon")
assert.equal(matchesExpiry(annual, "7"), true)
assert.equal(matchesExpiry(rowFor(node({ expires_in: 7 })), "7"), true)
assert.equal(matchesExpiry(rowFor(node({ expires_in: 8 })), "7"), false)
assert.equal(matchesExpiry(rowFor(node({ expires_in: -1 })), "7"), false)
assert.equal(rowFor(node({ expires_in: -1 })).status, "expired")
assert.equal(rowFor(node({ expires_at: null, expires_in: null })).expiry, "长期有效")

const custom = rowFor(node({ price: 300, billing_cycle: "60m" }))
assert.equal(custom.monthly, 5)
assert.equal(custom.yearly, 60)
assert.equal(custom.cycle, "5 年付")
const unknown = rowFor(node({ billing_cycle: "unknown" }))
assert.equal(unknown.monthly, null)
assert.equal(unknown.status, "unconfigured")
assert.equal(convertAmount(10, "EUR", "CNY", { USD: 1, EUR: 0.8, CNY: 7 }), 87.5)
assert.equal(convertAmount(10, "USD", "USD", {}), 10)
assert.equal(convertAmount(10, "EUR", "CNY", { EUR: 0, CNY: 7 }), null)

assert.deepEqual(budgetTotals([
  { ...annual, displayMonthly: 70, displayYearly: 840 },
  { ...custom, displayMonthly: null, displayYearly: null },
  { ...unknown, displayMonthly: null, displayYearly: null },
]), { monthly: 70, yearly: 840, convertedNodes: 1, missingRates: 1, invalidCycles: 1 })
