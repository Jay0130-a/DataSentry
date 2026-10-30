---
name: DataSentry WebUI
description: 报表 Agent 工作台的深色、数据密集型运营控制台
colors:
  primary: "#7aa2ff"
  primary-strong: "#9bbaff"
  primary-soft: "#1b2942"
  primary-light: "#1d4ed8"
  primary-strong-light: "#1e40af"
  primary-soft-light: "#e8f0fe"
  on-primary: "#0b1220"
  background: "#121419"
  surface: "#181b21"
  surface-sunken: "#1d2128"
  border: "#2a2f37"
  border-strong: "#3b424d"
  control-border: "#626b78"
  text: "#e8eaed"
  text-muted: "#a0a7b2"
  ok: "#6fd39c"
  ok-soft: "#142d1f"
  waiting: "#e5b45c"
  waiting-soft: "#332810"
  bad: "#ff938a"
  bad-soft: "#3a1a18"
  selection: "#2b4470"
  background-light: "#f4f6f8"
  surface-light: "#ffffff"
  surface-sunken-light: "#eef1f4"
  border-light: "#dfe3e8"
  control-border-light: "#8a94a3"
  text-light: "#1b1f24"
  text-muted-light: "#5f6773"
  ok-light: "#16794a"
  waiting-light: "#8a5a00"
  bad-light: "#b3261e"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.35
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  data:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "tnum"
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "0.01em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.35
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    height: "30px"
    padding: "0 12px"
  button-primary-hover:
    backgroundColor: "{colors.primary-strong}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    height: "30px"
    padding: "0 12px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "30px"
    padding: "0 12px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "30px"
    padding: "4px 10px"
  badge-ok:
    backgroundColor: "{colors.ok-soft}"
    textColor: "{colors.ok}"
    rounded: "{rounded.pill}"
    height: "20px"
    padding: "1px 8px"
  badge-waiting:
    backgroundColor: "{colors.waiting-soft}"
    textColor: "{colors.waiting}"
    rounded: "{rounded.pill}"
    height: "20px"
    padding: "1px 8px"
  badge-bad:
    backgroundColor: "{colors.bad-soft}"
    textColor: "{colors.bad}"
    rounded: "{rounded.pill}"
    height: "20px"
    padding: "1px 8px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  nav-item-active:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
---

# Design System: DataSentry WebUI

## Overview

**Creative North Star: "运维账本"**

DataSentry 是一个工作台，不是营销页。界面要像一本可对账的运营账本：每个状态、绑定和回执都能被核对。密度是功能，克制是品牌。系统把 12 个任务状态压成四个视觉族（running / ok / waiting / bad），等宽字体只用于机器标识。深色是基线，因为运维人员会长时间盯着屏幕；浅色是同一套语义的镜像回退。表面保持平面，用 1px 边框和色调分层表达深度，不靠投影。

**Key Characteristics:**
- 高密度：13px 表格、30px 控件、单行 34.5px、双行 48.7px。
- 状态族有颜色，也有文字与圆点，不依赖颜色单独传达。
- 一套系统无衬线承担全部 UI；等宽只服务数据。
- 平面、色调分层，没有装饰性阴影。
- 完全离线：只用系统字体，不请求外部字体。

## Colors

调色板性格：企业蓝负责交互与进行中，信号琥珀负责等待/审批，红绿只给终态。

### Primary

- **企业蓝（Enterprise Blue）**（深色 #7aa2ff / 浅色 #1d4ed8）：主按钮、激活导航、焦点环、进行中徽标、链接。
- **企业蓝-深（Enterprise Blue Strong）**（深色 #9bbaff / 浅色 #1e40af）：主按钮 hover。
- **企业蓝-柔（Enterprise Blue Soft）**（深色 #1b2942 / 浅色 #e8f0fe）：选中导航、进行中徽标底、primary hover 底。

### Secondary

- **信号琥珀（Signal Amber）**（深色 #e5b45c / 浅色 #8a5a00）：等待审批、待确认、发布确认类别。它不是错误色。
- **信号琥珀-柔（Signal Amber Soft）**（深色 #332810 / 浅色 #fcf1da）：等待徽标与提示块底。

### Tertiary

- **确认绿（Confirmed Green）**（深色 #6fd39c / 浅色 #16794a）：DONE / READY / granted / succeeded。
- **阻断红（Blocked Red）**（深色 #ff938a / 浅色 #b3261e）：BLOCKED / FAILED / denied，以及危险动作。

### Neutral

- **Night Ink**（深色 #121419 / 浅色 #f4f6f8）：页面背景。
- **Panel**（深色 #181b21 / 浅色 #ffffff）：面板与卡片表面。
- **Sunken**（深色 #1d2128 / 浅色 #eef1f4）：表头、中性 chip、后退一层的填充。
- **Hairline**（深色 #2a2f37 / 浅色 #dfe3e8）：面板/卡片/表格的 1px 边框。
- **Control Edge**（深色 #626b78 / 浅色 #8a94a3）：输入框边界，对表面对比度 ≥3:1。
- **Ledger Text**（深色 #e8eaed / 浅色 #1b1f24）：主文字。
- **Muted Ledger**（深色 #a0a7b2 / 浅色 #5f6773）：次要文字、表头、元数据。

### Named Rules

**The Signal Scarcity Rule.** 蓝色是唯一交互强调色，只出现在主操作、当前选中、焦点和进行中状态；它不做背景铺底，也不做装饰。

**The Waiting-Is-Not-Error Rule.** 琥珀表示「需要人做决定」，不是失败。红色只留给阻断、失败、拒绝和破坏性动作。

**The Terminal-Only Rule.** 绿色和红色只描述终态；进行中的状态一律是蓝色。

## Typography

**Display / Body Font:** system UI sans（system-ui, Segoe UI, PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif）
**Label/Mono Font:** system monospace（ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace）

**Character:** 一套系统无衬线承担全部 UI；等宽是数据仪器，不是风格道具。中文留在系统 CJK 栈上，不发起外部字体请求。

### Hierarchy

- **Headline**（600，18px，1.35）：仅登录页标题。
- **Title**（600，15px，1.35）：面板标题。
- **Body**（400，14px，1.5）：基础 UI 文案。
- **Data**（400，13px，1.5，tabular-nums）：表格单元格与数字。
- **Label**（500，12px，1.35，0.01em）：表头、字段标签、元数据。
- **Mono**（400，12px，1.35）：ID、哈希、时间戳、事件类型、错误码。

### Named Rules

**The One-Family Rule.** 不做 display/body 配对。层级靠字号和字重，第二套无衬线只是噪音。

**The Mono-Is-Data Rule.** 等宽只用于机器标识和度量值，不用于标题、按钮或中文正文。

## Layout

桌面优先，内容列最大 1280px，页面左右 24px，面板间距 16px。间距用 4px 基数：4/8/12/16/20/24/32/40。控件高 30px；表格单元格 6px×10px，单行行高 34.5px、双行 48.7px。面板头 12px×16px，面板体 16px。断点：960px 顶栏换行；760px 收紧页面并把时间线改为堆叠。表格保持 760px 最小宽度，在窄屏由面板内部横向滚动；页面本身不产生横向溢出。密度是刻意的：数据 13px、标签 12px、等宽 12px。

## Elevation & Depth

默认平面。深度来自三层表面（background / surface / sunken）和 1px 边框，不靠阴影。`--shadow-sm` 已定义但静止状态不使用。表头与中性 chip 落在 sunken 层；面板和卡片落在 surface 层。Hover 是 4.5% 白（深色）或 4.5% 黑（浅色）叠加，不是抬升。

**The Flat-By-Default Rule.** 需要强调一个表面时，先改色调或边框；不要先加阴影。

## Shapes

导航项和小控件 6px，按钮/输入/卡片 8px，面板 10px，徽标和 chip 用 999px。边框一律 1px。不使用彩色左边条；状态由圆点加文字承担。面板裁切子元素，内部滚动容器承担横向溢出。

## Components

### Buttons

- **Shape:** 8px 圆角，30px 高，左右 12px 内边距。
- **Primary:** 企业蓝底，on-primary 文字；hover 用 primary-strong。
- **Secondary:** surface 底，1px border-strong；hover 变 accent-soft 配 accent 文字。
- **Danger:** surface 底，红色调边框，bad 文字；hover 填 bad-soft。
- **Focus:** 2px focus-ring outline，偏移 2px；disabled 透明度 0.45。

### Chips

- **Style:** pill，26px 高，sunken 底，12px 文字，1px 边框。
- **State:** 激活用 primary-soft 底和 primary 文字；hover 同色，不改变尺寸。

### Cards / Containers

- **Corner Style:** 面板 10px，卡片 8px。
- **Background:** surface；表头和中性徽标可用 sunken。
- **Shadow Strategy:** 静止状态无阴影。
- **Border:** 1px hairline。
- **Internal Padding:** 面板头 12px 16px，面板体 16px；卡片 12px 16px。

### Inputs / Fields

- **Style:** surface 底，1px control-border（≥3:1），8px 圆角，30px 高。
- **Focus:** accent 边框加 2px 焦点环；placeholder 使用 text-muted，opacity 1。
- **Disabled:** 透明度 0.55，不换色。

### Navigation

顶栏 56px 高，surface 底，底部 1px hairline。导航项 34px 高、6px 圆角、12px/500 文字；激活是 primary-soft 底配 primary 文字，hover 是 4.5% 叠加。960px 时顶栏换行，导航保持水平。

### Badges

20px 高，pill，12px/500。状态族带 5px currentColor 圆点；中性类别徽标不带圆点。类别徽标不能用红色（例如「取数审批」），用中性或琥珀。

### Tables

13px 数据落在 surface，表头 12px/500 落在 sunken，单元格 6px 10px，行间 1px 分隔。数字右对齐并使用 tabular-nums。可点击行用 4.5% hover 叠加和 2px 内嵌焦点环。表头带 `scope="col"`。表格最小宽度 760px，窄屏由面板内部横向滚动。

### Timeline

四列网格：44px 序号、180–220px 类型、弹性摘要、自适应时间。序号和类型用 12px 等宽；摘要是 13px muted；状态圆点 5px。序号与 JSONL 一致（`padStart(3, '0')`）。不使用左边条；圆点和行底边承担节奏。

## Do's and Don'ts

### Do:

- **Do** 使用语义 token；`:root` 之外不写死 hex。
- **Do** 表格保持 13px、控件保持 30px；密度就是产品。
- **Do** 琥珀只给等待/审批，红绿只给终态。
- **Do** 等宽只用于 ID、哈希、时间戳、事件类型和错误码。
- **Do** 每个可交互元素保留 2px 焦点环和 2px 偏移。
- **Do** 表头和中性 chip 使用 sunken 层。

### Don't:

- **Don't** 在静止状态加阴影，或用玻璃/模糊做装饰。
- **Don't** 使用渐变文字或超过 1px 的彩色左边条。
- **Don't** 用红色表示中性类别徽标。
- **Don't** 给 UI 配第二套 display 字体；一套系统字族就是声音。
- **Don't** 引入外部字体；部署环境完全离线。
- **Don't** 让 20px 状态徽标成为状态机的唯一表达。
