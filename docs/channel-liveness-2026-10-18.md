# DSH 全渠道探活报告（2026-10-18 15:3x）

一句话结论：**32 个渠道里 22 个能用（77 条代表探针 53 通），真正坏的是 5 家：cline（额度尽）、commandcode（余额 0）、opencode-go1（key 过期）、our-free-model（上游域名已死）、qwen-token-plan-cn（套餐未绑定）。** 比 10-12 那轮明显变好：上轮 0/21 的直连 provider 这轮大面积恢复，上次额度耗尽的 zai-coding-cn、magpie-anthropic 都已重置可用。

- 探活口径：走本机 channel-pack 网关 `127.0.0.1:8326/v1`（App 实际使用的那条路径，含只在进程环境里的凭据），每渠道×每模型族取 1 个代表模型发最小 chat 请求（`回复 ok`，`max_tokens=8`，20s 超时，并发 4）。
- 工具与原始数据：`tools/model-probe/probe-gateway.mjs`、`results/gateway-20261018-1530.json`。
- 复跑：`node tools/model-probe/probe-gateway.mjs --out tools/model-probe/results/<file>.json`。

## 逐渠道结果

| 渠道 | 通过 | 各模型族探针 |
| --- | --- | --- |
| buddy | 4/4 | deepseek: ✅ 1615ms<br>glm: ✅ 2021ms<br>kimi: ✅ 1387ms<br>minimax: ✅ 1628ms |
| cline | 0/4 | deepseek: 💸 额度尽<br>glm: 💸 额度尽<br>openai: 💸 额度尽<br>claude: 💸 额度尽 |
| codearts | 1/2 | deepseek: ✅ 1346ms<br>glm: ⏱ 超时（适配器服务端排队，20s 判不出） |
| commandcode | 0/2 | deepseek: 💸 余额 0<br>minimax: 💸 余额 0 |
| deepseek-account | 1/1 | deepseek: ✅ 763ms |
| deepseek-official | 1/1 | deepseek: ✅ 726ms |
| lobsterai | 4/4 | deepseek: ✅ 1548ms<br>glm: ✅ 1023ms<br>kimi: ✅ 521ms<br>qwen: ✅ 1540ms |
| loomy | 2/4 | deepseek: ✅ 8858ms<br>qwen: ✅ 1125ms<br>glm/kimi: ⏱ 超时 |
| magpie-anthropic | 1/1 | glm: ✅ 1652ms（10-12 时还撞周上限，已重置） |
| magpie-responses | 2/2 | openai: ✅ 3779ms<br>grok: ✅ 2889ms |
| magpie/17an-db | 1/1 | deepseek: ✅ 1542ms |
| magpie/cline | 2/3 | muse: ✅ 2943ms<br>other: ✅ 2925ms<br>deepseek: 🚫 需订阅 |
| magpie/cursor | 4/4 | openai: ✅ 4115ms<br>claude: ✅ 4803ms<br>grok: ✅ 3810ms<br>gemini: ✅ 4191ms |
| magpie/group | 4/4 | deepseek: ✅ 3032ms<br>glm: ✅ 2879ms<br>kimi: ✅ 1842ms<br>grok: ✅ 2907ms |
| magpie/opencode-zen-free | 2/4 | deepseek: ✅ 4460ms<br>other: ✅ 4099ms<br>glm: ❌ 500<br>nemotron: ⏱ 超时 |
| magpie/our-free-model | 0/4 | 全挂：上游域名 ENOTFOUND / 500 |
| magpie/qoder | 1/1 | other: ✅ 2359ms |
| magpie/trae-cn | 1/1 | deepseek: ✅ 2688ms |
| magpie/workbuddy | 4/4 | deepseek: ✅ 1989ms<br>glm: ✅ 1994ms<br>kimi: ✅ 1765ms<br>minimax: ✅ 1949ms |
| magpie/workbuddy-ai | 2/2 | glm: ✅ 1979ms<br>other: ✅ 3769ms |
| magpie/zhipu | 1/1 | glm: ✅ 2983ms |
| minimax | 1/1 | minimax: ✅ 2139ms |
| opencode-go1 | 0/1 | deepseek: ❌ 500（key 过期） |
| openrouter | 2/4 | deepseek: ✅ 1473ms<br>glm: ✅ 3825ms<br>openai/claude: 🚫 区域封锁（403 not available in your region） |
| our-free-model | 0/4 | 全挂：上游域名 `ai.dtyg123.dpdns…` ENOTFOUND |
| qoder | 1/1 | other: ✅ 2076ms |
| qwen-token-plan-cn | 0/1 | deepseek: 🚫 AccessDenied（套餐未绑） |
| raccoon | 4/4 | deepseek: ✅ 2544ms<br>glm: ✅ 1546ms<br>kimi: ✅ 1883ms<br>nova: ✅ 2223ms |
| yqa | 2/2 | deepseek: ✅ 1202ms<br>glm: ✅ 1908ms |
| yqa-anbot | 1/1 | deepseek: ✅ 1151ms |
| yqa-mumiao | 3/3 | deepseek: ✅ 1245ms<br>claude: ✅ 2062ms<br>other: ✅ 1128ms |
| zai-coding-cn | 1/1 | glm: ✅ 888ms（10-12 额度耗尽，已重置） |

## 需要处理的 5 家（都能用 → 需要人动手）

1. **opencode-go1**：key 过期（`api_key_expired`），去 OpenCode Console 新建，或从面板移除。
2. **qwen-token-plan-cn**：key 有效但每个模型 `AccessDenied.Unpurchased`，去阿里云百炼确认套餐绑定。
3. **commandcode**：账号有效、credits 为 0，充值后可用。
4. **cline / magpie-cline**：免费额度只剩 $0.0096，主流模型都要订阅套餐（403）——当它不存在，除非升级套餐。
5. **our-free-model（含 magpie 路由）**：上游域名解析失败（ENOTFOUND），不是配置问题，等上游或移除。

已知边界：openrouter 的 openai/claude 是**区域封锁**（不是额度），glm/deepseek 可用；loomy 的 glm/kimi 20s 内不回（慢，不是坏）；codearts glm 同理（服务端排队上限 30 分钟）。

## 免费额度消耗优先级（渠道雷达 2026-10-18 15:30）

`预计作废`＝按当前消耗速度外推、到重置时仍会清零的部分——这是唯一真金白银的损失维度：

| 优先 | 渠道 | 剩余 | 距重置 | 预计作废 | 怎么烧 |
| --- | --- | --- | --- | --- | --- |
| 1 | **Cursor**（Other Models 窗） | 97% | 23.4 天 | **86%** | magpie/cursor 的 claude/grok/gemini/openai 全通（4–5s）；量大、非交互的活派这里 |
| 2 | **Grok (SuperGrok)** | 74% | **1.8 天（周二 10:57 重置）** | **65%** | 两天内不用就清零；magpie-responses/grok ✅ 2.9s |
| 3 | **ZCode** 周窗 | 76% | 2.8 天（周三 11:30） | **60%** | magpie-anthropic/glm ✅ 1.7s，已恢复可用 |
| 4 | **Codex Plus** | 5h 窗满 | **订阅 10-22 到期** | 4 天后整个没了 | 已是主力（7 天 1.17 万次调用），到期前正常用即可 |
| 5 | **Trae CN** | 92% | 13.4 天 | 27% | deepseek-v4.1-flash ✅，已是第二主力（7 天 45M tokens） |
| 6 | Qoder 加购 | 81% | 不过期 | — | 不着急，62% 成功率 + 59s 中位延迟，只派不要紧的活 |

不用愁作废的：WorkBuddy/WorkBuddy AI 是 credits 制不过期（但 WorkBuddy 只剩 15%）；buddy/lobsterai/minimax/codearts/raccoon 靠每日签到续（今天 6 家已领），额度薄、当日常溢出池用；yqa/yqa-anbot/yqa-mumiao 三份 17an 凭据互相独立，是 deepseek-v4.1 的最厚冗余。

## 与 2026-10-12 报告的差异

- 直连 provider 从 0/21 大面积恢复：buddy/lobsterai/raccoon/minimax/deepseek-official/yqa 系全通（当时多为一笼统的 0 可用或未测）。
- zai-coding-cn、magpie-anthropic 额度重置后恢复可用。
- 新增坏点：our-free-model 上游域名死亡（当时 24 路由可用），cline 额度烧完。
- openrouter openai/claude 的 403 是区域封锁，与 10-12 的结论（当时未单独归类）不同：这不是钱能解决的。

## 方法与局限

- 每渠道×模型族只测 1 个代表模型（优先 flash/free 档），代表通过≠该族全部模型可用；cline/openrouter 各有数百条路由未逐条测。
- 单次采样，只证明「此刻这条路由能返回」；loomy 类慢渠道需要更长超时才能判定。
- 网关 key 只发往本机网关，不落报告；额度数字来自 magpie quota 与应用缓存（DeepSeek/Cline 为缓存值，已注明缓存时间）。
