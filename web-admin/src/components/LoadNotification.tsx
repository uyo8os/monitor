import { useEffect, useMemo, useState } from "react"
import { Bell, BellOff, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  createLoadRule,
  deleteLoadRule,
  getCurrentLoadAlerts,
  getLoadRules,
  setLoadAlertSilence,
  updateLoadRule,
  type CurrentLoadAlert,
  type LoadMetric,
  type LoadRule,
  type LoadRuleInput,
  type LoadRuleNode,
  type LoadSilenceMode,
  type Node,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const METRICS: Array<{ value: LoadMetric; label: string; unit: string }> = [
  { value: "cpu", label: "CPU", unit: "%" },
  { value: "ram", label: "RAM", unit: "%" },
  { value: "disk", label: "Disk", unit: "%" },
  { value: "net_in", label: "Net In", unit: "Mbps" },
  { value: "net_out", label: "Net Out", unit: "Mbps" },
]

const SILENCE_OPTIONS: Array<{ value: LoadSilenceMode; label: string }> = [
  { value: "off", label: "取消静默" },
  { value: "24h", label: "静默 24 小时" },
  { value: "3d", label: "静默 3 天" },
  { value: "7d", label: "静默 7 天" },
  { value: "forever", label: "永久静默" },
]

type RuleDraft = {
  name: string
  metric: LoadMetric
  threshold: string
  ratioPercent: string
  intervalMinutes: string
  enabled: boolean
  defaultEnabled: boolean
  targets: LoadRuleNode[]
}

function newDraft(rule: LoadRule | null): RuleDraft {
  if (!rule) {
    return {
      name: "",
      metric: "cpu",
      threshold: "80",
      ratioPercent: "50",
      intervalMinutes: "1",
      enabled: true,
      defaultEnabled: false,
      targets: [],
    }
  }
  return {
    name: rule.name,
    metric: rule.metric,
    threshold: String(rule.threshold),
    ratioPercent: String(Number((rule.ratio * 100).toFixed(2))),
    intervalMinutes: String(rule.interval_minutes),
    enabled: rule.enabled,
    defaultEnabled: rule.default_enabled,
    targets: rule.nodes.map((target) => ({ ...target })),
  }
}

function metricInfo(metric: LoadMetric) {
  return METRICS.find((item) => item.value === metric) ?? METRICS[0]
}

function formatValue(metric: LoadMetric, value: number) {
  return `${value.toFixed(2)} ${metricInfo(metric).unit}`
}

function formatRatio(ratio: number) {
  return `${(ratio * 100).toFixed(1)}%`
}

function formatTime(timestamp: number | null) {
  if (!timestamp) return "—"
  return new Date(timestamp * 1000).toLocaleString()
}

function targetNames(rule: LoadRule, nodes: Node[]) {
  const byId = new Map(nodes.map((node) => [node.id, node.name]))
  const enabled = rule.nodes.filter((target) => target.enabled).length
  const disabled = rule.nodes.length - enabled
  const names = rule.nodes
    .slice(0, 3)
    .map((target) => byId.get(target.node_id) ?? `ID ${target.node_id}`)
    .join("、")
  const suffix = rule.nodes.length > 3 ? ` 等 ${rule.nodes.length} 台` : ""
  return `${names || "未选择服务器"}${suffix}${disabled ? `（${disabled} 台已停用）` : ""}`
}

function ErrorMessage({ children }: { children: string }) {
  return <p className="text-sm text-destructive" role="alert">{children}</p>
}

function ServerSelectorDialog({
  open,
  nodes,
  selected,
  onOpenChange,
  onComplete,
}: {
  open: boolean
  nodes: Node[]
  selected: LoadRuleNode[]
  onOpenChange: (open: boolean) => void
  onComplete: (targets: LoadRuleNode[]) => void
}) {
  const [working, setWorking] = useState<LoadRuleNode[]>(() => selected.map((target) => ({ ...target })))
  const [query, setQuery] = useState("")

  const visibleNodes = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return nodes
    return nodes.filter((node) => node.name.toLowerCase().includes(needle) || String(node.id).includes(needle))
  }, [nodes, query])

  function toggleNode(nodeId: number) {
    setWorking((current) => {
      const target = current.find((item) => item.node_id === nodeId)
      return target
        ? current.filter((item) => item.node_id !== nodeId)
        : [...current, { node_id: nodeId, enabled: true }]
    })
  }

  function toggleEnabled(nodeId: number, enabled: boolean) {
    setWorking((current) => current.map((target) => target.node_id === nodeId ? { ...target, enabled } : target))
  }

  function selectAll() {
    setWorking(nodes.map((node) => {
      const existing = working.find((target) => target.node_id === node.id)
      return existing ?? { node_id: node.id, enabled: true }
    }))
  }

  function complete() {
    onComplete([...working].sort((a, b) => a.node_id - b.node_id))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>选择服务器</DialogTitle>
          <DialogDescription>选择需要执行此负载监测的服务器，并可单独关闭某台服务器的监测。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索服务器名称或 ID"
            className="min-w-52 flex-1"
          />
          <Button type="button" size="sm" variant="outline" onClick={selectAll} disabled={nodes.length === 0}>
            全选
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setWorking([])} disabled={working.length === 0}>
            清空
          </Button>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>已选择 {working.length} / {nodes.length} 台</span>
          <span>列表中的“启用监测”控制单机状态</span>
        </div>
        <div className="max-h-80 space-y-1 overflow-y-auto rounded-lg border bg-muted/20 p-2">
          {visibleNodes.map((node) => {
            const target = working.find((item) => item.node_id === node.id)
            return (
              <div key={node.id} className="flex items-center gap-3 rounded-md px-2.5 py-2 hover:bg-background">
                <input
                  type="checkbox"
                  checked={!!target}
                  onChange={() => toggleNode(node.id)}
                  aria-label={`选择 ${node.name}`}
                  className="accent-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="truncate">{node.name}</span>
                    <Badge variant={node.online ? "online" : "offline"} className="border-transparent">{node.online ? "在线" : "离线"}</Badge>
                  </div>
                  <span className="tnum text-xs text-muted-foreground">ID: {node.id}</span>
                </div>
                {target && (
                  <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={target.enabled}
                      onChange={(event) => toggleEnabled(node.id, event.target.checked)}
                      className="accent-primary"
                    />
                    启用监测
                  </label>
                )}
              </div>
            )
          })}
          {visibleNodes.length === 0 && <p className="p-3 text-sm text-muted-foreground">没有匹配的服务器</p>}
          {nodes.length === 0 && <p className="p-3 text-sm text-muted-foreground">暂无服务器，请先添加服务器</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" onClick={complete}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RuleEditorDialog({
  open,
  rule,
  nodes,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  rule: LoadRule | null
  nodes: Node[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<RuleDraft>(() => newDraft(rule))
  const [serverOpen, setServerOpen] = useState(false)
  const [serverSession, setServerSession] = useState(0)
  const [saving, setSaving] = useState(false)

  const currentMetric = metricInfo(draft.metric)

  async function save() {
    const threshold = Number(draft.threshold)
    const ratioPercent = Number(draft.ratioPercent)
    const intervalMinutes = Number(draft.intervalMinutes)
    if (!draft.name.trim()) {
      toast.error("请输入负载规则名称")
      return
    }
    if (!Number.isFinite(threshold) || threshold < 0 || (currentMetric.unit === "%" && threshold > 100)) {
      toast.error(currentMetric.unit === "%" ? "百分比阈值必须在 0 到 100 之间" : "请输入有效的非负阈值")
      return
    }
    if (!Number.isFinite(ratioPercent) || ratioPercent <= 0 || ratioPercent > 100) {
      toast.error("时间占比必须大于 0 且不超过 100%")
      return
    }
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 240) {
      toast.error("间隔必须是 1 到 240 分钟之间的整数")
      return
    }
    if (draft.targets.length === 0 && nodes.length > 0) {
      toast.error("请至少选择一台服务器")
      return
    }

    const payload: LoadRuleInput = {
      name: draft.name.trim(),
      metric: draft.metric,
      threshold,
      ratio: ratioPercent / 100,
      interval_minutes: intervalMinutes,
      enabled: draft.enabled,
      default_enabled: draft.defaultEnabled,
      nodes: draft.targets,
    }
    setSaving(true)
    try {
      if (rule) {
        await updateLoadRule(rule.id, payload)
        toast.success("负载规则已更新")
      } else {
        await createLoadRule(payload)
        toast.success("负载规则已创建")
      }
      onSaved()
      onOpenChange(false)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "负载规则保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule ? "编辑负载通知" : "新增负载通知"}</DialogTitle>
          <DialogDescription>当窗口内达到阈值的采样点占比满足条件时，创建一条当前告警并按间隔重复通知。</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="load-rule-name">名称</Label>
              <Input
                id="load-rule-name"
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="例如：CPU 高负载"
                disabled={saving}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="load-rule-metric">监控项</Label>
              <Select
                value={draft.metric}
                onValueChange={(value) => setDraft((current) => ({ ...current, metric: value as LoadMetric }))}
                disabled={saving}
              >
                <SelectTrigger id="load-rule-metric" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METRICS.map((metric) => <SelectItem key={metric.value} value={metric.value}>{metric.label} ({metric.unit})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="load-rule-threshold">阈值（{currentMetric.unit}）</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="load-rule-threshold"
                  type="number"
                  min={0}
                  max={currentMetric.unit === "%" ? 100 : undefined}
                  step="any"
                  value={draft.threshold}
                  onChange={(event) => setDraft((current) => ({ ...current, threshold: event.target.value }))}
                  disabled={saving}
                />
                <span className="shrink-0 text-sm text-muted-foreground">{currentMetric.unit}</span>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="load-rule-ratio">时间占比（%）</Label>
              <Input
                id="load-rule-ratio"
                type="number"
                min={0.1}
                max={100}
                step="any"
                value={draft.ratioPercent}
                onChange={(event) => setDraft((current) => ({ ...current, ratioPercent: event.target.value }))}
                disabled={saving}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">窗口内达到阈值的采样点占比，不要求等满一个完整窗口。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="load-rule-interval">间隔（分钟）</Label>
              <Input
                id="load-rule-interval"
                type="number"
                min={1}
                max={240}
                step={1}
                value={draft.intervalMinutes}
                onChange={(event) => setDraft((current) => ({ ...current, intervalMinutes: event.target.value }))}
                disabled={saving}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">同时控制评估周期、回看窗口和持续告警重复通知冷却。</p>
            </div>
          </div>

          <div className="space-y-3 border-t pt-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Label>服务器</Label>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">规则只对已关联且启用监测的服务器生效。</p>
              </div>
              <Button type="button" variant="outline" onClick={() => { setServerSession((current) => current + 1); setServerOpen(true) }} disabled={saving}>
                <Server />
                选择服务器（{draft.targets.length}）
              </Button>
            </div>
            <div className="flex min-h-10 flex-wrap gap-2 rounded-lg border bg-muted/20 p-2">
              {draft.targets.map((target) => {
                const node = nodes.find((item) => item.id === target.node_id)
                return <Badge key={target.node_id} variant={target.enabled ? "secondary" : "outline"}>{node?.name ?? `ID ${target.node_id}`}{target.enabled ? "" : "（已停用）"}</Badge>
              })}
              {draft.targets.length === 0 && <span className="p-1 text-sm text-muted-foreground">尚未选择服务器</span>}
            </div>
          </div>

          <div className="space-y-4 border-t pt-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="load-rule-enabled">启用规则</Label>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">关闭后停止评估和通知，但不会删除已保存的服务器关联。</p>
              </div>
              <Switch id="load-rule-enabled" checked={draft.enabled} onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))} disabled={saving} />
            </div>
            <div className="flex items-center justify-between gap-4 border-t pt-4">
              <div>
                <Label htmlFor="load-rule-default-enabled">默认开启</Label>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">开启后，新加入的服务器会自动启用此监测；已存在的服务器不受影响。</p>
              </div>
              <Switch id="load-rule-default-enabled" checked={draft.defaultEnabled} onCheckedChange={(defaultEnabled) => setDraft((current) => ({ ...current, defaultEnabled }))} disabled={saving} />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
            <Button type="submit" disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
      <ServerSelectorDialog
        key={serverSession}
        open={serverOpen}
        nodes={nodes}
        selected={draft.targets}
        onOpenChange={setServerOpen}
        onComplete={(targets) => {
          setDraft((current) => ({ ...current, targets }))
          setServerOpen(false)
        }}
      />
    </Dialog>
  )
}

function DeleteRuleDialog({
  rule,
  busy,
  onOpenChange,
  onConfirm,
}: {
  rule: LoadRule | null
  busy: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={!!rule} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除负载通知？</DialogTitle>
          <DialogDescription>删除“{rule?.name}”会同时清理服务器关联、当前告警和静默状态，且无法撤销。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>取消</Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={busy}>{busy ? "删除中…" : "确认删除"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SilenceDialog({
  alert,
  onOpenChange,
  onDone,
}: {
  alert: CurrentLoadAlert | null
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const [mode, setMode] = useState<LoadSilenceMode>(() => alert?.silenced ? "off" : "24h")
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!alert) return
    setSaving(true)
    try {
      await setLoadAlertSilence(alert.rule_id, alert.node_id, mode)
      toast.success(mode === "off" ? "已取消静默" : "当前告警已静默")
      onDone()
      onOpenChange(false)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "静默设置保存失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={!!alert} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{alert?.silenced ? "调整告警静默" : "静默当前告警"}</DialogTitle>
          <DialogDescription>
            {alert?.node_name} 的“{alert?.rule_name}”仍会继续监控并显示在当前告警中；静默只阻止 Telegram 通知。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="load-alert-silence-mode">静默时长</Label>
          <Select value={mode} onValueChange={(value) => setMode(value as LoadSilenceMode)}>
            <SelectTrigger id="load-alert-silence-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SILENCE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button type="button" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "确认"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RuleList({
  rules,
  nodes,
  loading,
  error,
  onRefresh,
  onEdit,
  onDelete,
}: {
  rules: LoadRule[]
  nodes: Node[]
  loading: boolean
  error: string
  onRefresh: () => void
  onEdit: (rule: LoadRule) => void
  onDelete: (rule: LoadRule) => void
}) {
  if (loading) return <p className="text-sm text-muted-foreground">加载负载规则…</p>
  if (error) {
    return (
      <div className="space-y-3">
        <ErrorMessage>{error}</ErrorMessage>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh}>重试</Button>
      </div>
    )
  }

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>监控项</TableHead>
              <TableHead>条件</TableHead>
              <TableHead>服务器</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => {
              const metric = metricInfo(rule.metric)
              return (
                <TableRow key={rule.id}>
                  <TableCell>
                    <div className="font-medium">{rule.name}</div>
                    <div className="tnum text-xs text-muted-foreground">规则 #{rule.id}</div>
                  </TableCell>
                  <TableCell>{metric.label} <span className="text-muted-foreground">({metric.unit})</span></TableCell>
                  <TableCell>
                    <div className="tnum">≥ {formatValue(rule.metric, rule.threshold)}</div>
                    <div className="text-xs text-muted-foreground">{formatRatio(rule.ratio)} · {rule.interval_minutes} 分钟</div>
                  </TableCell>
                  <TableCell className="max-w-64 truncate" title={targetNames(rule, nodes)}>{targetNames(rule, nodes)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant={rule.enabled ? "default" : "outline"}>{rule.enabled ? "已启用" : "已停用"}</Badge>
                      {rule.default_enabled && <Badge variant="secondary">新服务器默认开启</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button type="button" size="icon-sm" variant="ghost" title="编辑" onClick={() => onEdit(rule)}><Pencil /></Button>
                      <Button type="button" size="icon-sm" variant="ghost" title="删除" onClick={() => onDelete(rule)}><Trash2 /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
            {rules.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">还没有负载通知规则</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

function AlertList({
  alerts,
  loading,
  error,
  onRefresh,
  onSilence,
}: {
  alerts: CurrentLoadAlert[]
  loading: boolean
  error: string
  onRefresh: () => void
  onSilence: (alert: CurrentLoadAlert) => void
}) {
  if (loading) return <p className="text-sm text-muted-foreground">加载当前告警…</p>
  if (error) {
    return (
      <div className="space-y-3">
        <ErrorMessage>{error}</ErrorMessage>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh}>重试</Button>
      </div>
    )
  }
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>服务器</TableHead>
              <TableHead>规则</TableHead>
              <TableHead>当前值 / 阈值</TableHead>
              <TableHead>时间占比</TableHead>
              <TableHead>开始时间</TableHead>
              <TableHead>通知状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {alerts.map((alert) => (
              <TableRow key={`${alert.rule_id}-${alert.node_id}`}>
                <TableCell>
                  <div className="font-medium">{alert.node_name}</div>
                  <div className="tnum text-xs text-muted-foreground">ID: {alert.node_id}</div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{alert.rule_name}</div>
                  <div className="text-xs text-muted-foreground">{metricInfo(alert.metric).label}</div>
                </TableCell>
                <TableCell>
                  <div className="tnum font-medium">{formatValue(alert.metric, alert.latest_value)}</div>
                  <div className="tnum text-xs text-muted-foreground">阈值 {formatValue(alert.metric, alert.threshold)}</div>
                </TableCell>
                <TableCell>
                  <div className="tnum">{alert.matched_samples} / {alert.total_samples}</div>
                  <div className="text-xs text-muted-foreground">要求 {formatRatio(alert.ratio)}</div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">{formatTime(alert.active_since)}</TableCell>
                <TableCell>
                  {alert.silenced ? (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <BellOff className="size-3.5" />
                      {alert.silenced_forever ? "永久静默" : `静默至 ${formatTime(alert.silenced_until)}`}
                    </div>
                  ) : (
                    <Badge variant={alert.last_notified_at ? "secondary" : "outline"}>{alert.last_notified_at ? "已通知" : "待通知"}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Button type="button" size="sm" variant="outline" onClick={() => onSilence(alert)}>
                    {alert.silenced ? <Bell /> : <BellOff />}
                    {alert.silenced ? "调整静默" : "静默"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {alerts.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-28 text-center text-muted-foreground">当前没有负载告警</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

export function LoadNotification({ nodes }: { nodes: Node[] }) {
  const [tab, setTab] = useState<"rules" | "alerts">("rules")
  const [rules, setRules] = useState<LoadRule[]>([])
  const [rulesLoading, setRulesLoading] = useState(true)
  const [rulesError, setRulesError] = useState("")
  const [alerts, setAlerts] = useState<CurrentLoadAlert[]>([])
  const [alertsLoading, setAlertsLoading] = useState(false)
  const [alertsError, setAlertsError] = useState("")
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<LoadRule | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LoadRule | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [silenceTarget, setSilenceTarget] = useState<CurrentLoadAlert | null>(null)
  const nodeIdentity = nodes.map((node) => `${node.id}:${node.name}`).join("|")

  function refreshRules() {
    setRulesLoading(true)
    void getLoadRules()
      .then((next) => {
        setRules(next.rules)
        setRulesError("")
      })
      .catch((reason: Error) => setRulesError(reason.message || "负载规则加载失败"))
      .finally(() => setRulesLoading(false))
  }

  function refreshAlerts() {
    setAlertsLoading(true)
    void getCurrentLoadAlerts()
      .then((next) => {
        setAlerts(next.alerts)
        setAlertsError("")
      })
      .catch((reason: Error) => setAlertsError(reason.message || "当前告警加载失败"))
      .finally(() => setAlertsLoading(false))
  }

  useEffect(() => {
    let active = true
    void getLoadRules()
      .then((next) => {
        if (!active) return
        setRules(next.rules)
        setRulesError("")
      })
      .catch((reason: Error) => {
        if (active) setRulesError(reason.message || "负载规则加载失败")
      })
      .finally(() => {
        if (active) setRulesLoading(false)
      })
    // Node names are part of the selector and table labels; refetch after a
    // node lifecycle change so deleted targets cannot stay in the form.
    return () => {
      active = false
    }
  }, [nodeIdentity])

  useEffect(() => {
    if (tab !== "alerts") return
    let active = true
    void getCurrentLoadAlerts()
      .then((next) => {
        if (!active) return
        setAlerts(next.alerts)
        setAlertsError("")
      })
      .catch((reason: Error) => {
        if (active) setAlertsError(reason.message || "当前告警加载失败")
      })
      .finally(() => {
        if (active) setAlertsLoading(false)
      })
    const timer = window.setInterval(refreshAlerts, 30_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [tab])

  async function removeRule() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteLoadRule(deleteTarget.id)
      toast.success("负载规则已删除")
      setDeleteTarget(null)
      refreshRules()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "负载规则删除失败")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">负载通知</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">按采样点时间占比监控 CPU、RAM、Disk 和网络流量，并管理当前告警。</p>
        </div>
        {tab === "rules" && (
          <Button type="button" onClick={() => { setEditingRule(null); setEditorOpen(true) }}>
            <Plus />
            新增负载通知
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1 border-b">
        <button type="button" onClick={() => setTab("rules")} className={`border-b-2 px-3 py-2 text-sm transition-colors ${tab === "rules" ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
          告警配置
        </button>
        <button type="button" onClick={() => { if (tab !== "alerts") { setAlertsLoading(true); setTab("alerts") } }} className={`border-b-2 px-3 py-2 text-sm transition-colors ${tab === "alerts" ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
          当前告警{alerts.length > 0 ? ` (${alerts.length})` : ""}
        </button>
        {tab === "alerts" && <Button type="button" size="icon-sm" variant="ghost" className="ml-auto" title="刷新当前告警" onClick={refreshAlerts} disabled={alertsLoading}><RefreshCw className={alertsLoading ? "animate-spin" : ""} /></Button>}
      </div>

      {tab === "rules" ? (
        <RuleList
          rules={rules}
          nodes={nodes}
          loading={rulesLoading}
          error={rulesError}
          onRefresh={refreshRules}
          onEdit={(rule) => { setEditingRule(rule); setEditorOpen(true) }}
          onDelete={setDeleteTarget}
        />
      ) : (
        <AlertList alerts={alerts} loading={alertsLoading} error={alertsError} onRefresh={refreshAlerts} onSilence={setSilenceTarget} />
      )}

      <RuleEditorDialog
        key={`${editorOpen ? "open" : "closed"}-${editingRule?.id ?? "new"}`}
        open={editorOpen}
        rule={editingRule}
        nodes={nodes}
        onOpenChange={(open) => {
          setEditorOpen(open)
          if (!open) setEditingRule(null)
        }}
        onSaved={refreshRules}
      />
      <DeleteRuleDialog rule={deleteTarget} busy={deleting} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }} onConfirm={() => void removeRule()} />
      <SilenceDialog
        key={silenceTarget ? `${silenceTarget.rule_id}-${silenceTarget.node_id}` : "closed"}
        alert={silenceTarget}
 onOpenChange={(open) => { if (!open) setSilenceTarget(null) }} onDone={refreshAlerts} />
    </div>
  )
}
