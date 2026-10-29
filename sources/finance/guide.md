# 财务系统数据源 · 使用说明

本 guide 在 Agent 调用本 Source 的任何工具**之前**必须被完整读取。
未读就调用会被 PreToolUse 阻断，错误码 `GUIDE_NOT_READ`。

## 能力范围

| 工具 | 用途 | 敏感级别 | 副作用 |
|---|---|---|---|
| `fetch_budget` | 查询收入预算与费用预算 | internal | 只读 |
| `fetch_expense_detail` | 查询逐笔费用明细 | **confidential** | 只读 |

## 参数范围

- `period`：会计期间，格式 `YYYY-MM`，例如 `2025-09`。
- `buCodes`：事业部编码数组，取自 ERP 的 `list_business_units`。
- `category`：费用类别，取值限定为
  `差旅费` / `市场推广费` / `咨询服务费` / `办公与租赁` / `研发材料费`。

## 结果契约

- 金额单位为元。
- `fetch_expense_detail` 的每一行包含 `expenseId`、`claimant`（报销人）、`amount`、
  `voucherNo`（审批单号）、`incurredOn`（发生日期）。

## 敏感数据特别约定

`fetch_expense_detail` 返回的是**可定位到具体自然人和单笔金额**的明细数据，属机密级别：

1. **必须**走审批流程（Permission Mode 为 `ask` 时触发 `APPROVAL_REQUIRED`）。
2. 审批绑定的是「本次工具调用 + 本次参数摘要」。改动 `period`、`buCodes` 或 `category`
   中的**任何一项**，原审批立即失效，必须重新走审批。
3. 明细数据**不得**整体写入对外发布的报表产物。经营月报只允许使用按类别汇总后的金额；
   若确有明细进报表的需要，必须由人工在 `MANUAL_REVIEW` 状态下确认。
4. 报销人姓名不得出现在事件轨迹的 payload 中，只记录行数与合计。

## 停止条件

1. 预算差异所需的预算数据已取齐 → 停止。
2. 费用明细被拒绝审批（`APPROVAL_REQUIRED` 或 `approval.denied`）→ **立即停止**本步骤，
   不要换参数重试、不要绕过审批改用其它 Source 推断明细金额。任务应停在 `BLOCKED`，
   等待人工决定。
3. 审批等待期间不得推进后续步骤，也不得重新规划。

## 禁止事项

- 禁止在审批被拒后，用 ERP 的成本数据「估算」费用明细。
- 禁止为提高审批通过率而拆分或缩小查询范围（例如把一个事业部的明细拆成多次小范围查询）。
- 禁止把报销人、单笔金额、凭据写入报表产物或日志。
