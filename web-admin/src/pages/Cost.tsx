import { useEffect, useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, type Node } from "@/lib/api"
import { money } from "@/lib/format"
import { budgetTotals, convertAmount, matchesExpiry, rowFor, type CostStatus, type DisplayCostRow } from "@/lib/cost"

type FxStatus = "latest" | "cached" | "expired" | "unavailable"
type FxSnapshot = {
  status: FxStatus
  fetched_at: string | null
  rates: Record<string, number>
}

type DisplayCurrency = "CNY" | "USD"
type ExpiryFilter = "all" | "7" | "30" | "90"

const DISPLAY_CURRENCY_KEY = "monitor:admin:cost:display-currency"
const PAGE_SIZE_OPTIONS = [10, 20, 50] as const

const STATUS_LABELS: Record<CostStatus, string> = {
  free: "免费",
  active: "有效",
  soon: "即将到期",
  expired: "已过期",
  unconfigured: "未配置",
}

const FX_STATUS_LABELS: Record<FxStatus, string> = {
  latest: "最新",
  cached: "已缓存",
  expired: "已过期",
  unavailable: "暂不可用",
}

function fxTime(fetchedAt: string | null) {
  if (!fetchedAt) return "暂无抓取时间"
  const date = new Date(fetchedAt)
  return Number.isNaN(date.getTime()) ? "时间无效" : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })
}

export function Cost({ nodes }: { nodes: Node[] }) {
  const [query, setQuery] = useState("")
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>(() =>
    (() => { try { return localStorage.getItem(DISPLAY_CURRENCY_KEY) === "USD" ? "USD" : "CNY" } catch { return "CNY" } })(),
  )
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>("all")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [fx, setFx] = useState<FxSnapshot | null>(null)
  const [fxLoading, setFxLoading] = useState(true)
  const [fxRefreshing, setFxRefreshing] = useState(false)
  const [fxError, setFxError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api<FxSnapshot>("/cost/fx")
      .then((snapshot) => {
        if (active) {
          setFx(snapshot)
          setFxError(null)
        }
      })
      .catch((error: Error) => {
        if (active) setFxError(error.message || "汇率服务暂不可用")
      })
      .finally(() => {
        if (active) setFxLoading(false)
      })
    return () => { active = false }
  }, [])

  async function refreshRates() {
    setFxRefreshing(true)
    setFxError(null)
    try {
      setFx(await api<FxSnapshot>("/cost/fx/refresh", { method: "POST" }))
    } catch (error) {
      setFxError((error as Error).message || "汇率服务暂不可用")
    } finally {
      setFxRefreshing(false)
    }
  }

  const rows = useMemo(() => nodes.map(rowFor), [nodes])
  const paidRows = useMemo(
    () => rows.filter((row) => row.price > 0 && row.cycle !== "一次性"),
    [rows],
  )
  const displayRows = useMemo<DisplayCostRow[]>(() => {
    const rates = fx?.status === "latest" || fx?.status === "cached" ? fx.rates : {}
    return paidRows.map((row) => ({
      ...row,
      displayMonthly: row.monthly === null ? null : convertAmount(row.monthly, row.currency, displayCurrency, rates),
      displayYearly: row.yearly === null ? null : convertAmount(row.yearly, row.currency, displayCurrency, rates),
    }))
  }, [displayCurrency, fx, paidRows])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return displayRows.filter((row) => {
      const matchesQuery = !needle || [row.node.name, row.node.hostname, row.node.remark, row.currency, row.cycle]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle))
      return matchesQuery && matchesExpiry(row, expiryFilter)
    })
  }, [displayRows, expiryFilter, query])
  const budget = useMemo(() => budgetTotals(displayRows), [displayRows])
  const expiringSoon = paidRows.filter((row) => row.daysLeft !== null && row.daysLeft >= 0 && row.daysLeft <= 7).length
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const pageRows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const rangeStart = filtered.length ? (currentPage - 1) * pageSize + 1 : 0
  const rangeEnd = Math.min(currentPage * pageSize, filtered.length)
  const fxStatus = fx?.status ?? "unavailable"

  return (
    <div className="space-y-5">
      <Card className="gap-4 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="text-base font-medium">预算汇总</h3>
            <p className="mt-1 text-sm text-muted-foreground">汇率以 USD 为基准，仅用于预算汇总，不改写节点原始价格。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">汇总币种</span>
            <Select
              value={displayCurrency}
              onValueChange={(value) => {
                const next = value === "USD" ? "USD" : "CNY"
                setDisplayCurrency(next)
                try { localStorage.setItem(DISPLAY_CURRENCY_KEY, next) } catch { /* Keep the choice for this visit. */ }
              }}
            >
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="CNY">CNY</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
              </SelectContent>
            </Select>
            <span className="ml-2 text-sm font-medium">最新汇率</span>
            <Badge variant={fxStatus === "latest" ? "secondary" : "outline"}>{fxLoading ? "读取中…" : FX_STATUS_LABELS[fxStatus]}</Badge>
            <span className="text-xs text-muted-foreground">· {fxTime(fx?.fetched_at ?? null)}</span>
            <Button variant="outline" size="sm" onClick={refreshRates} disabled={fxLoading || fxRefreshing}>
              <RefreshCw className={fxRefreshing ? "animate-spin" : ""} />
              {fxRefreshing ? "刷新中…" : "刷新汇率"}
            </Button>
          </div>
        </div>
        {fxError && <p role="alert" className="text-sm text-destructive">{fxError}</p>}
        {!fxLoading && fxStatus === "unavailable" && !fxError && <p className="text-sm text-muted-foreground">暂无汇率，请点击“刷新汇率”获取。相同币种的价格仍可计入预算。</p>}
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="gap-3 py-4">
          <div className="px-5 pb-0"><p className="text-sm text-muted-foreground">付费节点数</p><div className="text-base font-medium">{paidRows.length}</div></div>
        </Card>
        <Card className="gap-3 py-4">
          <div className="px-5 pb-0"><p className="text-sm text-muted-foreground">月均预算 · {displayCurrency}</p><div className="text-base font-medium">{budget.convertedNodes ? money(budget.monthly, displayCurrency) : "—"}</div></div>
          <div className="px-5 pt-0 text-xs text-muted-foreground">
            {budget.missingRates || budget.invalidCycles ? <span className="text-destructive">{budget.missingRates ? `${budget.missingRates} 个节点缺少有效汇率` : ""}{budget.missingRates && budget.invalidCycles ? "；" : ""}{budget.invalidCycles ? `${budget.invalidCycles} 个节点的计费周期无法识别` : ""}，未计入</span> : budget.convertedNodes ? "已统一换算" : "没有可计入的周期性价格"}
          </div>
        </Card>
        <Card className="gap-3 py-4">
          <div className="px-5 pb-0"><p className="text-sm text-muted-foreground">年度预算 · {displayCurrency}</p><div className="text-base font-medium">{budget.convertedNodes ? money(budget.yearly, displayCurrency) : "—"}</div></div>
          <div className="px-5 pt-0 text-xs text-muted-foreground">
            {budget.missingRates || budget.invalidCycles ? <span className="text-destructive">{budget.missingRates ? `${budget.missingRates} 个节点缺少有效汇率` : ""}{budget.missingRates && budget.invalidCycles ? "；" : ""}{budget.invalidCycles ? `${budget.invalidCycles} 个节点的计费周期无法识别` : ""}，未计入</span> : budget.convertedNodes ? "已统一换算" : "没有可计入的周期性价格"}
          </div>
        </Card>
        <Card className="gap-3 py-4">
          <div className="px-5 pb-0"><p className="text-sm text-muted-foreground">7天内到期</p><div className="text-base font-medium">{expiringSoon}</div></div>
          <div className="px-5 pt-0 text-xs text-muted-foreground">未来 7 天内到期的付费节点</div>
        </Card>
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        <div className="border-b px-5 py-4">
          <h3 className="text-base font-medium">节点计划成本</h3>
          <p className="text-sm text-muted-foreground">仅显示付费且非一次性节点；当前价格保留原币种，月均和年度预算按所选币种显示。</p>
          <div className="flex flex-col gap-2 pt-2 sm:flex-row">
            <Input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(1)
              }}
              placeholder="搜索节点、币种或计费周期"
              className="sm:max-w-xs"
            />
            <Select
              value={expiryFilter}
              onValueChange={(value) => {
                setExpiryFilter(value as ExpiryFilter)
                setPage(1)
              }}
            >
              <SelectTrigger className="sm:w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部到期时间</SelectItem>
                <SelectItem value="7">7天内</SelectItem>
                <SelectItem value="30">30天内</SelectItem>
                <SelectItem value="90">90天内</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>节点</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>当前价格</TableHead>
              <TableHead>计费周期</TableHead>
              <TableHead>月均预算 · {displayCurrency}</TableHead>
              <TableHead>年度预算 · {displayCurrency}</TableHead>
              <TableHead>到期</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((row) => (
              <TableRow key={row.node.id}>
                <TableCell>
                  <div className="font-medium">{row.node.name}</div>
                  {row.node.remark && <div className="max-w-56 truncate text-xs text-muted-foreground">{row.node.remark}</div>}
                </TableCell>
                <TableCell><Badge variant={row.status === "active" ? "secondary" : "outline"} className={row.status === "expired" || row.status === "unconfigured" ? "text-destructive" : row.status === "soon" ? "text-amber-600 dark:text-amber-400" : undefined}>{STATUS_LABELS[row.status]}</Badge></TableCell>
                <TableCell className="tnum">{money(row.price, row.currency)}</TableCell>
                <TableCell>{row.cycle}</TableCell>
                <TableCell className="tnum">
                  {row.monthly === null ? "—" : row.displayMonthly === null ? <span className="text-destructive">不可用</span> : money(row.displayMonthly, displayCurrency)}
                </TableCell>
                <TableCell className="tnum">
                  {row.yearly === null ? "—" : row.displayYearly === null ? <span className="text-destructive">不可用</span> : money(row.displayYearly, displayCurrency)}
                </TableCell>
                <TableCell className="text-muted-foreground">{row.expiry}</TableCell>
              </TableRow>
            ))}
            {!pageRows.length && (
              <TableRow><TableCell colSpan={7} className="py-12 text-center text-sm text-muted-foreground">没有符合条件的付费节点</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        <div className="flex flex-col gap-3 border-t px-5 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>已显示 {rangeStart}-{rangeEnd} / {filtered.length} 个付费节点</span>
          <div className="flex items-center gap-2">
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                setPageSize(Number(value) || 10)
                setPage(1)
              }}
            >
              <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((size) => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}
              </SelectContent>
            </Select>
            <span>条/页</span>
            <Button
              type="button"
              variant="outline"
              size="icon" className="size-8"
              aria-label="上一页"
              disabled={currentPage <= 1}
              onClick={() => setPage(Math.max(1, currentPage - 1))}
            >
              <ChevronLeft />
            </Button>
            <span className="tnum min-w-10 text-center">{currentPage} / {pageCount}</span>
            <Button
              type="button"
              variant="outline"
              size="icon" className="size-8"
              aria-label="下一页"
              disabled={currentPage >= pageCount}
              onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
