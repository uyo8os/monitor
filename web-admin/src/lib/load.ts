import { api } from "./api"

export type LoadMetric = "cpu" | "ram" | "disk" | "net_in" | "net_out"

export type LoadRuleNode = {
  node_id: number
  enabled: boolean
}

export type LoadRule = {
  id: number
  name: string
  metric: LoadMetric
  threshold: number
  ratio: number
  interval_minutes: number
  enabled: boolean
  default_enabled: boolean
  revision: number
  created_at: number
  updated_at: number
  nodes: LoadRuleNode[]
}

export type LoadRuleInput = {
  name: string
  metric: LoadMetric
  threshold: number
  ratio: number
  interval_minutes: number
  enabled: boolean
  default_enabled: boolean
  nodes: LoadRuleNode[]
}

export type CurrentLoadAlert = {
  rule_id: number
  rule_name: string
  node_id: number
  node_name: string
  metric: LoadMetric
  threshold: number
  ratio: number
  interval_minutes: number
  active_since: number | null
  last_evaluated_at: number
  stale: boolean
  latest_value: number
  matched_samples: number
  total_samples: number
  last_notified_at: number | null
  silenced: boolean
  silenced_until: number | null
  silenced_forever: boolean
}

export type LoadSilenceMode = "off" | "24h" | "3d" | "7d" | "forever"

export function getLoadRules() {
  return api<{ rules: LoadRule[] }>("/notification/load/rules")
}

export function createLoadRule(rule: LoadRuleInput) {
  return api<{ id: number }>("/notification/load/rules", {
    method: "POST",
    body: JSON.stringify(rule),
  })
}

export function updateLoadRule(id: number, rule: LoadRuleInput) {
  return api<{ ok: boolean }>(`/notification/load/rules/${id}`, {
    method: "PUT",
    body: JSON.stringify(rule),
  })
}

export function deleteLoadRule(id: number) {
  return api<{ ok: boolean }>(`/notification/load/rules/${id}`, { method: "DELETE" })
}

export function getCurrentLoadAlerts() {
  return api<{ alerts: CurrentLoadAlert[] }>("/notification/load/current")
}

export function setLoadAlertSilence(ruleId: number, nodeId: number, mode: LoadSilenceMode) {
  return api<{
    ok: boolean
    mode: LoadSilenceMode
    silenced_until: number | null
    silenced_forever: boolean
  }>(`/notification/load/current/${ruleId}/${nodeId}/silence`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  })
}

