# RL-001：桌面端是拷贝安装，改完必须回拷且 host 改动需完全重启 App

```json
{
  "id": "RL-001",
  "kind": "rule",
  "status": "active",
  "summary": "App 从 ~/.dsh/profiles/desktop/node_modules/dsh-model-picker 加载拷贝件：lib 改动要 cp 过去并核对 md5；host.js 改动只在进程启动时生效，需完全重启 App；push 后须把两份 lockfile 重钉新 sha",
  "scope": [],
  "sources": ["package.json", "docs/channel-liveness-2026-10-12.md"],
  "key": "deploy-copy-install",
  "recorded_at": "2026-10-18"
}
```

## 为什么

历史两次发生 App 重装依赖把插件拉回 lockfile 钉死的旧版（244e129 重钉事件）；拷贝安装不随 checkout 更新，改完不回拷等于白改。

## 验证

2026-10-18 部署 0ab4f8d 后 checkout 与 deployed 两半 md5 一致。
