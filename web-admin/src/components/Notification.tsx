import { useEffect, useState } from "react"
import { Send } from "lucide-react"
import { toast } from "sonner"

import {
  getNotificationSettings,
  saveNotificationSettings,
  sendTelegramTest,
  type NotificationSettings as NotificationSettingsData,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
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

export function NotificationPlaceholder({ title }: { title: string }) {
  return (
    <Card className="gap-3 p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">该通知功能暂未实现。</p>
    </Card>
  )
}
