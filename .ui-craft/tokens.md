# 设计令牌规范

## 基础令牌

```css
:root {
  --ink-950: #111315;
  --ink-900: #17191b;
  --ink-850: #1d2022;
  --ink-800: #25282b;
  --ink-700: #34383c;
  --ink-500: #737a80;
  --ink-300: #b9bec2;
  --ink-100: #eef0f1;
  --amber-500: #e3a63a;
  --amber-300: #f4c76d;
  --green-400: #71bd91;
  --red-400: #e1766f;
  --blue-300: #84b8d9;
  --white: #ffffff;
}
```

## 语义令牌

- `--surface-app`: `--ink-950`
- `--surface-panel`: `--ink-900`
- `--surface-raised`: `--ink-850`
- `--surface-input`: `--ink-800`
- `--border-subtle`: `rgba(255,255,255,.09)`
- `--border-strong`: `rgba(255,255,255,.17)`
- `--text-primary`: `--ink-100`
- `--text-secondary`: `--ink-300`
- `--text-tertiary`: `--ink-500`
- `--accent-primary`: `--amber-500`
- `--state-success`: `--green-400`
- `--state-danger`: `--red-400`
- `--state-info`: `--blue-300`

## 组件令牌

- 字体：`Segoe UI`、`Microsoft YaHei` 和系统无衬线字体；等宽数值使用 `Cascadia Mono`、`Consolas`。
- 字号：元数据 11px、标签 12px、正文 13px、分区标题 15px、批次编号 24px。
- 间距：4 / 8 / 12 / 16 / 20 / 24px。
- 圆角：控件 3px、分组表面 5px、对话框 7px。
- 控件高度：桌面面板 32px；图标点击区域 32px，并显示清晰的焦点框。
- 阴影：`0 1px 2px rgba(0,0,0,.24), 0 0 0 1px rgba(255,255,255,.04)`；浮层只使用一圈浅色描边。
- 动效：颜色和透明度 120ms，抽屉 180ms；在 `prefers-reduced-motion` 下全部关闭。

## 使用规则

- 深色中性表面至少占面板的 90%；琥珀色只用于当前批次标记、主要操作和活动状态。
- 不使用渐变和层叠卡片，通过间距和细分隔线组织内容。
- 所有数字指标使用等宽数字；长路径尽量从中间截断。
