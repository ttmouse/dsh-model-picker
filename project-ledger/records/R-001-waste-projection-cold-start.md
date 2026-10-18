# R-001：作废外推有冷启动缺口

```json
{
  "id": "R-001",
  "kind": "risk",
  "status": "active",
  "summary": "projectedWaste 依赖相邻两次采样（间隔 ≥15min），App 重启后首轮只有剩余%和倒计时、无外推",
  "scope": ["lib/host.js"],
  "sources": ["lib/host.js"],
  "relations": [{"type": "consequence-of", "target": "D-001"}],
  "key": "quota-cold-start",
  "recorded_at": "2026-10-18"
}
```

## 为什么

采样速率存在 host 模块内存里，进程重启即失；外推在第二轮采样后恢复。冷启动期间警示色由粗钟兜底（剩 ≥60% 且 ≤48h 内重置仍会亮）。

## 验证缺口

外推数值的合理性（≥2 轮采样后 projectedWaste 是否贴近实际消耗）尚未实测，只验证了首次采样时字段按设计缺省。
