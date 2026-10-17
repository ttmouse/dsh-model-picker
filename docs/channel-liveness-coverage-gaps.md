# 探活覆盖缺口清单（2026-10-12）

第一轮只测了 llm-pi-ai 一个插件里的 provider。桌面 profile 实际能出模型的入口不止那一处，以下是逐项盘点后的缺口与已确认事实。

## 已测（第一轮）

| 来源 | 数量 | 结果 |
| --- | --- | --- |
| llm-pi-ai 的 11 个 provider（opencode-go1 / commandcode / yqa ×3 / qwen-token-plan-cn / zai-coding-cn / magpie ×3） | 116 条路由 | 87/116 可用；详见 liveness-final-merged.json |

## 漏测（本轮要补）

| 来源 | 规模 | 已确认事实 |
| --- | --- | --- |
| `dsh-our-free-model` 白嫖/聚合 lanes | 4 条 lane（free / EAC / Kilo 频道 / aggregate） | 插件自带 15 分钟探针，`~/.dsh/our-free-model/availability.json`、`stats.json`（今日 20 万 token 用量，含失败计数）。第一轮完全没纳入 |
| `dsh-our-free-model` aggregate 注册表 | 76 个 provider / 504 个模型 | 60 个 apikey + 10 个 free-tier + 1 free + 3 local + 2 oauth；用户只配了 `DEEPSEEK_API_KEY`，其余 67 个按定义拿不到钥匙 → 应批量标为「未配置」，而不是逐个发请求 |
| aggregate 里的 4 个免钥匙 provider | opencode(free,4) / ollama / lmstudio / llamacpp | 这三个 local 是真能用的下载入口，需逐个探测本机端口 |
| `llm-deepseek`（官方 DeepSeek API） | 1 个 provider | **实测可用**：`deepseek-chat` → 200，返回模型 `deepseek-flash` |
| `llm-deepseek-account`（DeepSeek 账号态） | 1 条账号路由 | 凭据记录里有 device + default token，未测 |
| 本机 Ollama | 5 个模型 | **实测可用**：11434 `/v1/models` 返回 minicpm5-2b / bge-m3 / qwen3-coder:480b-cloud / glm-4.6:cloud / llama3.2，chat 200 |
| OAuth 类（github_copilot 17 个、openai 8 个） | 25 个模型 | 需要 OAuth 授权态，未测；要么补测，要么明确标「未授权」 |
| 其它 profile 的证书路线 | web/aa-verify 各有 `opencode-go`（desktop 没有） | 第一轮只按 desktop 的清单测，漏了 web/aa-verify 独有的 `opencode-go` |
| `agents-anywhere-bridge-next` 等第三方插件可能注册的模型 | 未知 | 未核查 |

## 第一轮的判定口径需要说明的两处

1. `no-key` 是「本机凭据库里没有这个 env」，不是「渠道坏了」。对 aggregate 的 67 个 provider，应统一按 `no-key` 归类，不必逐条发请求。
2. `commandcode` 直连需要正常 `User-Agent`，否则 Cloudflare 返回 `error code: 1010`——第一轮用 urllib 默认 UA 测出来的 auth 结论是误判，已修正为「余额 0」。
