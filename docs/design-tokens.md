# dsh-model-picker · Design Token 文档 v1.0

2026-10-18，issue E246AB80AEE4-17。Token 定义在 `lib/client.js` CSS 模板的 `.dsh-mp2-root{}` 块；全部规则只消费 token，不再写字面量。宿主层 token（`--dsw-alias-*` / `--dsw-specific-menu`）是面板的上游，本表只收插件自有层。

## Color

| Token | 值 | 用途 |
|---|---|---|
| `--dsh-mp2-surface` | `rgb(from var(--dsw-specific-menu) r g b / 1)` | 面板不透明底（一次性解析，防接缝） |
| `--dsh-mp2-ink-dim` | `var(--dsw-alias-label-secondary)` | 次级文字（≥4.5:1） |
| `--dsh-mp2-ink-faint` | `var(--dsw-alias-label-tertiary)` | 仅限非文字图形（≥3:1），禁止用于文字 |
| 状态色 | 直接用 `--dsw-alias-state-{success,error,warning}-primary` | 连通/额度·认证/限流·超时，失败兜底 `#e5484d` |

## Typography

| Token | 值 | 用途 |
|---|---|---|
| `--dsh-mp2-font-lg` / `--dsh-mp2-lh-md` | 14px / 20px | 模型名（配 `--dsh-mp2-weight-medium`） |
| `--dsh-mp2-font-md` / `--dsh-mp2-lh-md` | 13px / 20px | 触发器、搜索框、状态行、星标、pin |
| `--dsh-mp2-font-sm` / `--dsh-mp2-lh-sm` | 12px / 18px | 描述行、错误/警告、footer 动作、回执、failover 胶囊 |
| `--dsh-mp2-font-xs` / `--dsh-mp2-lh-xs` | 11px / 16px | 分组标题、provider 计数/额度、facts、失败/批测标记、pane 小标题 |
| `--dsh-mp2-font-2xs` | 10px | 仅头像首字母 |
| `--dsh-mp2-weight-medium` / `--dsh-mp2-weight-semibold` | 500 / 600 | 名称·触发器 / 标题·头像·重试 |

层级靠字号+字重区分，不靠颜色（色板只有一档 ink）。

## Radius

| Token | 值 | 用途 |
|---|---|---|
| `--dsh-mp2-radius-chip` | 6px | 头像、context chip、行内小按钮（批测/测试按钮，5px 已归并） |
| `--dsh-mp2-radius-control` | 8px | 按钮/输入框类控件 |
| `--dsh-mp2-radius-row` | 10px | 列表行 |
| `--dsh-mp2-radius-panel` | 12px | 面板 |
| `--dsh-mp2-radius-pill` | 999px | failover/autoNote 胶囊 |
| `--dsh-mp2-radius-cap` | 24px | 触发器两端圆帽 |

## Spacing

| Token | 值 | 用途 |
|---|---|---|
| `--dsh-mp2-gap-2xs` | 2px | 名称行内图形间隙、列内缩进类 gap |
| `--dsh-mp2-gap-xs` | 4px | chip 与名间距、body 行距、failover 堆叠（5px 已归并） |
| `--dsh-mp2-gap-sm` | 6px | provider 行内、胶囊按钮内图标间距 |
| `--dsh-mp2-gap-md` | 8px | 表头、行内左右呼吸、错误提示间距 |

组合 padding（如 `6px 8px`）是各组件自己的布局决定，不强行 token 化；复用发生在一维 token 上。

## Motion / Layout

| Token | 值 | 用途 |
|---|---|---|
| `--dsh-mp2-ease-out` | cubic-bezier(0.23,1,0.32,1) | 全部过渡（160ms） |
| `--dsh-mp2-menu-width` / `-folded` | 540px / 352px | 面板宽（折叠=减列不减列表） |
| `--dsh-mp2-menu-height` | 500px | 面板高预算（clamp 兜底） |
| `--dsh-mp2-chip-size` / `-gap` | 16px / var(--dsh-mp2-gap-xs) | 供应商徽标几何 |

## 组件消费速查

| 组件 | 关键 token |
|---|---|
| 触发器 | font-md/lh-md/weight-medium, radius-cap |
| 模型行 | min-height 38, font-lg/weight-medium 名称, font-sm 描述, facts font-xs, radius-row |
| provider 列 | font-sm 名称, font-xs/semibold 计数·额度·分组标题, radius-chip |
| 兜底行 | 与模型行同行盒；标记 font-xs/lh-xs, radius-chip 动作按钮 |
| failover/autoNote | font-sm/lh-sm, radius-pill, gap-sm |
| footer | font-sm/lh-sm, gap-xs（原 5px） |

## 验证

`scripts/style-snapshot.mjs`（改前/改后计算样式快照 + JSON diff）：2026-10-18 diff 共 3 条，全部为有意归并——`.dsh-mp2-footerAction` gap 5→4px，`.dsh-mp2-fallbackProbe`/`.dsh-mp2-fallbackTest` radius 5→6px；其余选择器逐属性 0 差异。

## 维护规则

1. 新样式一律查本表用 token，不写 px 字面量（高度/复合 padding 等布局值除外，需注释理由）。
2. 改设计 = 改 token 定义一处；用 `grep 'var(--dsh-mp2-'` 盘点消费面。
3. 改 token 后跑 `style-snapshot.mjs` 前后对比，diff 只允许出现有意归并项。
