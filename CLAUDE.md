# monitor

Rust 服务器探针的 **hub**：看状态、看流量、看延迟、算成本，并发送 Telegram 通知。

agent 在 [独立仓库](https://github.com/uyo8os/monitor-agent)。后台在 `web-admin/`；默认公开页主题在
[monitor-theme-default](https://github.com/uyo8os/monitor-theme-default)，**以发布好的
`theme.tar.gz` 形式消费**——`web-theme.pin` 钉住 `<tag> <sha256>`，构建时下载校验解到
`target/theme/`。两份产物都由 `rust-embed` 编译进二进制，外部主题由 hub 在运行时从磁盘读取。

**动手之前先读 [docs/](docs/)**，尤其是 [docs/decisions.md](docs/decisions.md)：每个选择的理由和
被否决的方案都在里面。

## 三条铁律

1. **总流量永不回退。** VPS 重启、hub 重启、agent 掉线，累计值都要继续加。见 [docs/traffic.md](docs/traffic.md)
2. **内存和硬盘必须和 `free` / `df` 对得上。** 数据由 agent 决定，那边叫「口径铁律」。见 [agent 仓库的 data-accuracy.md](https://github.com/uyo8os/monitor-agent/blob/main/docs/data-accuracy.md)
3. **公开状态页永远不输出 IP、主机名、备注。** 见 [docs/security.md](docs/security.md)

## 明确不做的

不要「顺手」加回来，想加先问用户：远程 SSH、插件系统、ICMP/HTTP ping、agent 自动更新、跨平台 agent。

## 工作方式

- 用 `ponytail` skill（full），别过度设计、别过度测试。一段非平凡逻辑留一个能跑的检查就够，不要
  每个函数一个测试
- 注释写约束，不写调试过程；解释比代码长就删解释
- 用现成的主流组件，但过重的宁可自己写
- 除了已经定下来的，其它取舍问用户，别自己定
- 面板新接口的签名里必须有 `_: Admin`；新的节点字段默认放 `node_view()` 的 `full` 分支
- 新增匿名可达的路径，先说清两个上界：**单次请求**的（内存、占锁时长、出网字节），和**同时能有
  几个在飞**的。只有前者会漏掉真正的洞——`/api/nodes/{id}/metrics` 的单次上界（`PUBLIC_HOURS`）
  写得清清楚楚，实测仍然能被一台机器 120 个并发请求把面板从 1 ms 拖到 2.8 s。三条这样的路径现在
  各有一个闸门：`api::HISTORY_GATE`、`main::RELAY_GATE`、`auth::PASSWORD_GATE`
- **加了闸门要实测它真的会拒绝。** 同步 handler 里的 permit 只在 worker 线程跑着它时被持有，所以
  「在飞数」封顶就是核数：三核机器上闸门写 8 等于没写（实测 120 并发 0 拒绝）。重的 DB 查询要
  `spawn_blocking`／`block_in_place` 挪出 runtime，permit 跨 await 持有，闸门才有意义

## 常用命令

```bash
cargo test
cargo fmt --all              # CI 卡这个，改完必跑
cargo clippy --all-targets
cd web-admin && npm run build
cargo run -- --listen 127.0.0.1:9911 --db /tmp/dev.db --themes /tmp/themes
```

**别用 `pkill -f` 停进程**——会匹配到跑命令的 shell 自己。用 `ss -lptn "sport = :9911"` 拿 PID 再 kill。

完整开发流程见 [docs/development.md](docs/development.md)。
