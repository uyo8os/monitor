import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowUp, GripVertical, MoreHorizontal, Plus, Search } from "lucide-react"
import { Popover as PopoverPrimitive } from "radix-ui"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent } from "@/components/ui/popover"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  KINDS, STATUSES, currencyAmount, cycleLabel, daysLeft, dueStatus, errorMessage, listSubscriptions, reorderSubscriptions,
  type BatchAction, type DueStatus, type Subscription, type SubscriptionKind, type SubscriptionList,
} from "@/lib/subscriptions"
import {
  BATCH_LABELS, RenewalDialog, SELECT_STYLE, SubscriptionBatchDialog, SubscriptionEditor, SubscriptionHistory,
} from "@/pages/SubscriptionDialogs"

const PAGE_SIZE = 20
const CHECKBOX_STYLE = "size-4 align-middle accent-primary"
const BADGES: Record<DueStatus, string> = {
  late: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  today: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  soon: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  active: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-300",
  bought: "bg-muted text-muted-foreground",
  paused: "bg-muted text-muted-foreground",
}
const SUMMARY = [
  { value: "late", tone: "text-red-700 dark:text-red-400" },
  { value: "today", tone: "text-amber-700 dark:text-amber-400" },
  { value: "soon", tone: "text-foreground" },
] as const
const ACTIONS: BatchAction[] = ["enable", "disable", "category", "delete"]

type Editor = { kind: "edit"; item: Subscription | null }
  | { kind: "renew"; items: Subscription[] }
  | { kind: "batch"; action: BatchAction; items: Subscription[] }
  | { kind: "history"; item: Subscription }

function RowActions({ item, show }: { item: Subscription; show: (editor: Editor) => void }) {
  const [open, setOpen] = useState(false)
  function launch(editor: Editor) {
    setOpen(false)
    show(editor)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <Button type="button" size="icon" variant="ghost" aria-label={`${item.name}的操作`}><MoreHorizontal /></Button>
      </PopoverPrimitive.Trigger>
      <PopoverContent align="end" className="grid w-36 gap-0.5 p-1">
        <Button variant="ghost" className="justify-start" onClick={() => launch({ kind: "edit", item })}>编辑</Button>
        {item.kind !== "one_time" && <Button variant="ghost" className="justify-start" onClick={() => launch({ kind: "history", item })}>续费历史</Button>}
        <Button variant="ghost" className="justify-start" onClick={() => launch({ kind: "batch", action: item.enabled ? "disable" : "enable", items: [item] })}>
          {item.enabled ? "停用" : "启用"}
        </Button>
        <Button variant="ghost" className="justify-start text-destructive" onClick={() => launch({ kind: "batch", action: "delete", items: [item] })}>删除</Button>
      </PopoverContent>
    </Popover>
  )
}

export function Subscriptions() {
  const [data, setData] = useState<SubscriptionList | null>(null)
  const [loadError, setLoadError] = useState("")
  const request = useRef(0)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const seq = ++request.current
    try {
      const result = await listSubscriptions(signal)
      if (seq === request.current) { setData(result); setLoadError("") }
    } catch (reason) {
      if (!signal?.aborted && seq === request.current) setLoadError(errorMessage(reason))
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    const reload = () => { if (!controller.signal.aborted) void refresh(controller.signal) }
    queueMicrotask(reload)
    const timer = window.setInterval(reload, 60_000)
    window.addEventListener("focus", reload)
    return () => {
      controller.abort()
      window.removeEventListener("focus", reload)
      window.clearInterval(timer)
    }
  }, [refresh])

  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("all")
  const [kind, setKind] = useState<SubscriptionKind | "all">("all")
  const [status, setStatus] = useState<DueStatus | "all">("all")
  const [order, setOrder] = useState<"date" | "manual">("date")
  const [page, setPage] = useState(1)
  const [selection, setSelection] = useState<Set<number>>(() => new Set())
  const [editor, setEditor] = useState<Editor | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const [ordering, setOrdering] = useState(false)
  const canDrag = order === "manual" && !ordering
  const items = data?.items ?? []
  const today = data?.today ?? ""
  const categories = [...new Set(items.map((item) => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"))
  const tallies = { late: 0, today: 0, soon: 0 }
  for (const item of items) {
    const state = dueStatus(item, today)
    if (state === "late" || state === "today" || state === "soon") tallies[state]++
  }
  const needle = query.trim().toLowerCase()
  const matching = items.filter((item) =>
    (category === "all" || item.category === category.slice(1))
    && (kind === "all" || item.kind === kind)
    && (status === "all" || dueStatus(item, today) === status)
    && (!needle || [item.name, item.category, item.currency, item.notes].some((value) => value.toLowerCase().includes(needle))),
  )
  const dateKey = (item: Subscription) => item.enabled && item.due_on ? item.due_on : "9999-99-99"
  const sorted = order === "manual" ? matching : matching.toSorted((a, b) => dateKey(a).localeCompare(dateKey(b)))
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages)
  const visible = order === "manual" ? sorted : sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const selected = visible.filter((item) => selection.has(item.id))
  const renewable = selected.filter((item) => !!item.due_on)
  const allSelected = visible.length > 0 && selected.length === visible.length
  const filtersActive = !!needle || category !== "all" || kind !== "all" || status !== "all"

  function resetPage() { setPage(1); setSelection(new Set()) }
  function showUrgency(next: DueStatus) {
    setStatus(status === next ? "all" : next)
    resetPage()
  }
  function toggleItem(id: number) {
    setSelection((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function done(message: string) {
    setEditor(null)
    setSelection(new Set())
    toast.success(message)
    void refresh()
  }

  async function move(from: number, to: number) {
    setDragging(null)
    setDropTarget(null)
    if (!canDrag || from === to) return
    const previous = items.map((item) => item.id)
    const ids = [...previous]
    const fromIndex = ids.indexOf(from)
    const toIndex = ids.indexOf(to)
    if (fromIndex === -1 || toIndex === -1) return
    ids.splice(fromIndex, 1)
    ids.splice(toIndex, 0, from)
    // Keep hidden rows at the same positions when filtering the manual list.
    const matchingIds = new Set(matching.map((item) => item.id))
    const reordered = ids.filter((id) => matchingIds.has(id))
    let cursor = 0
    const next = previous.map((id) => matchingIds.has(id) ? reordered[cursor++] : id)
    setOrdering(true)
    try {
      await reorderSubscriptions(next, previous)
      await refresh()
    } catch (reason) {
      toast.error(errorMessage(reason))
      void refresh()
    } finally {
      setOrdering(false)
    }
  }

  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">订阅管理</h2>
          <p className="mt-1 text-sm text-muted-foreground">管理定期订阅、一次性买断和号码保号。</p>
        </div>
        <Button disabled={!data} onClick={() => setEditor({ kind: "edit", item: null })}><Plus />新增订阅</Button>
      </header>

      {loadError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
          <span className="text-destructive">{loadError}</span><Button variant="outline" size="sm" onClick={() => void refresh()}>重试</Button>
        </div>
      )}
      {!data ? (!loadError && <p role="status" className="text-sm text-muted-foreground">正在加载订阅…</p>) : (
        <>
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {SUMMARY.map(({ value, tone }) => (
              <button key={value} type="button" aria-pressed={status === value} onClick={() => showUrgency(value)}
                className={`grid gap-1 rounded-xl border px-3 py-3 text-left hover:bg-muted/50 sm:px-5 ${status === value ? "border-primary bg-muted/30" : "bg-card"}`}>
                <span className="text-xs font-medium text-muted-foreground sm:text-sm">{STATUSES[value]}</span>
                <span className={`text-2xl font-semibold tabular-nums ${tone}`}>{tallies[value]}</span>
              </button>
            ))}
          </div>
          {!data.notifications_configured && (
            <p className="text-sm text-muted-foreground">在「通知」中配置 Telegram 或 Webhook 后，即可接收续费提醒。</p>
          )}

          <div className="grid grid-cols-2 gap-2 lg:grid-cols-[minmax(10rem,1fr)_repeat(4,minmax(0,9rem))]">
            <div className="relative col-span-2 min-w-0 lg:col-span-1">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
              <Input className="pl-8" aria-label="搜索订阅" placeholder="搜索订阅" value={query} onChange={(e) => { setQuery(e.target.value); resetPage() }} />
            </div>
            <select aria-label="分类" className={SELECT_STYLE} value={category} onChange={(e) => { setCategory(e.target.value); resetPage() }}>
              <option value="all">全部分类</option><option value="=">未分类</option>
              {categories.map((name) => <option value={`=${name}`} key={name}>{name}</option>)}
            </select>
            <select aria-label="类型" className={SELECT_STYLE} value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); resetPage() }}>
              <option value="all">全部类型</option>
              {Object.entries(KINDS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
            <select aria-label="状态" className={SELECT_STYLE} value={status} onChange={(e) => { setStatus(e.target.value as typeof status); resetPage() }}>
              <option value="all">全部状态</option>
              {Object.entries(STATUSES).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
            <select aria-label="排序" className={SELECT_STYLE} value={order} onChange={(e) => { setOrder(e.target.value as typeof order); resetPage() }}>
              <option value="date">按到期时间</option><option value="manual">手动排序</option>
            </select>
          </div>

          {selected.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-2">
              <span className="px-1 text-sm">已选 {selected.length} 项</span>
              <Button size="sm" disabled={renewable.length === 0 || renewable.length > 500} onClick={() => setEditor({ kind: "renew", items: renewable })}>
                批量续费{renewable.length < selected.length ? `（${renewable.length} 项）` : ""}
              </Button>
              {ACTIONS.map((action) => <Button key={action} size="sm" variant="outline" disabled={selected.length > 500}
                onClick={() => setEditor({ kind: "batch", action, items: selected })}>{BATCH_LABELS[action]}</Button>)}
              <Button size="sm" variant="ghost" onClick={() => setSelection(new Set())}>清空选择</Button>
              {selected.length > 500 && <span className="text-xs text-muted-foreground">每次最多操作 500 项。</span>}
            </div>
          )}

          <Card className="gap-0 overflow-hidden py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  {order === "manual" && <TableHead><span className="sr-only">手动排序</span></TableHead>}
                  <TableHead><input aria-label="选择当前列表" type="checkbox" className={CHECKBOX_STYLE} checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = selected.length > 0 && !allSelected }}
                    disabled={!visible.length} onChange={() => setSelection(allSelected ? new Set() : new Set(visible.map((item) => item.id)))} /></TableHead>
                  <TableHead>名称</TableHead><TableHead>分类</TableHead><TableHead>续费方式</TableHead>
                  <TableHead>本期金额</TableHead><TableHead>下次续费</TableHead><TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((item, index) => {
                  const state = dueStatus(item, today)
                  return (
                    <TableRow key={item.id} data-state={selection.has(item.id) ? "selected" : undefined}
                      className={dropTarget === item.id && dragging !== item.id ? "bg-accent" : undefined}
                      onDragOver={(event) => { if (canDrag && dragging !== null) { event.preventDefault(); setDropTarget(item.id) } }}
                      onDrop={(event) => { if (canDrag && dragging !== null) { event.preventDefault(); void move(dragging, item.id) } }}>
                      {order === "manual" && (
                        <TableCell>
                          <div className="flex items-center text-muted-foreground">
                            <span draggable={canDrag} className="hidden cursor-grab sm:inline-flex" title="拖拽排序"
                              onDragStart={(event) => {
                                event.dataTransfer.effectAllowed = "move"
                                event.dataTransfer.setData("text/plain", String(item.id))
                                setDragging(item.id)
                              }}
                              onDragEnd={() => { setDragging(null); setDropTarget(null) }}>
                              <GripVertical className="size-4" />
                            </span>
                            <Button size="icon" className="size-7" variant="ghost" aria-label={`上移 ${item.name}`} disabled={!canDrag || index === 0}
                              onClick={() => void move(item.id, visible[index - 1].id)}><ArrowUp /></Button>
                            <Button size="icon" className="size-7" variant="ghost" aria-label={`下移 ${item.name}`} disabled={!canDrag || index === visible.length - 1}
                              onClick={() => void move(item.id, visible[index + 1].id)}><ArrowDown /></Button>
                          </div>
                        </TableCell>
                      )}
                      <TableCell><input type="checkbox" className={CHECKBOX_STYLE} aria-label={`选择 ${item.name}`} checked={selection.has(item.id)} onChange={() => toggleItem(item.id)} /></TableCell>
                      <TableCell className="max-w-52 whitespace-normal break-words font-medium">{item.name}</TableCell>
                      <TableCell className="max-w-36 whitespace-normal break-words text-muted-foreground">{item.category || "未分类"}</TableCell>
                      <TableCell>{cycleLabel(item)}</TableCell>
                      <TableCell className="tabular-nums">{currencyAmount(item.amount, item.currency)}</TableCell>
                      <TableCell className={`tabular-nums ${state === "late" ? SUMMARY[0].tone : state === "today" ? SUMMARY[1].tone : ""}`}>{item.due_on ?? "—"}</TableCell>
                      <TableCell><span className={`inline-flex rounded-md px-2 py-1 text-xs font-medium ${BADGES[state]}`}>
                        {state === "soon" && item.due_on ? `${daysLeft(item.due_on, today)} 天后到期` : STATUSES[state]}
                      </span></TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {item.due_on && <Button size="sm" onClick={() => setEditor({ kind: "renew", items: [item] })}>续费</Button>}
                          <RowActions item={item} show={setEditor} />
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {!visible.length && (
                  <TableRow><TableCell colSpan={order === "manual" ? 9 : 8} className="h-28 text-center text-muted-foreground">
                    {filtersActive ? "没有符合筛选条件的订阅。" : "还没有订阅。添加第一条记录后，即可开始管理续费。"}
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
            {visible.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground sm:px-4">
                <span>共 {sorted.length} 项{order === "manual" && (ordering ? " · 正在保存顺序…" : " · 拖拽或使用箭头调整顺序")}</span>
                {order !== "manual" && pages > 1 && (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" disabled={currentPage === 1} onClick={() => { setPage(currentPage - 1); setSelection(new Set()) }}>上一页</Button>
                    <span>{currentPage} / {pages}</span>
                    <Button size="sm" variant="outline" disabled={currentPage === pages} onClick={() => { setPage(currentPage + 1); setSelection(new Set()) }}>下一页</Button>
                  </div>
                )}
              </div>
            )}
          </Card>
        </>
      )}
      {editor?.kind === "edit" && <SubscriptionEditor item={editor.item} today={today} categories={categories} onClose={() => setEditor(null)} onSaved={() => done("订阅已保存")} />}
      {editor?.kind === "renew" && <RenewalDialog items={editor.items} today={today} onClose={() => setEditor(null)} onSaved={() => done("续费已登记")} />}
      {editor?.kind === "batch" && <SubscriptionBatchDialog items={editor.items} action={editor.action} categories={categories} onClose={() => setEditor(null)} onSaved={() => done("订阅已更新")} />}
      {editor?.kind === "history" && <SubscriptionHistory item={editor.item} onClose={() => setEditor(null)} />}
    </section>
  )
}
