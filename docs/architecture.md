# 架构

```
┌──────────────┐   WebSocket + JSON-RPC 2.0    ┌─────────────────────┐   HTTP + WS   ┌─────────┐
│    agent     │ ─── Authorization: Bearer ──▶ │        hub          │ ◀──────────── │ 浏览器  │
│  (Linux VPS) │ ◀──── ping.tasks 下发 ─────── │  axum + SQLite      │               │ React   │
└──────────────┘                               │ 后台内置 / 主题可换 │               └─────────┘
   读 /proc                                    └─────────────────────┘
   无状态                                          monitor.db
```

## 三个仓库

| 仓库 | 内容 |
|---|---|
| **monitor**（本仓库） | hub + 内置后台 + `install.sh` |
| **[agent](https://github.com/monitor-agent)** | Linux agent。发布自己的 musl 二进制，`install.sh` 从那边的 release 拉 |
| **[monitor-theme-default](https://github.com/uyo8os/monitor-theme-default)** | 默认公开页主题。**发布构建产物**（`theme.tar.gz` = `dist/` + `theme.json`），hub 按 `web-theme.pin` 下载校验后嵌入 |

agent 拆开是因为部署机器和发布节奏不同。默认主题拆开是为了让主题拥有独立契约、版本和开发流程，
代价是多一个跨仓库依赖：主题得先发布，`web-theme.pin` 才钉得上去。

**hub 消费的是主题的构建产物，不编译主题源码。** 发布的 `theme.tar.gz` 里就是一个可安装的主题
目录——hub 嵌进去的那个文件，和用户解到 `<themes>/<short>/` 的那个是同一个，所以默认主题和第三方
主题走同一套契约。`web-theme.pin` 钉 `<tag> <sha256>`，对不上就构建失败。见
[decisions.md](decisions.md)。

后台不属于主题：`/admin/*` 和登录页始终由 hub 内置的 `web-admin` 提供，主题只负责公开状态页。
第三方主题因此不需要重做节点 CRUD、OAuth 和密码设置。

## 源码地图

| 文件 | 规模（不含测试） | 职责 |
|---|---|---|
| `src/db.rs` | ~1000 | schema + 所有 SQL。**流量累加 `accumulate()` 在这里** |
| `src/api.rs` | ~530 | 面板和公开页的 HTTP 接口、`Admin` 提取器 |
| `src/auth.rs` | ~380 | session、GitHub OAuth、argon2 密码、登录限流 |
| `src/main.rs` | ~390 | 启动、路由表、首次运行、定时清理 |
| `src/agent_ws.rs` | ~350 | agent 侧 WebSocket、RPC 分发、实时状态 |
| `src/frontend.rs` | ~180 | 双 SPA、主题扫描、磁盘安全读取与 fallback |
| `web-admin/src/` | ~2290 | 内置后台。`components/ui/` 下是 shadcn 生成的，不手改 |
| `scripts/theme.sh` | ~50 | 按 `web-theme.pin` 下载、校验、解出默认主题到 `target/theme/`。build.rs 和 CI 都调它 |

agent 的采集代码在 [另一个仓库](https://github.com/monitor-agent)。改了它的上报字段就是改了协议，两边要同步。

## 线上协议

WebSocket 承载 **JSON-RPC 2.0 通知**（只有 `method` + `params`，没有 `id`，不需要响应）：一条长连接双向都能主动发，报文自带方法名，用 `curl` 和浏览器控制台就能读。

### agent → hub

连上之后先发一次 `hello`，之后按 `--interval` 持续发 `report`；面板生成的安装命令默认 1 秒。

| method | params | 何时发 |
|---|---|---|
| `hello` | `Facts`：hostname / os / kernel / arch / virt / cpu_name / cpu_cores / mem_total / swap_total / disk_total / agent_version / ipv4 / ipv6 | 每次连接建立后一次 |
| `report` | `Metrics`：见下 | 每 `interval` 秒 |
| `ping.result` | `{task_id, latency_ms}`，`latency_ms` 为 `-1` 表示连不上 | 每个探测任务按自己的间隔 |

`Metrics` 的字段（[agent 仓库](https://github.com/monitor-agent) 里 `src/collect.rs` 的 `Metrics` struct 就是权威定义）：

```
boot_id  uptime  cpu  load[3]
mem_total  mem_used  swap_total  swap_used  disk_total  disk_used
net_rx_total  net_tx_total    ← 内核 lifetime 计数器，hub 负责累加
net_rx  net_tx                ← 瞬时速率 B/s，agent 自己算差值
tcp  udp  procs
```

`boot_id` 来自 `/proc/sys/kernel/random/boot_id`，是 hub 识别 VPS 重启的唯一依据。**不要删。**

### hub → agent

| method | params | 何时发 |
|---|---|---|
| `ping.tasks` | `[{id, target, interval}]` | 连接建立时；面板增删改探测任务时立刻下发 |

agent 收到后会**保留没变化的任务**（同 id + 同 target + 同 interval），只重启变了的，避免每次下发都把所有计时器清零。

**一个节点最多 64 个探测任务，两边都认这个数。** agent 侧（`MAX_PING_TASKS`）是防御：一个被攻陷
或有 bug 的 hub 否则能让别人的 VPS 每秒发几百个出站 connect，那条得留着。但**它只会静默截断**，
唯一的痕迹是那台机器自己的 journal——面板照样列着永远不跑的探测和永远空的图。所以 hub 在
`db::save_ping_task` 里先拒（`Db::MAX_PROBES_PER_NODE`，超了整个事务回滚，面板收到 400 和原因）：
知道总数的是 hub，该说话的就是 hub。`ping_tasks_for` 因此也带 `ORDER BY t.id`，让万一真走到 agent
那道兜底时，被保留的是稳定的同一批，而不是每次推送换一半、把计时器重置一遍。

## 数据模型

八张表，`src/db.rs` 顶部的 `SCHEMA` 常量是权威定义。库的版本记在 SQLite 自带的
`PRAGMA user_version` 里，当前是 `SCHEMA_VERSION`；迁移只在版本落后时跑一次，见 `db::migrate_to_1`。

| 表 | 作用 | 注意 |
|---|---|---|
| `setting` | key/value 配置 | 替代配置文件。见下方设置键列表 |
| `node` | 节点配置 + agent 上报的静态信息（`mem_total`/`swap_total`/`disk_total` 是**离线时的回落值**，在线时 `node_view` 取实时上报的那份，见下） | `token` 存明文，面板要能重新显示安装命令；只在 `full` 视图输出。`country` 是 hub 从 `ip` 查来的两字母国家码，**公开**，见 [decisions.md](decisions.md) |
| `traffic` | **单调递增的流量累计** | 1:1 于 node，但生命周期完全不同（每次上报都写） |
| `metric` | 历史明细，**每节点每分钟一行** | `WITHOUT ROWID`，按保留天数定期删。**一行描述它前面那一分钟，不是它那一瞬**：`net_rx/net_tx` 从累计器差值算出，`cpu`/`mem_used`/`disk_used`/`swap_used`/`tcp`/`udp`/`procs` 是分钟内均值。见 [decisions.md](decisions.md) |
| `ping_task` / `ping_node` | 探测任务及其节点分配 | 多对多 |
| `ping_record` | 探测结果 | 同样按保留天数删。主键是 `(node_id, ts, task_id)`——顺序跟着查询走，见 [benchmark.md](benchmark.md#6-下一轮一条会随时间变慢的查询) |
| `session` | 登录会话 | 存 sha256，14 天过期 |

### 为什么 traffic 单独一张表

因为它的生命周期和 `node` 完全不同：`node` 是用户偶尔改一次的配置，`traffic` 是每 2 秒写一次的热数据。分开还有一个更要紧的原因——**`metric` 可以随便清理而不影响累计流量**，因为累计值不是从明细算出来的。这是设计的一部分，见 [traffic.md](traffic.md)。

### 设置键

| key | 默认 | 说明 |
|---|---|---|
| `site_name` | `Monitor` | 页面标题 |
| `public_page` | 开 | 值为 `off` 时关闭公开状态页 |
| `retention_days` | `30` | 历史明细保留天数，限制在 1–3650 |
| `admin_password_hash` | 首次启动生成 | argon2id |
| `github_client_id` / `github_client_secret` | 空 | OAuth App |
| `github_allowed_users` | 空 | 逗号分隔的用户名白名单。**空 = 任何人都登不进来**（不是任何人都能进） |
| `theme` | `default` | 公开页主题短名；空、无效或已删除时使用内置默认主题 |
| `github_proxy` | 空 | 拼在 agent release 下载地址前的代理，仅 hub 自己拉不到 GitHub 时需要。只接受 `https://`；它返回的字节会装到每台节点上，见 [security.md](security.md) |

## 请求路径

`src/main.rs` 的路由表是权威定义。

**agent**：`GET /api/agent/ws`（Bearer token）、`GET /install.sh`（公开，不含密钥）、
`GET /agent/{arch}`（公开，把 release 二进制从 GitHub 转发给节点）、
`POST /api/agent/register`（公开，凭窗口内有效的注册 key 换一个节点 token）

安装命令默认传 `--interval 1`，也可在 1..3600 内调整。面板只从 HTTPS 域名入口生成它，明文或 IP
入口下这三个创建路径都被 `api::provisioning_allowed` 拒掉，**面板不会自动拼 `--insecure`**——那个
开关只留给手工运行 `install.sh` 和 agent，见 [security.md](security.md#--insecure-是这道闸唯一的开关)。

`--register KEY` 是给一批机器用的另一种入口：面板（节点 → 批量添加）开一个一小时的窗口，
`install.sh` 用 key 换这台机器自己的 token，名字取 `hostname`。命令里不含任何节点的凭证，所以
一条命令可以复制到所有机器上。机器上已经有 `agent.env` 的就直接沿用其中的 token，重跑不会重复
注册。窗口、上限和限流见 [security.md](security.md)。

二进制总是走 `<hub>/agent/<arch>`，由 hub 从 GitHub Release 取回再转发——能连上 hub 就能装，
IPv6-only 或者出不去的机器不用再找加速站。并发转发数由 `main::RELAY_GATE` 限到 4，单次持有时长由
`main::RELAY_DEADLINE` 限到 180 秒。
hub 自己拉不到 release 时，在面板设置里填 `github_proxy`，它只拼在下载地址前面
（`main::release_url`），不影响 agent 与 hub 的 WebSocket，节点侧什么都不用改。

`install.sh` 认 systemd 和 OpenRC：前者写 unit（`DynamicUser` + `ProtectSystem` 等加固），
后者写 `/etc/init.d/monitor-agent`，用 `supervise-daemon` 拿到等价的自动重启。两边 token 都只在
root-only 的 `/opt/monitor/agent.env` 里。

**等价的只有自动重启。** OpenRC 那边的 agent 以 root 跑：`DynamicUser` 是 systemd 白送的降权，
OpenRC 没有对应开关，要降权得自己建用户再指过去。agent 并不需要 root（只读 `/proc` 和 `/sys` 里
的公开文件，加出站 TCP），所以这是一笔可以还的债。没有顺手加 `command_user=nobody`：那会把 token
从 root 独占挪进一个共享身份的 `environ`，拿凭证换降权不是明确的净收益。

**读取**（登录了看全部，没登录且公开页开着只看公开节点）：
`GET /api/me`、`GET /api/nodes`、`GET /api/nodes/{id}/metrics?hours=N`、`GET /api/ws`（每 2 秒推一次快照）

`hours` 登录后 clamp 到 1–2160，匿名 1–168。**两个上限管的是两件事**：降采样限响应行数，窗口
上限限扫描行数——`hours=2160` 只返回 320 行，却读完该节点保留期内的全部探测记录，实测 224 ms 且随
`retention_days` 线性增长；主题画的最宽窗口是 7 天，所以匿名上限不欠任何人。

**第三个上限管的是「同时几个」**：上面两个都只描述一次请求，而这条路匿名可达，一次请求整段占着
agent 上报那把写锁。`api::HISTORY_GATE` 把在飞的窗口数卡在 4 个，满了返回 503 而不是排队（理由同
`auth::PASSWORD_GATE`：排队只是把洪水推后）。没有它时实测：一台机器 120 个并发请求，把面板自己的
`GET /api/nodes` 从 1 ms 拖到 2.8 s，且随并发数线性增长。

取 4 不取更大，是因为这些请求反正要在那一把连接上排队——第五个在飞不多给任何吞吐，只是在下一条
agent 上报前面再插一次扫描。这个数真正设定的是那段等待能有多长（4 × 约 120 ms ≈ 半秒）。

**而这道闸离了 `spawn_blocking` 等于没有。** handler 从头到尾不 await，permit 就只在某个 worker
线程真正跑着它的那段时间里被持有，也就是最多「每个 worker 一个」——这台三核 hub 上就是 3 个，闸门
写 8 永远不会触发。实测过：值取 8 时 120 个并发请求零拒绝，面板照样 14 s。这和 `PASSWORD_CHECKS`
那条「闸门的值必须小于机器真能同时跑的数量」是同一个坑的两面，把扫描挪出 runtime 之后「在飞」
才是字面意思。改完实测：120 个并发里 104 个被 503 挡下，面板 1.27 s（debug 构建，release 约一半）。

**分辨率由屏幕决定**：调用方用 `points` 报上自己能画多少点（设备像素），`api::sample_step` 只往下
调，绝不往上——上限 `SAMPLES = 1440`（一天的分钟数）是 hub 的，不是调用方的。样本装得下就一个不
抽稀，装不下才聚合。`series=metrics|ping` 再决定只要哪一半。这条路匿名可达，所以代价必须有上界。
见 [security.md](security.md) 和
[decisions.md](decisions.md#分辨率由屏幕决定聚合是退让不是默认-用户)。

**登录**：`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/github`、`GET /api/auth/github/callback`

**面板**（全部要 `Admin` 提取器）：
`POST /api/nodes`、`PUT /api/nodes/order`、`PUT|DELETE /api/nodes/{id}`、`POST /api/nodes/{id}/token`、`PUT /api/nodes/{id}/traffic`、`GET|POST /api/ping-tasks`、`DELETE /api/ping-tasks/{id}`、`GET|PUT /api/settings`、`GET|POST /api/themes`、`DELETE /api/themes/{short}`、`GET /api/themes/{short}/preview`、`POST /api/themes/{short}/update`、`GET /api/db`、`GET /api/db/backup`、`POST /api/db/restore`、`POST /api/db/vacuum`

**数据库那四个各是一次整文件操作**，都在 `tokio::task::spawn_blocking` 里跑。持有 agent 上报那条
连接的只有恢复和回收；导出走的是自己开的第二条连接，WAL 让它和写入并行（见
[decisions.md](decisions.md#导出不占上报那把锁-用户)）：

| 路径 | 做什么 | SQLite 侧 |
|---|---|---|
| `GET /api/db` | 文件大小、WAL 大小、可回收字节、各表行数 | `page_size` × `freelist_count` 与 `COUNT(*)` |
| `GET /api/db/backup` | 下载整库副本 | `VACUUM INTO`，第二条连接，不占上报的锁；副本落在库文件旁边，打开后立刻 unlink，随响应消失 |
| `POST /api/db/restore` | 用上传的备份覆盖当前库 | 分片收齐后先整份校验，再走在线备份 API 逐页覆盖 |
| `POST /api/db/vacuum` | 清过期明细并把空页还给磁盘 | `prune` + `VACUUM` + `wal_checkpoint(TRUNCATE)` |

## 分片上传

`POST /api/db/restore` 和 `POST /api/themes` 是**仅有的两条不在 64 KiB 请求体上限里**的路径，在
`main.rs` 里以 `merge` 挂在全局那层 limit 之外，各自带 `api::MAX_CHUNK = 8 MiB`——两层 limit 嵌套
取的是小的那个。协议只有一行：

```text
POST /api/db/restore?offset=<已经收到多少>&total=<整个文件多大>   body = 原始字节
POST /api/themes?offset=<...>&total=<...>                      body = 原始字节
```

**没有 upload id，没有会话，没有要回收的东西**：一次上传的状态就是那个临时文件的长度。`offset`
必须正好等于文件当前长度，否则 400；`offset = 0` 直接截断，于是上一次中断留下的残骸被下一次覆盖，
这就是全部的垃圾回收。收满 `total` 的那一个请求顺手把事做完（校验+恢复，或解压+安装），返回最终
结果；没收满的返回 `{"received": <长度>}`。一片要么整片落地要么回滚到片首，所以重传永远接得上。

代价是**两次上传落在同一个名字上**：分片大小相同则偏移天然对齐，长度检查分辨不出归属，于是它们
会拼接成一个文件。这一条留着——后果是这次上传失败，而修它要的正是上面否掉的 upload id。真正不能
留的是它跨过「已经校验完」那条线：收满之后 handler 先把文件 `rename` 到一个唯一名字再去读它，所以
另一次上传改不到正在被复制的那份。见 [security.md](security.md#导入的文件是不可信输入)。

三个上限各管一层，不要混：

| 数 | 常量 | 管什么 |
|---|---|---|
| 4 MiB | 面板里的 `CHUNK` | 前端切多大。服务端不参与，改它不用动 hub |
| 8 MiB | `api::MAX_CHUNK` | 单个请求的硬上限，**也是反代 `client_max_body_size` 要放行的数** |
| 256 MiB / 32 MiB | `api::MAX_RESTORE` / `MAX_THEME` | 整个文件，按路由分开；校验 `total`，第一个请求就拒 |

备份多大都不影响反代那一个数：256 MiB 的备份是 64 个 4 MiB 的请求。上传边收边落盘，不进内存。

其余路径按下面顺序处理：

```text
/api/*           未匹配即 404，不回落 SPA
/admin, /admin/* 内置后台；资源位于 /admin/assets/
其它             当前磁盘主题；不可用时回落内置默认主题
```

主题内找不到的路径返回同一主题的 `index.html`，让客户端路由刷新可用。磁盘文件必须在规范化后仍位于 `<themes>/<short>/dist` 内，路径穿越和越界符号链接都会被拒绝。

## 实时状态放在内存里

`App.agents: RwLock<HashMap<i64, Agent>>` 存每条 agent 连接：出站通道、会话号、最新一次上报。
hub 重启后会在一个上报周期内重建，所以不落盘。

**在线判定就是 WebSocket 连着**——`App.agents` 里有没有这个 node_id。握手时写入，断开时删掉，
一张表一个真相。

原来是两张：连接进 `agents`、指标进 `live`，靠每个改动点手工同步，于是不一致过——连接在握手时入表，
指标在**首次上报**时才入表，而在线判定读的是 `live`，所以刚连上的节点会离线整整一个 `--interval`
（最长 1 小时）。合成一张表之后这类不同步没有地方可以发生。

刚连上还没上报的节点是 `online: true` + `metrics: null`，主题和面板本来就要处理这个组合（离线节点
也是 `metrics: null`）。

连着不等于活着：机器掉进网络黑洞、内核卡死、NAT 表项超时，TCP 连接会停在半开状态，`recv()` 永远
不返回，节点就一直是「在线」配一份冻在死亡瞬间的指标，直到内核几小时后放弃这条连接。所以
`src/agent_ws.rs` 每 30 秒发一个 WebSocket Ping，**任何入站帧**（包括 pong）都算活着的证据；连续
120 秒一帧不来就主动断开，agent 随即重连。判定离线最慢 150 秒。

### 容量以上报的那份为准，`node` 表那三列是离线时的回落

`mem_total` / `swap_total` / `disk_total` 在协议里出现两次：`Facts` 里一次（**整条连接只发一次**），
每条 `Metrics` 里再一次。两者会岔开——agent 每次采样都重读 `/proc/self/mounts`，正是为了让运行中
挂上的数据盘立刻出现在容量里，而 `Facts` 要等下一次重连，可能是几天以后。

所以 `api::node_view` 在节点在线时取实时上报的那份，离线时才落回 `node` 表。**一个数，不是两个**：
在此之前默认主题的卡片读实时值、详情页读存储值，同一台机器同一时刻显示两个容量（实测挂一块 5 GB
盘：卡片 34.3 GB，详情页 29.4 GB，连轴顶和标题一起错）。不加写：`Metrics` 里本来就带着正确答案，
这只是选了对的那个。测试 `a_capacity_that_changed_since_the_handshake_is_the_reported_one`。

### 速率的分母用单调钟，时间戳才用墙上钟

`metric` 行的 `net_rx`/`net_tx` 是「两次写行之间累计器涨了多少 ÷ 经过了多少秒」。`Agent.mark` 存的
因此是 `std::time::Instant` 而不是 unix 秒——**这是一个时长，`ts` 才是一个时刻**。墙上钟会往回跳
（NTP 在刚开机时校正、快照恢复），差值变负之后那个防除零的 `.max(1)` 就把整整一分钟的字节除以了
一秒，往 `metric` 表里 `INSERT OR REPLACE` 一条最高 60 倍的假尖峰，覆盖掉本来正确的那一行；主题的
`axisTop` 读窗口内的最大值，于是整个窗口（公开页最长 7 天）的真实曲线被压成贴底的直线。agent 算
自己那份瞬时速率时用的也是 `Instant`，同一个理由。

## 已知的简化上限

源码里用 `ponytail:` 注释标出来了：

- `src/db.rs` — 单个 SQLite 写连接加互斥锁。几十个节点每 2 秒上报完全够用，真堵了再拆读连接池。
  **触发条件是可测的**：`/api/nodes/{id}/metrics` 实测 24 小时窗口占锁 98 ms，这段时间 agent 上报
  排队。上报是同步函数、直接在 select 分支里跑，所以它包在 `tokio::task::block_in_place` 里：
  否则一次 restore／VACUUM 占锁几秒，几个 agent 就能把 worker 线程全部堵住，连面板、公开页和
  优雅关闭一起停摆——排队的应该只有上报。匿名窗口已收到 168 小时（`api::PUBLIC_HOURS`）、在飞数量
  收到 8 个（`api::HISTORY_GATE`），面板真的开始堵上报时再拆——WAL 下加一条
  `SQLITE_OPEN_READ_ONLY` 连接就够，但那会给 `:memory:` 的测试留一条和生产不同的路，现在这个规模
  不值得
- `src/api.rs` — 浏览器实时推送是每个连接自己跑 2 秒定时器，不是广播 fan-out。定时器背后的快照是
  共享的（`live_snapshot`，公开/后台各一份，缓存 1.9 秒），所以多开几个标签页只多几次 socket 写，
  不会把查询量乘上观众数
- `src/main.rs` — `/agent/{arch}` 的转发闸门是固定的 4 个 permit（`RELAY_GATE`），不做磁盘缓存。
  安装是低频操作；真到需要的时候，按 release tag 缓存一份比调大闸门有用。permit 不挂在响应体上，
  而是交给一个带 `RELAY_DEADLINE` 定时器的任务：「传完为止」由客户端说了算，而不读的客户端会让
  hyper 停止 poll 这个流，写在流里的截止时间就永远不会被检查到
- `src/agent_ws.rs` — 国家码查询（`locate`）没有重试、没有退避。成功的那次由库里那一行兜住（失效
  条件是地址变化），**失败的那次由进程内的 `ASKED` 兜住**：同一个 node + 同一个地址一小时内只问
  一次。这条不是优化是闸门——查失败时 `save_facts()` 会一直答「还欠一个国家码」，而握手可以每几秒
  来一次（链路差、或者两台机器共用一个 token），没有它就是每次重连一次出站请求，无上限
