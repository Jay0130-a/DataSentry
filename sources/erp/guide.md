# ERP 经营数据源 · 使用说明

本 guide 在 Agent 调用本 Source 的任何工具**之前**必须被完整读取（`read_source_guide`）。
未读就调用会被 PreToolUse 阻断，错误码 `GUIDE_NOT_READ`。

## 能力范围

| 工具 | 用途 | 敏感级别 |
|---|---|---|
| `list_business_units` | 查询纳入报表的事业部主数据 | internal |
| `fetch_revenue` | 按期间查询主营收入 | internal |
| `fetch_cost` | 按期间查询主营成本 | internal |

本 Source **只读**，不含任何写入、调整或凭证过账能力。

## 参数范围

- `period`：会计期间，格式 `YYYY-MM`，例如 `2025-09`。取值范围为 2024-01 起。
- `buCodes`：事业部编码数组，取自 `list_business_units` 的返回值。**不要臆造编码**；
  省略该参数表示查询全部事业部。

## 结果契约

- 金额单位为**元**，为不含税口径。
- 每行包含 `buCode`、`buName` 与对应金额字段。
- 返回 `totalRevenue` / `totalCost` 为行合计，可直接用于交叉校验。
- 结果信封中的 `completeness` 若为 `partial`，表示当期部分事业部数据未结账，
  此时**不得**把该结果当作完整口径直接出报表。

## 停止条件

1. 已拿到所需的全部事业部数据，且 `completeness` 为 `full` → 停止取数，进入计算。
2. 同一工具以**相同参数**连续调用 2 次以上仍无新结果 → 停止，标记为异常，不要继续重试。
3. 返回 `completeness` 为 `partial` → 停止，不要用其它 Source 的数据补齐后当作完整口径，
   应在报表中显式标注。

## 禁止事项

- 禁止用 `fetch_revenue` 的结果反推成本，或反之；两个指标必须各自取数。
- 禁止对同一期间重复调用期望拿到不同结果——本数据源在期间内是确定的。
- 禁止把凭据信息写入参数、结果或报表产物。
