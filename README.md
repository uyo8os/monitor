# monitor

文档：[monitor-document.pages.dev](https://monitor-document.pages.dev)，安装、配置、反向代理与主题开发都在这里。

主题站：[monitor-themes.pages.dev](https://monitor-themes.pages.dev)，在线预览各个公开页主题，复制地址即可在面板安装。

## 发布前准备

在各自仓库发布对应的 release 产物：Hub 的安装脚本、二进制与校验文件；Agent 的二进制、签名与校验文件；主题的 `theme.tar.gz`。使用 Docker 时，还需发布 `ghcr.io/uyo8os/monitor` 并确保部署机器有权限拉取。

Agent 签名使用新密钥时，须将匹配的 Ed25519 公钥同时更新到 `monitor/src/main.rs` 和 `monitor-agent/.github/workflows/release.yml`，并在 Agent 仓库的 GitHub Actions secrets 中配置私钥 `AGENT_SIGNING_KEY`。更新 Hub 后再发布 Agent，否则发布校验或 Hub 转发会失败。私钥不得提交到仓库。

## 特性

- 实时监控：秒级实时数据展示
- 轻量高效：Rust 语言构建，低资源占用，极简高效
- 自托管：完全掌控数据隐私，部署简单
- 通知：节点掉线、流量、到期与登录，推送到 Telegram 或自定义 Webhook

## 组成

| 仓库 | 说明 |
|---|---|
| [monitor](https://github.com/uyo8os/monitor) | hub：后台、API、公开页宿主 |
| [agent](https://github.com/uyo8os/monitor-agent) | Linux agent |
| [monitor-theme-default](https://github.com/monitor-probe/monitor-theme-default) | 内置默认主题 |
| [themes](https://github.com/monitor-probe/themes) | 主题站：收录第三方主题，提供在线预览 |

```
agent (Linux)  ──WebSocket / JSON-RPC 2.0──▶  hub (axum + SQLite)  ──▶  后台 + 状态页
```
