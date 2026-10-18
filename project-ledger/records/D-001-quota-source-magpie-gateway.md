# D-001：渠道额度数据取自 magpie HTTP 网关，作废外推靠插件自采样

```json
{
  "id": "D-001",
  "kind": "decision",
  "status": "active",
  "summary": "额度徽标的数据源用 magpie HTTP 网关 /v1/magpie/quotas，作废外推用 host 内相邻两次采样的速率，不调 magpie CLI 的 quota history",
  "scope": ["lib/host.js", "lib/client.js"],
  "sources": ["lib/host.js", "docs/channel-liveness-2026-10-18.md"],
  "relations": [{"type": "implements", "target": "RQ-001"}],
  "key": "quota-data-source",
  "recorded_at": "2026-10-18"
}
```

## 为什么

channel-radar 技能的作废外推依赖 `magpie quota history` CLI 的历史读数；插件 host 内调 CLI 太重，改为模块内存保留上一轮采样、两轮相减得速率外推。代价：重启后首轮无外推（见 R-001）。

## 未选方案

- 调 `magpie quota history` CLI：数据更准但要在 host 里起子进程并解析 CLI 输出。
- 只显示剩余 % 不外推：无法回答「会不会白作废」这个核心问题。

## 验证

scripts/host-route.mjs 全绿；真网关实测返回 Cursor/Grok/Codex/ZCode 数据（2026-10-18，commit 0ab4f8d）。
