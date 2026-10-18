# RQ-001：打开选择器即可见「哪个渠道额度最值得用」

```json
{
  "id": "RQ-001",
  "kind": "requirement",
  "status": "active",
  "summary": "用户问「哪个渠道额度最值得用/会不会浪费」时，不需跑脚本，打开模型选择器扫渠道列表即可得到答案",
  "scope": ["lib/client.js"],
  "sources": ["docs/channel-liveness-2026-10-18.md"],
  "relations": [{"type": "implemented-by", "target": "D-001"}],
  "key": "quota-visibility",
  "recorded_at": "2026-10-18"
}
```

## 为什么

「免费额度渠道与模型调用策略」会话产出的人工排查（渠道剩余/重置/作废排序）每次都要跑 channel-radar 脚本；结论会过期，应常驻在使用现场（picker）。

## 验收口径

provider 列每行显示主窗口剩余%·重置倒计时；作废风险染警示色；悬停列全部窗口。主窗口＝期限最长窗（5 小时滚动窗不算，滚动不累积损失，口径沿用 channel-radar）。
