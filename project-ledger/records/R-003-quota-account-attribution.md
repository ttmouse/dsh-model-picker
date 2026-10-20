# R-003：额度归属由网关目录决定，路径首段不算账号

```json
{
  "id": "R-003",
  "kind": "risk",
  "status": "active",
  "summary": "一条路由归哪个额度账号，只能由网关目录（/v1/models 的 owned_by）回答；路径首段可能是实验室（commandcode/zhipu/…）或厂商（our-free-model/openrouter/…），按它匹配会显示别人的数字。路由组 group/* 是账号池，永远不显示任何单一数字",
  "scope": ["lib/host.js", "lib/client.js"],
  "sources": ["lib/host.js", "lib/client.js", "scripts/interaction.mjs"],
  "key": "quota-account-attribution",
  "supersedes": ["R-002"],
  "retracts": [],
  "relations": [{"type": "refines", "target": "D-001"}, {"type": "supersedes", "target": "R-002"}],
  "recorded_at": "2026-10-20"
}
```

## 为什么

额度挂在供应商账号上，而**账号名不等于路径首段**：

- `commandcode/zhipu/glm-4.6` 的 `zhipu` 是**实验室**（智谱），不是账号；这条路由属于 commandcode 这家转售商。
- `our-free-model/openrouter/…` 的 `openrouter` 是**厂商**，不是账号；这条路由属于 our-free-model 这个账号。
- `magpie/trae-cn/deepseek-v4.1-flash` 的 `trae-cn` 才是账号。

按首段匹配，这两种行会分别借走智谱账号的百分比和 OpenRouter 账号的余额——都是别人的数字。

**唯一权威是网关自己的模型目录**：`GET http://127.0.0.1:3425/v1/models` 的每条模型带 `owned_by`，即「这个模型由哪个账号回答」。host 半身读它并随额度行一起发布，浏览器按模型 id 查、再按整条路由查，两次都是精确查表。

**路由组**（`group/auto-*`）背后是多个账号的池，目录只写了其中一个成员，所以整条排除——池不显示任何单一数字，否则就是关于其余成员的谎话。

## 代价与判据

- 目录里查不到就是查不到，那一行不显示。显示 0% 或别人的数字比不显示更坏。
- 两种键形都要试：floor 的模型 id 本身就是目录的键（`trae-cn/deepseek-v4.1-flash`）；镜像网关命名的直连厂商，目录的键是整条路由（`cline/cline-free/mimo-v2.6-flash`）。
- 判据是**精确查表命中**，不是「首段看起来像账号」。
- 真机核对方式：`curl 127.0.0.1:3425/v1/models | jq 'to_entries|map(select(.value.owned_by!=null))'` 看目录，再与 `/v1/magpie/quotas` 的 provider 列表对齐。

## 验证

`scripts/interaction.mjs` 13k.1b：floor 用例 `magpie/trae-cn/…` → `69% · 12d`、`magpie/workbuddy/…` → `16% · 42d`、路由组 → 空；转售商用例 `commandcode/zhipu/glm-4.6` → 空（zhipu 有额度行也不借）。`scripts/host-route.mjs` 断言 `owners` 里没有 `group/` 开头、也没有无归属的模型。

## 取代

R-002 说「配置里把账号写成 `<floor>/<供应商账号>`（如 `magpie/zcode`）就能对上」——那是把路径首段当账号的启发式，本记录证明它会显示错的数字，故由本记录取代。
