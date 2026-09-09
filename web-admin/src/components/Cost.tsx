import { useEffect, useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getFxSnapshot, refreshFxSnapshot, type FxSnapshot, type FxStatus, type Node } from "@/lib/api"
import { CYCLES, money } from "@/lib/format"

const CYCLE_MONTHS: Record<string, number | null> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  yearly: 12,
  biennial: 24,
  triennial: 36,
  once: null,
}

type DisplayCurrency = "CNY" | "USD"
type ExpiryFilter = "all" | "7" | "30" | "90"

const DISPLAY_CURRENCY_KEY = "monitor:admin:cost:display-currency"
const PAGE_SIZE_OPTIONS = [10, 20, 50] as const

type CostStatus = "free" | "active" | "soon" | "expired" | "unconfigured"

type CostRow = {
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

type DisplayCostRow = CostRow & {
  displayMonthly: number | null
  displayYearly: number | null
}

type BudgetTotals = {
  monthly: number
  yearly: number
  convertedNodes: number
  skippedNodes: number
}

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

function statusVariant(status: CostStatus) {
  if (status === "expired" || status === "unconfigured") return "destructive" as const
  if (status === "soon") return "outline" as const
  return "secondary" as const
}

function fxStatusVariant(status: FxStatus) {
  if (status === "unavailable" || status === "expired") return "destructive" as const
  if (status === "cached") return "outline" as const
  return "secondary" as const
}

function expiry(node: Node): { status: CostStatus; label: string; daysLeft: number | null } {
  if (!node.price || node.price < 0) return { status: "free", label: "免费", daysLeft: null }
  if (!node.expires_at) return { status: "active", label: "长期有效", daysLeft: null }

  const date = new Date(`${node.expires_at}T23:59:59`)
  if (Number.isNaN(date.getTime())) return { status: "active", label: "日期无效", daysLeft: null }
  const daysLeft = Math.ceil((date.getTime() - Date.now()) / 86_400_000)
  if (daysLeft < 0) return { status: "expired", label: "已过期", daysLeft }
  if (daysLeft <= 7) return { status: "soon", label: `${daysLeft} 天内到期`, daysLeft }
  return { status: "active", label: `${daysLeft} 天后到期`, daysLeft }
}

function rowFor(node: Node): CostRow {
  const price = Number.isFinite(node.price) && node.price > 0 ? node.price : 0
  const months = CYCLE_MONTHS[node.billing_cycle]
  const status = expiry({ ...node, price })
  const configured = price > 0 && months !== undefined
  return {
    node,
    currency: node.currency.trim().toUpperCase() || "未设置",
    price,
    monthly: configured && months ? price / months : null,
    yearly: configured && months ? price * 12 / months : null,
    cycle: CYCLES[node.billing_cycle] ?? "未知周期",
    status: configured ? status.status : price === 0 ? "free" : "unconfigured",
    expiry: configured ? status.label : price === 0 ? "不计费" : "无法折算",
    daysLeft: configured ? status.daysLeft : null,
  }
}

function convertAmount(
  amount: number,
  sourceCurrency: string,
  targetCurrency: DisplayCurrency,
  rates: Record<string, number>,
): number | null {
  const source = sourceCurrency.trim().toUpperCase()
  if (!Number.isFinite(amount) || amount < 0) return null
  if (source === targetCurrency) return amount

  const sourceRate = rates[source]
  const targetRate = rates[targetCurrency]
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) return null
  return amount * targetRate / sourceRate
}

function matchesExpiry(row: CostRow, filter: ExpiryFilter) {
  if (filter === "all") return true
  const days = row.daysLeft
  return days !== null && days >= 0 && days <= Number(filter)
}

function fxTime(fetchedAt: string | null) {
  if (!fetchedAt) return "暂无抓取时间"
  const date = new Date(fetchedAt)
  return Number.isNaN(date.getTime()) ? "时间无效" : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })
}

export function Cost({ nodes }: { nodes: Node[] }) {
  const [query, setQuery] = useState("")
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>(() =>
    localStorage.getItem(DISPLAY_CURRENCY_KEY) === "USD" ? "USD" : "CNY",
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
    getFxSnapshot()
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
      setFx(await refreshFxSnapshot())
    } catch (error) {
      setFxError((error as Error).message || "汇率服务暂不可用")
    } finally {
      setFxRefreshing(false)
    }
  }

  const rows = useMemo(() => nodes.map(rowFor), [nodes])
  const paidRows = useMemo(
    () => rows.filter((row) => row.price > 0 && row.node.billing_cycle !== "once"),
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
  const budget = useMemo<BudgetTotals>(() => {
    let monthly = 0
    let yearly = 0
    let convertedNodes = 0
    let skippedNodes = 0

    for (const row of displayRows) {
      if (row.monthly === null || row.yearly === null) continue
      if (row.displayMonthly === null || row.displayYearly === null) {
        skippedNodes += 1
        continue
      }
      monthly += row.displayMonthly
      yearly += row.displayYearly
      convertedNodes += 1
    }
    return { monthly, yearly, convertedNodes, skippedNodes }
  }, [displayRows])
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
            <CardTitle className="text-base">预算汇总</CardTitle>
            <CardDescription className="mt-1">汇率以 USD 为基准，仅用于预算汇总，不改写节点原始价格。</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">汇总币种</span>
            <Select
              value={displayCurrency}
              onValueChange={(value) => {
                const next = value === "USD" ? "USD" : "CNY"
                setDisplayCurrency(next)
                localStorage.setItem(DISPLAY_CURRENCY_KEY, next)
              }}
            >
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="CNY">CNY</SelectItem>
                <SelectItem value="USD">USD</SelectItem>
              </SelectContent>
            </Select>
            <span className="ml-2 text-sm font-medium">最新汇率</span>
            <Badge variant={fxStatusVariant(fxStatus)}>{fxLoading ? "读取中…" : FX_STATUS_LABELS[fxStatus]}</Badge>
            <span className="text-xs text-muted-foreground">· {fxTime(fx?.fetched_at ?? null)}</span>
            <Button variant="outline" size="sm" onClick={refreshRates} disabled={fxRefreshing}>
              <RefreshCw className={fxRefreshing ? "animate-spin" : ""} />
              {fxRefreshing ? "刷新中…" : "刷新汇率"}
            </Button>
          </div>
        </div>
        {fxError && <p role="alert" className="text-sm text-destructive">{fxError}</p>}
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="gap-3 py-4">
          <CardHeader className="px-5 pb-0"><CardDescription>付费节点数</CardDescription><CardTitle>{paidRows.length}</CardTitle></CardHeader>
        </Card>
        <Card className="gap-3 py-4">
          <CardHeader className="px-5 pb-0"><CardDescription>月均预算 · {displayCurrency}</CardDescription><CardTitle className="text-base">{budget.convertedNodes ? money(budget.monthly, displayCurrency) : "—"}</CardTitle></CardHeader>
          <CardContent className="px-5 pt-0 text-xs text-muted-foreground">
            {budget.skippedNodes ? <span className="text-destructive">{budget.skippedNodes} 个节点缺少有效汇率，未计入</span> : budget.convertedNodes ? "已统一换算" : "没有可计入的周期性价格"}
          </CardContent>
        </Card>
        <Card className="gap-3 py-4">
          <CardHeader className="px-5 pb-0"><CardDescription>年度预算 · {displayCurrency}</CardDescription><CardTitle className="text-base">{budget.convertedNodes ? money(budget.yearly, displayCurrency) : "—"}</CardTitle></CardHeader>
          <CardContent className="px-5 pt-0 text-xs text-muted-foreground">
            {budget.skippedNodes ? <span className="text-destructive">{budget.skippedNodes} 个节点缺少有效汇率，未计入</span> : budget.convertedNodes ? "已统一换算" : "没有可计入的周期性价格"}
          </CardContent>
        </Card>
        <Card className="gap-3 py-4">
          <CardHeader className="px-5 pb-0"><CardDescription>7天内到期</CardDescription><CardTitle>{expiringSoon}</CardTitle></CardHeader>
          <CardContent className="px-5 pt-0 text-xs text-muted-foreground">未来 7 天内到期的付费节点</CardContent>
        </Card>
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="border-b px-5 py-4">
          <CardTitle className="text-base">节点计划成本</CardTitle>
          <CardDescription>仅显示付费且非一次性节点；当前价格保留原币种，月均和年度预算按所选币种显示。</CardDescription>
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
        </CardHeader>
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
                <TableCell><Badge variant={statusVariant(row.status)}>{STATUS_LABELS[row.status]}</Badge></TableCell>
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
              size="icon-sm"
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
              size="icon-sm"
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
