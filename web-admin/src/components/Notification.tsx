import { useEffect, useMemo, useState } from "react"
import { Send, Server } from "lucide-react"
import { toast } from "sonner"

import {
  getCommonNotificationSettings,
  getNotificationSettings,
  saveCommonNotificationSettings,
  saveNotificationSettings,
  sendTelegramTest,
  type CommonNotificationSettings as CommonNotificationSettingsData,
  type Node,
  type NotificationSettings as NotificationSettingsData,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

export function NotificationSettings() {
  const [settings, setSettings] = useState<NotificationSettingsData | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [botToken, setBotToken] = useState("")
  const [chatId, setChatId] = useState("")
  const [endpoint, setEndpoint] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    getNotificationSettings()
      .then((next) => {
        setSettings(next)
        setEnabled(next.enabled)
        setEndpoint(next.telegram_endpoint)
        setError("")
      })
      .catch((reason: Error) => setError(reason.message || "通知设置加载失败"))
      .finally(() => setLoading(false))
  }, [])

  async function save() {
    setSaving(true)
    try {
      const patch = {
        enabled,
        endpoint: endpoint.trim(),
        ...(botToken.trim() ? { bot_token: botToken.trim() } : {}),
        ...(chatId.trim() ? { chat_id: chatId.trim() } : {}),
      }
      const next = await saveNotificationSettings(patch)
      setSettings(next)
      setEnabled(next.enabled)
      setEndpoint(next.telegram_endpoint)
      setBotToken("")
      setChatId("")
      toast.success("通知设置已保存")
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "通知设置保存失败")
    } finally {
      setSaving(false)
    }
  }

  async function test() {
    setTesting(true)
    try {
      await sendTelegramTest()
      toast.success("测试消息已发送")
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "测试消息发送失败")
    } finally {
      setTesting(false)
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">加载通知设置…</p>
  if (error) return <p className="text-sm text-destructive" role="alert">{error}</p>

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">通知设置</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          配置 Telegram 通知渠道。Bot Token 只会写入服务器，不会从接口返回。
        </p>
      </div>

      <Card className="gap-5 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="notification-enabled">开启通知</Label>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              开启后，后续接入的通知事件才会使用 Telegram 渠道。
            </p>
          </div>
          <Switch
            id="notification-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={saving}
          />
        </div>

        <div className="border-t pt-5">
          <div className="mb-4">
            <h3 className="text-sm font-medium">Telegram 发送设置</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              测试消息会直接使用已保存的配置发送，不会因为通知开关关闭而假装发送成功。
            </p>
          </div>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="telegram-bot-token">Telegram Bot Token</Label>
              <Input
                id="telegram-bot-token"
                type="password"
                autoComplete="new-password"
                value={botToken}
                onChange={(event) => setBotToken(event.target.value)}
                placeholder={settings?.telegram_bot_token_set ? "已配置，留空保持不变" : "输入 Bot Token"}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                仅在需要替换 Token 时填写；当前 Token 不会回显。
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="telegram-chat-id">Chat ID</Label>
              <Input
                id="telegram-chat-id"
                value={chatId}
                onChange={(event) => setChatId(event.target.value)}
                placeholder={settings?.telegram_chat_id_masked || "输入 Chat ID"}
              />
              {settings?.telegram_chat_id_masked && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  当前值：{settings.telegram_chat_id_masked}；留空保持不变。
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="telegram-endpoint">请求端点</Label>
              <Input
                id="telegram-endpoint"
                type="url"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="https://api.telegram.org/bot"
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                仅允许 Telegram 官方端点 https://api.telegram.org/bot，不接受其它主机、凭据、查询参数或片段。
              </p>
            </div>

            <div className="flex flex-wrap gap-2 border-t pt-4">
              <Button type="submit" disabled={saving || testing}>
                {saving ? "保存中…" : "保存设置"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => void test()} disabled={testing || saving}>
                <Send />
                {testing ? "发送中…" : "发送测试消息"}
              </Button>
            </div>
          </form>
        </div>
      </Card>
    </div>
  )
}

export function CommonNotificationSettings() {
  const [settings, setSettings] = useState<CommonNotificationSettingsData | null>(null)
  const [renewEnabled, setRenewEnabled] = useState(false)
  const [expiryEnabled, setExpiryEnabled] = useState(false)
  const [expiryLeadDays, setExpiryLeadDays] = useState("7")
  const [expiryCheckTime, setExpiryCheckTime] = useState("00:00")
  const [trafficEnabled, setTrafficEnabled] = useState(false)
  const [trafficStartPercent, setTrafficStartPercent] = useState("80")
  const [loginEnabled, setLoginEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true
    getCommonNotificationSettings()
      .then((next) => {
        if (!active) return
        setSettings(next)
        setRenewEnabled(next.renew_enabled)
        setExpiryEnabled(next.expiry_enabled)
        setExpiryLeadDays(String(next.expiry_lead_days))
        setExpiryCheckTime(next.expiry_check_time)
        setTrafficEnabled(next.traffic_enabled)
        setTrafficStartPercent(String(next.traffic_start_percent))
        setLoginEnabled(next.login_enabled)
        setError("")
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message || "通用通知设置加载失败")
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  async function save() {
    const days = Number(expiryLeadDays.trim())
    const trafficStartPercentValue = Number(trafficStartPercent.trim())
    if (!Number.isInteger(days) || days < 0 || days > 365) {
      toast.error("过期提醒提前天数必须是 0 到 365 之间的整数")
      return
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(expiryCheckTime)) {
      toast.error("到期提醒检查时间必须是 00:00 到 23:59 之间的有效时间")
      return
    }
    if (!Number.isInteger(trafficStartPercentValue) || trafficStartPercentValue < 0 || trafficStartPercentValue > 100) {
      toast.error("流量提醒起始比例必须是 0 到 100 之间的整数")
      return
    }
    setSaving(true)
    try {
      const next = await saveCommonNotificationSettings({
        renew_enabled: renewEnabled,
        expiry_enabled: expiryEnabled,
        expiry_lead_days: days,
        expiry_check_time: expiryCheckTime,
        traffic_enabled: trafficEnabled,
        traffic_start_percent: trafficStartPercentValue,
        login_enabled: loginEnabled,
      })
      setSettings(next)
      setRenewEnabled(next.renew_enabled)
      setExpiryEnabled(next.expiry_enabled)
      setExpiryLeadDays(String(next.expiry_lead_days))
      setExpiryCheckTime(next.expiry_check_time)
      setTrafficEnabled(next.traffic_enabled)
      setTrafficStartPercent(String(next.traffic_start_percent))
      setLoginEnabled(next.login_enabled)
      toast.success("通用通知设置已保存")
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "通用通知设置保存失败")
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">加载通用通知设置…</p>
  if (error) return <p className="text-sm text-destructive" role="alert">{error}</p>

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">通用通知</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          配置到期、流量用量和后台登录等通用事件。所有消息仍受“通知设置”中的全局 Telegram 开关控制。
        </p>
      </div>

      {!settings?.global_enabled && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          当前全局通知开关已关闭，下面的规则会保存但不会发送 Telegram 消息。
        </p>
      )}

      <Card className="gap-5 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="common-renew-enabled">在线过期自动顺延提醒</Label>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">在线节点过期并成功顺延日期后发送一次。</p>
          </div>
          <Switch id="common-renew-enabled" checked={renewEnabled} onCheckedChange={setRenewEnabled} disabled={saving} />
        </div>

        <div className="border-t pt-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="common-expiry-enabled">服务到期提醒</Label>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">每天聚合发送一次，包含进入提醒范围且尚未到期的服务器。</p>
            </div>
            <Switch id="common-expiry-enabled" checked={expiryEnabled} onCheckedChange={setExpiryEnabled} disabled={saving} />
          </div>
          <div className="mt-4 max-w-xs space-y-2">
            <Label htmlFor="common-expiry-lead-days">提前多少天开始提醒</Label>
            <Input
              id="common-expiry-lead-days"
              type="number"
              min={0}
              max={365}
              step={1}
              value={expiryLeadDays}
              onChange={(event) => setExpiryLeadDays(event.target.value)}
              disabled={saving}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              设置在到期前多少天开始发送提醒；范围 0–365 天，0 表示只在到期当天提醒；没有到期日的服务器不会提醒。
            </p>
          </div>

          <div className="mt-4 max-w-xs space-y-2">
            <Label htmlFor="common-expiry-check-time">每天检查时间（UTC+8）</Label>
            <Input
              id="common-expiry-check-time"
              type="time"
              step={60}
              value={expiryCheckTime}
              onChange={(event) => setExpiryCheckTime(event.target.value)}
              disabled={saving}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              每天到达该时间后检查一次并发送聚合提醒；服务晚于该时间启动会当天补查。
            </p>
          </div>
        </div>

        <div className="border-t pt-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="common-traffic-enabled">流量提醒</Label>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                流量达到设定比例后发送通知，并按 5% 梯度持续提醒；使用比例按当前计费周期的有效额度计算。服务器未设置流量阈值时不发送通知；设置为 0 可关闭流量提醒。
              </p>
            </div>
            <Switch id="common-traffic-enabled" checked={trafficEnabled} onCheckedChange={setTrafficEnabled} disabled={saving} />
          </div>
          <div className="mt-4 max-w-xs space-y-2">
            <Label htmlFor="common-traffic-start-percent">首次提醒比例（0–100%）</Label>
            <Input
              id="common-traffic-start-percent"
              type="number"
              min={0}
              max={100}
              step={1}
              value={trafficStartPercent}
              onChange={(event) => setTrafficStartPercent(event.target.value)}
              disabled={saving}
              inputMode="numeric"
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              只有“流量提醒”开关开启且节点设置了有效流量额度时才会发送；比例为 0 时不会发送。
            </p>
          </div>
        </div>

        <div className="border-t pt-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="common-login-enabled">后台登录通知</Label>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">密码或 GitHub 创建新的登录会话后发送，消息包含登录 IP 和登录方式。</p>
            </div>
            <Switch id="common-login-enabled" checked={loginEnabled} onCheckedChange={setLoginEnabled} disabled={saving} />
          </div>
        </div>

        <div className="border-t pt-4">
          <Button type="button" onClick={() => void save()} disabled={saving || !settings}>
            {saving ? "保存中…" : "保存设置"}
          </Button>
        </div>
      </Card>
    </div>
  )
}

export function NotificationPlaceholder({ title }: { title: string }) {
  return (
    <Card className="gap-3 p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">该通知功能暂未实现。</p>
    </Card>
  )
}

export function OfflineNotificationSettings({ nodes }: { nodes: Node[] }) {
  const [settings, setSettings] = useState<NotificationSettingsData | null>(null)
  const [offlineEnabled, setOfflineEnabled] = useState(true)
  const [onlineEnabled, setOnlineEnabled] = useState(true)
  const [delaySeconds, setDelaySeconds] = useState("180")
  const [excludedNodeIds, setExcludedNodeIds] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [serverOpen, setServerOpen] = useState(false)
  const [serverQuery, setServerQuery] = useState("")
  const [workingExcludedNodeIds, setWorkingExcludedNodeIds] = useState<number[]>([])
  const nodeIdentity = nodes.map((node) => `${node.id}:${node.name}`).join("|")
  const visibleServerNodes = useMemo(() => {
    const needle = serverQuery.trim().toLowerCase()
    if (!needle) return nodes
    return nodes.filter((node) => node.name.toLowerCase().includes(needle) || String(node.id).includes(needle))
  }, [nodes, serverQuery])

  useEffect(() => {
    let active = true
    getNotificationSettings()
      .then((next) => {
        if (!active) return
        setSettings(next)
        setOfflineEnabled(next.offline_enabled)
        setOnlineEnabled(next.online_enabled)
        setDelaySeconds(String(next.offline_delay_seconds))
        setExcludedNodeIds(next.excluded_node_ids)
        setError("")
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message || "离线通知设置加载失败")
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [nodeIdentity])

  async function save() {
    const delay = Number(delaySeconds.trim())
    if (!Number.isInteger(delay) || delay < 0 || delay > 86400) {
      toast.error("离线宽限期必须是 0 到 86400 秒之间的整数")
      return
    }
    const availableNodeIds = new Set(nodes.map((node) => node.id))
    const validExcludedNodeIds = excludedNodeIds.filter((id) => availableNodeIds.has(id))
    if (validExcludedNodeIds.length !== excludedNodeIds.length) {
      setExcludedNodeIds(validExcludedNodeIds)
    }
    setSaving(true)
    try {
      const next = await saveNotificationSettings({
        offline_enabled: offlineEnabled,
        online_enabled: onlineEnabled,
        offline_delay_seconds: delay,
        excluded_node_ids: validExcludedNodeIds,
      })
      setSettings(next)
      setOfflineEnabled(next.offline_enabled)
      setOnlineEnabled(next.online_enabled)
      setDelaySeconds(String(next.offline_delay_seconds))
      setExcludedNodeIds(next.excluded_node_ids)
      toast.success("离线通知设置已保存")
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "离线通知设置保存失败")
    } finally {
      setSaving(false)
    }
  }

  function openServerSelector() {
    setWorkingExcludedNodeIds([...excludedNodeIds])
    setServerQuery("")
    setServerOpen(true)
  }

  function toggleWorkingExcludedNode(nodeId: number) {
    setWorkingExcludedNodeIds((current) =>
      current.includes(nodeId)
        ? current.filter((id) => id !== nodeId)
        : [...current, nodeId].sort((a, b) => a - b),
    )
  }

  function selectAllWorkingNodes() {
    setWorkingExcludedNodeIds(nodes.map((node) => node.id).sort((a, b) => a - b))
  }

  function completeServerSelection() {
    setExcludedNodeIds([...workingExcludedNodeIds].sort((a, b) => a - b))
    setServerOpen(false)
  }

  if (loading) return <p className="text-sm text-muted-foreground">加载离线通知设置…</p>
  if (error) return <p className="text-sm text-destructive" role="alert">{error}</p>

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">离线通知</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          节点断开后先等待宽限期；宽限期内恢复不会发送消息，持续离线后只发送一次离线通知，恢复连接时发送一次上线通知。
        </p>
      </div>

      <Card className="gap-5 p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="offline-notification-enabled">发送离线通知</Label>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">需要同时开启“通知设置”中的全局通知开关。</p>
          </div>
          <Switch
            id="offline-notification-enabled"
            checked={offlineEnabled}
            onCheckedChange={setOfflineEnabled}
            disabled={saving}
          />
        </div>

        <div className="border-t pt-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="online-notification-enabled">发送上线恢复通知</Label>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">只有已经发送过离线通知的节点恢复时才会发送。</p>
            </div>
            <Switch
              id="online-notification-enabled"
              checked={onlineEnabled}
              onCheckedChange={setOnlineEnabled}
              disabled={saving}
            />
          </div>
        </div>

        <div className="border-t pt-5">
          <Label htmlFor="offline-delay-seconds">离线宽限期（秒）</Label>
          <Input
            id="offline-delay-seconds"
            className="mt-2 max-w-xs"
            type="number"
            min={0}
            max={86400}
            step={1}
            value={delaySeconds}
            onChange={(event) => setDelaySeconds(event.target.value)}
            disabled={saving}
          />
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            默认 180 秒，范围 0–86400 秒。设置为 0 表示连接释放后立即进入离线通知。
          </p>
        </div>

        <div className="border-t pt-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <Label>服务器排除</Label>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                选中的服务器不会发送离线或上线恢复通知；节点采集和在线状态不受影响。
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={openServerSelector}
              disabled={saving}
            >
              <Server />
              选择服务器（{excludedNodeIds.length}）
            </Button>
          </div>
          <div className="flex min-h-10 flex-wrap gap-2 rounded-lg border bg-muted/20 p-2">
            {excludedNodeIds.map((nodeId) => {
              const node = nodes.find((item) => item.id === nodeId)
              return <Badge key={nodeId} variant="secondary">{node?.name ?? `ID ${nodeId}`}</Badge>
            })}
            {excludedNodeIds.length === 0 && <span className="p-1 text-sm text-muted-foreground">尚未选择服务器</span>}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            当前已排除 {excludedNodeIds.length} 个节点。
          </p>
        </div>

        <div className="border-t pt-4">
          <Button type="button" onClick={() => void save()} disabled={saving || !settings}>
            {saving ? "保存中…" : "保存设置"}
          </Button>
        </div>
      </Card>

      <Dialog open={serverOpen} onOpenChange={setServerOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>选择服务器</DialogTitle>
            <DialogDescription>选择不发送离线或上线恢复通知的服务器。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={serverQuery}
              onChange={(event) => setServerQuery(event.target.value)}
              placeholder="搜索服务器名称或 ID"
              className="min-w-52 flex-1"
              disabled={saving}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={selectAllWorkingNodes}
              disabled={saving || nodes.length === 0}
            >
              全选
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setWorkingExcludedNodeIds([])}
              disabled={saving || workingExcludedNodeIds.length === 0}
            >
              清空
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            已选择 {workingExcludedNodeIds.length} / {nodes.length} 台服务器
          </div>
          <div className="max-h-80 space-y-1 overflow-y-auto rounded-lg border bg-muted/20 p-2">
            {visibleServerNodes.map((node) => {
              const checked = workingExcludedNodeIds.includes(node.id)
              return (
                <label
                  key={node.id}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 hover:bg-background"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleWorkingExcludedNode(node.id)}
                    disabled={saving}
                    aria-label={`选择 ${node.name}`}
                    className="accent-primary"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm">
                      <span className="truncate">{node.name}</span>
                      <Badge variant={node.online ? "online" : "offline"} className="shrink-0 border-transparent">
                        {node.online ? "在线" : "离线"}
                      </Badge>
                    </span>
                    <span className="tnum block text-xs text-muted-foreground">ID: {node.id}</span>
                  </span>
                </label>
              )
            })}
            {visibleServerNodes.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">
                {nodes.length === 0 ? "暂无服务器，请先添加服务器" : "没有匹配的服务器"}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setServerOpen(false)} disabled={saving}>取消</Button>
            <Button type="button" onClick={completeServerSelection} disabled={saving}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
