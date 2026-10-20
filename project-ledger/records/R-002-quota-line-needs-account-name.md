# R-002：兜底队列的额度行只能显示，前提是 floor 的账号名能对上供应商

> **已由 R-003 取代（2026-10-20）**：本记录的前提——「路径首段就是账号」——不成立。首段可能是实验室（`commandcode/zhipu/…`）或厂商（`our-free-model/openrouter/…`），按它匹配会显示别人的数字。账号归属改由网关目录的 `owned_by` 决定，见 R-003。本记录留作当时判断的痕迹。

```json
{
  "id": "R-002",
  "kind": "risk",
  "status": "superseded",
  "superseded_by": "R-003",
  "summary": "兜底行的额度行靠 provider.id 里的账号段（magpie/zcode → zcode）去匹配 magpie 的额度行；配置里只写了 floor 名（magpie/<模型>）、没带供应商账号段时对不上，该行不出额度——不显示而不是显示错的",
  "scope": ["lib/client.js"],
  "sources": ["lib/client.js", "scripts/interaction.mjs"],
  "key": "quota-line-account-match",
  "supersedes": [],
  "retracts": [],
  "relations": [{"type": "refines", "target": "D-001"}, {"type": "superseded-by", "target": "R-003"}],
  "recorded_at": "2026-10-20"
}
```

## 为什么

额度挂在供应商账号上，不挂在模型上。一个 floor（`magpie`、`codebuddy`）背后可能是四十家供应商，所以不能拿 floor 的显示名去猜账号——那会把第一家账号的数字贴到每一行上。能用的线索只有配置里写的账号 id：`magpie/zcode` 里的 `zcode`。

2026-10-20 用户实际配置的兜底队列（Trae CN / WorkBuddy / zai-coding-cn / openrouter / Loomy 等）额度行全空，原因就是这个：这些 floor 的 id 不含供应商账号段。

## 代价与判据

- 对不上就不显示。显示 0% 或别人的数字比不显示更坏。
- 想让它显示，配置里把账号写成 `<floor>/<供应商账号>`（如 `magpie/zcode`），或直接用供应商自己的 floor。
- 真机核对方式：`curl 127.0.0.1:<port>/api/model-picker/quotas` 看 provider 列表，再比对兜底行 route 里的账号段。

## 验证

`scripts/interaction.mjs` 13k.1b 的 floor 用例：`magpie/zcode/glm-5` 渲染出 `38% · 2d`，tooltip 以 `ZCode` 开头；同文件里 `fallbackTarget` 已改为从最长的 provider 前缀往后试，才认得出带斜杠的 provider id。
