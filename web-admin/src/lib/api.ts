import { useEffect, useState } from "react"

export type Metrics = {
  uptime: number
  cpu: number
  load: [number, number, number]
  mem_total: number
  mem_used: number
  swap_total: number
  swap_used: number
  disk_total: number
  disk_used: number
  net_rx: number
  net_tx: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  tcp: number
  udp: number
  procs: number
}

export type Node = {
  id: number
  name: string
  sort: number
  public: boolean
  online: boolean
  last_seen: number
  metrics: Metrics | null
  os: string
  kernel: string
  arch: string
  virt: string
  cpu_name: string
  cpu_cores: number
  mem_total: number
  swap_total: number
  disk_total: number
  agent_version: string
  price: number
  currency: string
  billing_cycle: string
  expires_at: string | null
  traffic_limit: number
  traffic_mode: string
  traffic_reset_day: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  month_start: string
  /** Panel only. */
  hostname?: string
  /** ISO 3166-1 alpha-2, looked up from the address the agent connects from. */
  country: string
  ip?: string
  ipv4?: string
  ipv6?: string
  remark?: string
  /** Panel only. Empty for nodes created before the hub kept a copy. */
  token?: string
}

export type FxStatus = "latest" | "cached" | "expired" | "unavailable"

export type FxSnapshot = {
  status: FxStatus
  provider: string
  base_currency: string
  fetched_at: string | null
  rates: Record<string, number>
}

export type PingTask = { id: number; name: string; target: string; interval: number; nodes: number[] }

/** Form snapshots must never overwrite fields the user did not edit. */
export function changes<T extends object>(initial: T, values: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== initial[key as keyof T])) as Partial<T>
}

export const GIB = 1024 ** 3

/**
 * The traffic boxes as a `TrafficPatch`: GB typed by hand, bytes on the wire,
 * and only the counters that were actually given a number.
 *
 * An emptied box means "leave this one alone", not "set it to zero". The patch
 * is all `Option` and `set_traffic` COALESCEs, so omitting the key is how that
 * is said; sending 0 clears a lifetime total, which is the one figure that may
 * never go backwards and that nothing can recompute. Zeroing on purpose stays
 * one keystroke away: type 0.
 */
export function trafficCorrection(
  pristine: Record<string, string>,
  typed: Record<string, string>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(changes(pristine, typed))
      .filter(([, value]) => String(value).trim() !== "")
      .map(([key, value]) => [key, Math.round(Number(value) * GIB)]),
  )
}

/** Installation commands require a TLS origin with a domain, except local Vite development. */
const LOCAL_DEV = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true

export function provisioningSite(site: string, allowLocal = LOCAL_DEV): string {
  try {
    const u = new URL(site)
    const clean = !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash
    const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1"
    if (allowLocal && u.protocol === "http:" && loopback && clean) return u.origin
    return u.protocol === "https:" && !u.hostname.startsWith("[") && !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)
      && u.hostname !== "localhost" && !u.hostname.endsWith(".localhost") && clean ? u.origin : ""
  } catch {
    return ""
  }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init?.headers } : init?.headers,
  })
  if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText)
  return res.status === 204 ? (undefined as T) : res.json()
}

export function getFxSnapshot() {
  return api<FxSnapshot>("/cost/fx")
}

export function refreshFxSnapshot() {
  return api<FxSnapshot>("/cost/fx/refresh", { method: "POST" })
}

export type NotificationSettings = {
  enabled: boolean
  telegram_bot_token_set: boolean
  telegram_chat_id_masked: string
  telegram_endpoint: string
}

export type NotificationSettingsPatch = {
  enabled: boolean
  bot_token?: string
  chat_id?: string
  endpoint: string
}

export function getNotificationSettings() {
  return api<NotificationSettings>("/notification/settings")
}

export function saveNotificationSettings(patch: NotificationSettingsPatch) {
  return api<NotificationSettings>("/notification/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  })
}

export function sendTelegramTest() {
  return api<{ ok: boolean }>("/notification/telegram/test", { method: "POST" })
}

/**
 * 4 MiB. The only number a reverse proxy has to pass, whatever the file behind
 * it weighs -- the hub accepts up to 8 MiB per request, so this can move
 * without touching the server or agreeing on it first.
 */
const CHUNK = 4 * 1024 * 1024

/**
 * Uploads a file one chunk at a time. There is no upload id: the hub tracks an
 * upload by the length of what it has already written, so a chunk simply says
 * where it starts. The last one carries the answer.
 */
export async function upload<T>(
  path: string,
  file: File,
  onProgress?: (sent: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  if (file.size === 0) throw new ApiError(400, "文件是空的")
  let last: Response | null = null
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    // A chunk boundary is a real stopping point: the hub applies nothing until
    // the last piece lands, and `offset = 0` truncates whatever an abandoned
    // attempt left behind, so giving up here leaves it exactly as it was.
    if (signal?.aborted) throw new DOMException("aborted", "AbortError")
    const res = await fetch(`/api${path}?offset=${offset}&total=${file.size}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file.slice(offset, offset + CHUNK),
      signal,
    })
    if (!res.ok) {
      // A 413 never reached the hub -- the proxy in front of it answered, and
      // its own logs are the only place that shows up. Name the setting.
      throw new ApiError(
        res.status,
        res.status === 413
          ? "反向代理拒收了 4 MiB 的分片，把 nginx 的 client_max_body_size 调到 8m"
          : (await res.text()) || res.statusText,
      )
    }
    last = res
    onProgress?.(Math.min(offset + CHUNK, file.size))
  }
  return last!.json()
}

/**
 * Live node list. Uses the WebSocket the hub pushes every two seconds and
 * falls back to polling if it cannot be established.
 */
export function useNodes() {
  const [nodes, setNodes] = useState<Node[] | null>(null)
  // null until a frame says. The panel treats an explicit false as "this session
  // is no longer an admin one", so an unanswered first fetch must not read as
  // that -- see App.tsx.
  const [admin, setAdmin] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let socket: WebSocket | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false

    const fetchOnce = () =>
      api<{ nodes: Node[]; admin: boolean }>("/nodes")
        .then((d) => {
          setNodes(d.nodes)
          setAdmin(d.admin)
          setError(null)
        })
        .catch((e: Error) => {
          setError(e.message)
          // With the public page switched off a revoked session gets a 401 here
          // and on the stream, so the frame that would have said admin=false
          // never arrives and the panel would sit on the list it already had.
          if (e instanceof ApiError && e.status === 401) setAdmin(false)
        })

    fetchOnce()

    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`
    // A hub restart closes every stream. Without reconnecting, a page that
    // outlives one deploy spends the rest of its life on the fallback poll,
    // refreshing at a fifth of the live rate with nothing to say so.
    const connect = () => {
      try {
        socket = new WebSocket(url)
      } catch {
        poll ??= setInterval(fetchOnce, 5000)
        return
      }
      socket.onmessage = (event) => {
        const frame = JSON.parse(event.data)
        setNodes(frame.nodes)
        setAdmin(frame.admin)
        setError(null)
        // The stream is back; the poll was only covering for it.
        if (poll) {
          clearInterval(poll)
          poll = null
        }
      }
      socket.onerror = () => socket?.close()
      socket.onclose = () => {
        if (closed) return
        poll ??= setInterval(fetchOnce, 5000)
        retry = setTimeout(connect, 5000)
      }
    }
    connect()

    return () => {
      closed = true
      socket?.close()
      if (poll) clearInterval(poll)
      if (retry) clearTimeout(retry)
    }
  }, [reload])

  return { nodes, admin, error, refresh: () => setReload((n) => n + 1) }
}
