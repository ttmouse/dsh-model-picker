# DSH 全渠道探活报告（2026-10-12 15:3x）

一句话结论：**你的桌面 profile 里，直连 provider 基本是坏的（0/21 可用），真正能打的是本机 magpie 网关背后的那些通道（76/83 可用，p50 延迟 7.1s）。**

- 探活口径：每个模型发一条最小 chat 请求（`Reply with the single word: ok`，`max_tokens=64`，`temperature` 默认，不流式），只判定「这条路由现在能不能给出正常响应」。
- 工具与原始数据：`tools/model-probe/probe_liveness.py`、`tools/model-probe/results/liveness-final-merged.json`（含每条记录的 provider/model/verdict/seconds/message）。
- 复跑：`python3 tools/model-probe/probe_liveness.py --jobs 10 --timeout 45 --out results/liveness-final.json`。

## 总览

| 路由 | 可用 | 说明 |
| --- | --- | --- |
| magpie 网关（83 个模型） | 76 / 83 | 主力通道；失败项全部是上游额度/限流，不是网关问题 |
| magpie-responses | 2 / 2 | codex/grok 走 responses 协议正常 |
| magpie-anthropic | 0 / 2 | 两个 zcode 模型都撞上 ZCode 周额度上限 |
| yqa-mumiao（17an 苗苗号） | 6 / 7 | 可用模型：deepseek-v4-flash / -202605 / v4-pro / claude-opus-4-6 / -max / v4-flash-vision-exp |
| yqa（17an-db） | 2 / 2 | deepseek-v4.1-flash、glm-5.3-flash |
| yqa-anbot | 1 / 1 | deepseek-v4.1-flash |
| opencode-go1 | 0 / 5 | **未配置 `OPENCODE_ZEN_API_KEY`**（凭据库里没有这个 key） |
| commandcode | 0 / 3 | 密钥有效、模型列表能拉到，但账号 **credits 为 0**；直连 chat 还被 Cloudflare 挡（需真实 User-Agent） |
| qwen-token-plan-cn | 0 / 7 | 密钥有效、`/models` 能列出 24 个模型，但每一个都返回 `AccessDenied.Unpurchased` —— 套餐没买或没绑到这个 key |
| zai-coding-cn | 0 / 4 | 周/月额度已耗尽，2026-10-14 11:30 重置；`glm-5.3-highspeed` 不在套餐内 |

## 需要你处理的三件事

1. **opencode-go1 缺密钥**：`OPENCODE_ZEN_API_KEY` 在 `~/.dsh/.credentials.yaml` 里根本不存在。要么补上，要么把这个 provider 从面板里去掉（它现在看着像能用，实际一点就失败）。
2. **qwen 套餐没生效**：key 能过鉴权、能列模型，但所有模型 `AccessDenied.Unpurchased`。去阿里云百炼确认这个 token-plan key 绑的是哪个套餐。
3. **commandcode 余额为 0**：密钥没问题（`/models` 200），只是没 credits；充值后可用，另外它前面挂着 Cloudflare，程序化调用必须带正常 User-Agent，否则返回 `error code: 1010`。

## 额度/限流时间点（照抄上游原文）

- zai-coding-cn + zhipu/glm-5.3(+flash) + zcode/GLM-5.3(+Flash)：周/月上限，**2026-10-14 11:30 重置**。
- workbuddy/deepseek-v4.1-flash：频率限制，**2026-10-12 20:48 重置**。
- 17an-db 订阅：`subscription quota insufficient, need=84`（需要额度，不是 key 错）。

## 延迟画像（magpie，成功样本）

- p50 ≈ 7.1s，p90 ≈ 41s，最慢 84s。
- 快档（< 5s）：`grok/grok-4.7` 3.3s、`cursor/muse-spark-1.3@1m` 4.6s、`cursor/claude-opus-5@300k` 3.7s、`workbuddy/*` 系列 1.7–5s、`group/auto-glm-5-3-flash` 2.5s。
- 慢档（> 30s）：`codex/gpt-6*` 55–62s、`opencode-zen-free/*` 17–85s、`qoder/*` 19–25s。
- 注意：慢档里有些第一次 45s 超时、给到 180s 后全部成功 —— 它们是「慢」，不是「坏」。判定超时前先给足时间。

## 方法与局限

- 单次采样，只证明「此刻这条路由可返回」，不等于质量排序；质量/能力对比见看板 LOCAL-24。
- 探活不校验回答内容正确性，只校验 HTTP 200 + 有 choices/output。
- 密钥来自 `~/.dsh/.credentials.yaml`；报告不落任何密钥明文。
