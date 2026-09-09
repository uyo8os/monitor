import { useMemo, useState } from "react"
import { CircleDollarSign } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { type Node } from "@/lib/api"
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

type CurrencyTotal = {
  currency: string
  monthly: number
  yearly: number
  nodes: number
}

const STATUS_LABELS: Record<CostStatus, string> = {
  free: "免费",
  active: "有效",
  soon: "即将到期",
  expired: "已过期",
  unconfigured: "未配置",
}

function statusVariant(status: CostStatus) {
  if (status === "expired" || status === "unconfigured") return "destructive" as const
  if (status === "soon") return "outline" as const
  return "secondary" as const
}

function expiry(node: Node): { status: CostStatus; label: string; daysLeft: number | null } {
  if (!node.price || node.price < 0) return { status: "free", label: "免费", daysLeft: null }
  if (!node.expires_at) return { status: "active", label: "长期有效", daysLeft: null }

  const date = new Date(`${node.expires_at}T23:59:59`)
  if (Number.isNaN(date.getTime())) return { status: "active", label: "日期无效", daysLeft: null }
  const daysLeft = Math.ceil((date.getTime() - Date.now()) / 86_400_000)
  if (daysLeft < 0) return { status: "expired", label: "已过期", daysLeft }
  if (daysLeft <= 30) return { status: "soon", label: `${daysLeft} 天内到期`, daysLeft }
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

function totalsText(totals: CurrencyTotal[], field: "monthly" | "yearly") {
  if (!totals.length) return "—"
  return totals.map((total) => money(total[field], total.currency)).join(" · ")
}

export function Cost({ nodes }: { nodes: Node[] }) {
  const [query, setQuery] = useState("")
  const [currency, setCurrency] = useState("all")
  const [status, setStatus] = useState<CostStatus | "all">("all")

  const rows = useMemo(() => nodes.map(rowFor), [nodes])
  const currencies = useMemo(
    () => [...new Set(rows.map((row) => row.currency))].sort((a, b) => a.localeCompare(b)),
    [rows],
  )
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return rows.filter((row) => {
      const matchesQuery = !needle || [row.node.name, row.node.hostname, row.node.remark, row.currency, row.cycle]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle))
      return matchesQuery && (currency === "all" || row.currency === currency) && (status === "all" || row.status === status)
    })
  }, [currency, query, rows, status])
  const totals = useMemo(() => {
    const grouped = new Map<string, CurrencyTotal>()
    for (const row of rows) {
      if (row.monthly === null || row.yearly === null) continue
      const current = grouped.get(row.currency) ?? { currency: row.currency, monthly: 0, yearly: 0, nodes: 0 }
      current.monthly += row.monthly
      current.yearly += row.yearly
      current.nodes += 1
      grouped.set(row.currency, current)
    }
    return [...grouped.values()].sort((a, b) => a.currency.localeCompare(b.currency))
  }, [rows])
  const expiring = rows.filter((row) => row.status === "soon" || row.status === "expired").length
  const unconfigured = rows.filter((row) => row.status === "unconfigured").length

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <CircleDollarSign className="size-5" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">成本</h1>
          <p className="text-sm text-muted-foreground">
            根据节点当前价格和计费周期估算计划预算；不同币种分别统计，不包含账单分录、汇率或额外费用。
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="gap-3 py-4">
          <CardHeader className="px-5 pb-0"><CardDescription>节点数</CardDescription><CardTitle>{rows.length}</CardTitle></CardHeader>
        </Card>
        <Card className="gap-3 py-4">
          <CardHeader className="px-5 pb-0"><CardDescription>月均预算</CardDescription><CardTitle className="text-base">{totalsText(totals, "monthly")}</CardTitle></CardHeader>
        </Card>
        <Card className="gap-3 py-4">
          <CardHeader className="px-5 pb-0"><CardDescription>年度预算</CardDescription><CardTitle className="text-base">{totalsText(totals, "yearly")}</CardTitle></CardHeader>
        </Card>
        <Card className="gap-3 py-4">
          <CardHeader className="px-5 pb-0"><CardDescription>到期/配置提醒</CardDescription><CardTitle>{expiring + unconfigured}</CardTitle></CardHeader>
          <CardContent className="px-5 pt-0 text-xs text-muted-foreground">到期 {expiring} · 未配置 {unconfigured}</CardContent>
        </Card>
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="border-b px-5 py-4">
          <CardTitle className="text-base">节点计划成本</CardTitle>
          <CardDescription>月均/年度金额只对周期性价格计算，一次性费用单独标记。</CardDescription>
          <div className="flex flex-col gap-2 pt-2 sm:flex-row">
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索节点、币种或计费周期" className="sm:max-w-xs" />
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger className="sm:w-36"><SelectValue placeholder="全部币种" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部币种</SelectItem>
                {currencies.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(value) => setStatus(value as CostStatus | "all")}>
              <SelectTrigger className="sm:w-36"><SelectValue placeholder="全部状态" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {(Object.keys(STATUS_LABELS) as CostStatus[]).map((value) => <SelectItem key={value} value={value}>{STATUS_LABELS[value]}</SelectItem>)}
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
              <TableHead>月均预算</TableHead>
              <TableHead>年度预算</TableHead>
              <TableHead>到期</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((row) => (
              <TableRow key={row.node.id}>
                <TableCell>
                  <div className="font-medium">{row.node.name}</div>
                  {row.node.remark && <div className="max-w-56 truncate text-xs text-muted-foreground">{row.node.remark}</div>}
                </TableCell>
                <TableCell><Badge variant={statusVariant(row.status)}>{STATUS_LABELS[row.status]}</Badge></TableCell>
                <TableCell className="tnum">{money(row.price, row.currency)}</TableCell>
                <TableCell>{row.cycle}</TableCell>
                <TableCell className="tnum">{row.monthly === null ? "—" : money(row.monthly, row.currency)}</TableCell>
                <TableCell className="tnum">{row.yearly === null ? "—" : money(row.yearly, row.currency)}</TableCell>
                <TableCell className="text-muted-foreground">{row.expiry}</TableCell>
              </TableRow>
            ))}
            {!filtered.length && (
              <TableRow><TableCell colSpan={7} className="py-12 text-center text-sm text-muted-foreground">没有符合条件的节点</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        <div className="border-t px-5 py-3 text-xs text-muted-foreground">
          已显示 {filtered.length} / {rows.length} 个节点；一次性费用和未知周期不会纳入月均、年度预算。
        </div>
      </Card>
    </div>
  )
}
