import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  KINDS, batchSubscriptions, currencyAmount, errorMessage, renewSubscriptions, saveSubscription, subscriptionHistory, targetOf,
  type BatchAction, type CycleUnit, type RenewalHistory, type RenewalPreview, type RenewalRequest, type Subscription, type SubscriptionKind, type SubscriptionPlan,
} from "@/lib/subscriptions"

export const SELECT_STYLE = "h-9 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm shadow-xs focus-visible:outline-2 focus-visible:outline-ring"
const CHECKBOX_STYLE = "size-4 shrink-0 accent-primary"
const AMOUNT_PATTERN = "[0-9]{1,12}([.][0-9]{1,4})?"
const POPULAR_CURRENCIES = ["CNY", "USD", "HKD", "EUR", "GBP", "JPY", "SGD", "AUD", "CAD", "CHF", "KRW", "TWD", "INR", "MYR", "THB", "AED", "BRL", "MXN"]
const currencies = [...new Set([...POPULAR_CURRENCIES, ...Intl.supportedValuesOf("currency")])]
const currencyNames = new Intl.DisplayNames(["zh-CN"], { type: "currency" })

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`grid content-start gap-1.5 text-sm ${wide ? "sm:col-span-2" : ""}`}>
      <span className="font-medium">{label}</span>
      {children}
    </label>
  )
}

function Categories({ id, categories }: { id: string; categories: string[] }) {
  return <datalist id={id}>{categories.map((category) => <option key={category} value={category} />)}</datalist>
}

type DialogProps = { onClose: () => void; onSaved: () => void }

export function SubscriptionEditor({ item, today, categories, onClose, onSaved }: DialogProps & {
  item: Subscription | null; today: string; categories: string[]
}) {
  const categoryId = useId()
  const currencyId = useId()
  const [form, setForm] = useState<SubscriptionPlan>(() => item ?? {
    name: "", category: "", kind: "recurring", cycle: { count: 1, unit: "months" }, due_on: null,
    purchased_on: today, anchor_day: null, month_end: false, amount: "", currency: "CNY", enabled: true,
    reminder_days: [7, 3, 0], overdue_reminder: false, notes: "",
  })
  const [reminders, setReminders] = useState(() => form.reminder_days.toSorted((a, b) => b - a).join(", "))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const once = form.kind === "one_time"
  const cycle = form.cycle ?? { count: 1, unit: "months" as const }
  const calendarAnchor = form.kind === "recurring" && cycle.unit !== "days"

  const change = <K extends keyof SubscriptionPlan,>(key: K, value: SubscriptionPlan[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  function changeKind(kind: SubscriptionKind) {
    setForm((current) => ({
      ...current,
      kind,
      purchased_on: current.purchased_on ?? today,
      cycle: kind === "keep_number" ? { count: 90, unit: "days" } : { count: 1, unit: "months" },
      anchor_day: null,
      month_end: false,
      overdue_reminder: kind === "keep_number",
    }))
    setReminders((current) => current || "7, 3, 0")
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setError("")
    const days = once || !reminders.trim() ? [] : reminders.trim().split(/[,，\s]+/)
    if (days.some((day) => !/^\d{1,3}$/.test(day) || Number(day) > 365) || days.length > 20) {
      setError("提醒日请输入 0 到 365 的整数，最多 20 个，用逗号或空格分隔。")
      return
    }
    setBusy(true)
    try {
      const plan: SubscriptionPlan = {
        ...form,
        cycle: once ? null : cycle,
        anchor_day: calendarAnchor ? form.anchor_day : null,
        due_on: once ? null : form.due_on,
        purchased_on: once ? form.purchased_on : null,
        month_end: calendarAnchor && form.month_end,
        reminder_days: days.map(Number),
      }
      await saveSubscription(plan, item ?? undefined)
      onSaved()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{item ? "编辑订阅" : "新增订阅"}</DialogTitle>
          <DialogDescription>选择续费方式并填写当前账单信息。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <fieldset disabled={busy} className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            <Field label="名称"><Input required maxLength={100} value={form.name} onChange={(e) => change("name", e.target.value)} placeholder="例如：备用 SIM 卡" /></Field>
            <Field label="分类"><Input list={categoryId} maxLength={50} value={form.category} onChange={(e) => change("category", e.target.value)} placeholder="例如：通信" /></Field>
            <Categories id={categoryId} categories={categories} />
            <Field label="类型">
              <select className={SELECT_STYLE} value={form.kind} onChange={(e) => changeKind(e.target.value as SubscriptionKind)}>
                {Object.entries(KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            {once
              ? <Field label="购买日期"><Input required type="date" min="1900-01-01" max={today} value={form.purchased_on ?? ""} onChange={(e) => change("purchased_on", e.target.value || null)} /></Field>
              : <Field label="当前到期日"><Input required type="date" min="1900-01-01" max="9999-12-31" value={form.due_on ?? ""} onChange={(e) => change("due_on", e.target.value || null)} /></Field>}
            {!once && (
              <>
                <Field label="周期长度"><Input required type="number" min={1} max={cycle.unit === "days" ? 3650 : cycle.unit === "months" ? 120 : 10} value={cycle.count || ""} onChange={(e) => change("cycle", { ...cycle, count: Number(e.target.value) })} /></Field>
                <Field label="周期单位">
                  <select className={SELECT_STYLE} value={cycle.unit} onChange={(e) => change("cycle", { ...cycle, unit: e.target.value as CycleUnit })}>
                    <option value="days">天</option><option value="months">月</option><option value="years">年</option>
                  </select>
                </Field>
                {calendarAnchor && (
                  <>
                    <Field label="固定账单日">
                      <Input type="number" min={1} max={31} disabled={form.month_end} value={form.anchor_day ?? ""} placeholder={form.due_on ? String(Number(form.due_on.slice(-2))) : "按当前到期日"} onChange={(e) => change("anchor_day", e.target.value ? Number(e.target.value) : null)} />
                    </Field>
                    <label className="flex items-center gap-2 self-end py-2.5 text-sm">
                      <input type="checkbox" className={CHECKBOX_STYLE} checked={form.month_end} onChange={(e) => change("month_end", e.target.checked)} />
                      使用目标月份的最后一天
                    </label>
                  </>
                )}
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  {form.kind === "keep_number" ? "每次保号从实际付款日重算，提前或过期付款都适用。" : "周期订阅从原到期日顺延。固定账单日遇短月临时取月末，下个月仍按原账单日。"}
                </p>
              </>
            )}
            <Field label={once ? "买断金额" : "每期金额"}><Input required inputMode="decimal" pattern={AMOUNT_PATTERN} value={form.amount} onChange={(e) => change("amount", e.target.value)} placeholder="0.00" /></Field>
            <Field label="币种"><Input required list={currencyId} minLength={3} maxLength={3} pattern="[A-Za-z]{3}" value={form.currency} onChange={(e) => change("currency", e.target.value.toUpperCase())} /></Field>
            <datalist id={currencyId}>{currencies.map((currency) => <option key={currency} value={currency}>{currencyNames.of(currency)}</option>)}</datalist>
            {!once && (
              <>
                <Field label="到期前提醒天数" wide><Input value={reminders} onChange={(e) => setReminders(e.target.value)} placeholder="7, 3, 0" /><span className="text-xs text-muted-foreground">逗号分隔。0 表示到期当天，留空关闭提前提醒。</span></Field>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" className={CHECKBOX_STYLE} checked={form.overdue_reminder} onChange={(e) => change("overdue_reminder", e.target.checked)} />逾期后提醒一次</label>
              </>
            )}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className={CHECKBOX_STYLE} checked={form.enabled} onChange={(e) => change("enabled", e.target.checked)} />启用</label>
            <Field label="备注" wide><textarea className="min-h-16 rounded-md border border-input bg-background px-3 py-2 text-sm" maxLength={1000} value={form.notes} onChange={(e) => change("notes", e.target.value)} placeholder="例如：账号尾号、续费方式" /></Field>
          </fieldset>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            <Button type="submit" disabled={busy}>{busy ? "保存中…" : "保存"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function RenewalDialog({ items, today, onClose, onSaved }: DialogProps & { items: Subscription[]; today: string }) {
  const [paid, setPaid] = useState(today)
  const [periods, setPeriods] = useState("1")
  const [amounts, setAmounts] = useState<Record<number, string>>({})
  const [preview, setPreview] = useState<{ request: RenewalRequest; rows: RenewalPreview[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const request = preview?.request ?? {
      paid_on: paid,
      periods: Number(periods),
      items: items.map((item) => ({ ...targetOf(item), amount: amounts[item.id]?.trim() || undefined })),
    }
    setBusy(true)
    setError("")
    try {
      const result = await renewSubscriptions(request, !preview)
      if (preview) onSaved()
      else setPreview({ request, rows: result.items })
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>登记续费{items.length > 1 ? ` · ${items.length} 项` : ""}</DialogTitle>
          <DialogDescription>记录已完成的付款，并更新下次续费日。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {!preview ? (
            <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
              <Field label="实际付款日"><Input type="date" required value={paid} onChange={(e) => setPaid(e.target.value)} min="1900-01-01" max={today} /></Field>
              <Field label="续费周期数"><Input type="number" required min={1} max={120} value={periods} onChange={(e) => setPeriods(e.target.value)} /></Field>
              <div className="max-h-56 divide-y overflow-y-auto rounded-md border sm:col-span-2">
                {items.map((item) => (
                  <label key={item.id} className="grid min-w-0 grid-cols-[1fr_8rem] items-center gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 break-words">{item.name}<span className="block text-xs text-muted-foreground">实付金额 · {item.currency}</span></span>
                    <Input inputMode="decimal" pattern={AMOUNT_PATTERN} placeholder="按周期计算" value={amounts[item.id] ?? ""} onChange={(e) => setAmounts({ ...amounts, [item.id]: e.target.value })} />
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
              {preview.rows.map((row) => (
                <li key={row.id} className="flex flex-wrap justify-between gap-2 p-3 text-sm">
                  <div className="min-w-0 break-words"><p className="font-medium">{row.name}</p><p className="text-xs text-muted-foreground">{row.previous_due} → {row.next_due}</p>
                    {row.next_due < today && <p className="text-xs text-destructive">登记后仍逾期，可返回调整周期数。</p>}
                    {row.next_due < row.previous_due && <p className="text-xs text-amber-700 dark:text-amber-300">本次保号会提早原到期日。</p>}
                  </div>
                  <span className="whitespace-nowrap tabular-nums">{currencyAmount(row.amount, row.currency)}</span>
                </li>
              ))}
            </ul>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={preview ? () => { setPreview(null); setError("") } : onClose}>{preview ? "返回修改" : "取消"}</Button>
            <Button type="submit" disabled={busy}>{busy ? "处理中…" : preview ? "确认登记" : "预览新日期"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export const BATCH_LABELS: Record<BatchAction, string> = { enable: "启用", disable: "停用", category: "改分类", delete: "删除" }

export function SubscriptionBatchDialog({ action, items, categories, onClose, onSaved }: DialogProps & {
  action: BatchAction; items: Subscription[]; categories: string[]
}) {
  const categoryId = useId()
  const [category, setCategory] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const label = BATCH_LABELS[action]
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await batchSubscriptions(action, items, category)
      onSaved()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label} {items.length} 项订阅</DialogTitle>
          <DialogDescription>
            {action === "delete" ? "删除后将一并清除这些订阅的续费记录。" :
              action === "category" ? "输入新分类。留空会移到「未分类」。" :
              action === "disable" ? "停用后暂停提醒，保留到期日和续费历史。" : "启用后按当前到期日和设置发送提醒。"}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          {action === "category" && <><Field label="新分类"><Input list={categoryId} maxLength={50} value={category} onChange={(e) => setCategory(e.target.value)} disabled={busy} /></Field><Categories id={categoryId} categories={categories} /></>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
            <Button type="submit" variant={action === "delete" ? "destructive" : "default"} disabled={busy}>{busy ? "处理中…" : `确认${label}`}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function SubscriptionHistory({ item, onClose }: { item: Subscription; onClose: () => void }) {
  const [history, setHistory] = useState<RenewalHistory[] | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    let active = true
    subscriptionHistory(item.id).then((result) => {
      if (active) setHistory(result.history)
    }).catch((reason: unknown) => { if (active) setError(errorMessage(reason)) })
    return () => { active = false }
  }, [item.id])
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>续费历史</DialogTitle>
          <DialogDescription>{item.name}</DialogDescription>
        </DialogHeader>
        {item.notes && <p className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">{item.notes}</p>}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : !history?.length ? (
          <p className="text-sm text-muted-foreground">{history ? "还没有登记过续费。" : "加载中…"}</p>
        ) : (
          <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
            {history.map((entry) => (
              <li key={entry.id} className="flex flex-wrap justify-between gap-2 p-3 text-sm">
                <div><p>{entry.paid_on} · {entry.periods} 个周期</p><p className="text-xs text-muted-foreground">{entry.previous_due} → {entry.next_due}</p></div>
                <span className="tabular-nums">{currencyAmount(entry.amount, entry.currency)}</span>
              </li>
            ))}
          </ul>
        )}
        {history?.length === 100 && <p className="text-xs text-muted-foreground">显示最近 100 笔记录。</p>}
      </DialogContent>
    </Dialog>
  )
}
