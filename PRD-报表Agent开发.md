# 企业内部报表 Agent 开发 PRD

## 1. 文档信息

| 项目 | 内容 |
|---|---|
| 项目名称 | DataSentry |
| 文档版本 | v1.0 |
| 状态 | 开发立项稿 |
| 目标形态 | 自研可运行的报表 Agent 工作台 |
| 项目性质 | 个人/小组自主开发项目，可独立交付与演进 |

## 2. 项目概述

### 2.1 背景

企业内部财务和经营分析人员需要跨 ERP、财务系统、数据仓库、Excel 等系统取数、核对口径、制作报表并发布。传统 ETL / BI 能覆盖固定报表，但难以处理自然语言临时需求、多系统工具选择、审批等待、任务中断恢复和过程审计。

### 2.2 项目目标

构建一个可通过自然语言发起报表的 Agent 工作台，让 Agent 在受控工具、权限审批、可恢复状态和事件回归边界内完成：

```text
需求理解 → 跨系统取数 → 权限审批 → 报表生成 → 发布交付
```

核心目标是让 Agent“会用工具但不越权、任务长但不失控、过程可审计、版本可回归”。

### 2.3 成功口径

1. 打通至少 3 类数据源：本地模拟 ERP/财务服务、Excel 文件、SQLite 数据仓库。
2. 完成一条完整经营月报链路：收入取数 → 费用明细审批 → 指标计算 → 草稿生成 → 发布确认 → 回执。
3. 权限回归覆盖 ALLOW、ASK、DENY 三类结果，跨 Workspace 访问被拒绝。
4. 服务重启后能从最后检查点恢复，不重新规划、不重放已完成步骤。
5. 固定样本 + 事件轨迹回归可自动输出 PASS/FAIL 和首个异常步骤。

## 3. 用户与角色

| 角色 | 使用场景 | 核心诉求 |
|---|---|---|
| 财务人员 | 按月发起经营月报、费用明细报表 | 少手工取数，敏感数据自动走审批 |
| 经营分析人员 | 临时查询收入、毛利、预算差异 | 快速拿到口径一致的数据 |
| 部门管理者 | 查看报表并审批敏感取数/发布 | 审批想看清楚批的是什么，可审计 |
| 管理员/开发者 | 接入 Source、编辑 Skill、查回归 | 配置和排障可控、可验证 |

## 4. 范围与边界

### 4.1 本期做

- 自然语言发起报表任务
- Source 接入（MCP stdio / HTTP API / local）
- Skill 任务编排
- Permission Mode + PreToolUse 权限链
- 审批绑定与执行前二次确认
- Workspace / Session 状态隔离与恢复
- AgentEvent 事件轨迹与固定样本回归
- 发布确认与回执查询

### 4.2 本期不做

- 不直接执行任意 SQL
- 不接入真实企业 ERP/财务系统（先做本地模拟源）
- 不做 SaaS 多租户数据库行级隔离（数据平台职责）
- 不做报表模板市场、复杂 BI 可视化
- 不自动生成 Skill（Skill 由人配置）

## 5. 核心业务流程

```text
用户发起需求
  -> 识别部门/报表域（Workspace）
  -> 创建任务（Session）
  -> 选择 Skill
  -> 预启用 requiredSources
  -> SourceServerBuilder 构建受控工具
  -> Agent 规划并调用工具
  -> Permission Mode + PreToolUse 判定
  -> ALLOW 执行 / ASK 审批 / DENY 阻断
  -> ToolResult Schema 校验
  -> 指标规则计算
  -> 完整性与口径冲突校验
  -> 报表草稿
  -> 发布二次确认
  -> 发布与回执
  -> AgentEvent 事件轨迹落库
```

## 6. 功能需求

### FR-01 Source 接入与受控工具化

**描述：** 统一接入本地模拟 ERP、财务服务、数仓和 Excel，把外部能力变成 Agent 可调用的受控工具。

**规则：**

1. 每个 Source 包含 `config.json`（连接、认证、命令）和 `guide.md`（参数范围、结果契约、停止条件）。
2. Source 类型支持 MCP stdio、HTTP API、local 三种。
3. 凭据由 CredentialManager 在运行时注入，不进入模型上下文。
4. 工具输入输出通过 Schema 校验；取数结果返回 `resultId`、`sourceRef`、`dataVersion`、`completeness`。
5. 未读 guide 的工具调用被 PreToolUse 阻断。

**验收标准：**

- 三个模拟数据源可配置为 Source，并生成工具名 `mcp__{source}__{tool}`。
- 凭据不出现在模型上下文、日志和报表产物中。
- Schema 非法的调用在执行前被拒绝。

### FR-02 Skill 与任务编排

**描述：** 用 SKILL.md 定义某类报表的指标、工具顺序、停止条件和输出要求。

**规则：**

1. frontmatter 声明 `name`、`description`、`requiredSources`。
2. body 定义步骤、停止条件和禁止事项。
3. `requiredSources` 写 Source slug，不写具体工具名。
4. 运行中 Session 固定 Skill 版本。

**验收标准：**

- 经营月报 Skill 正确依赖 ERP、财务、发布三个 Source。
- 跳过 guide、跳过收入查询、无审批读取费用明细等违规步骤被阻断。

### FR-03 权限与审批

**描述：** 工具执行前的硬边界和敏感动作审批。

**规则：**

1. Permission Mode：`safe` 只读；`ask` 敏感动作审批；`allow-all` 跳过通用审批但不放开业务合同。
2. PreToolUse 检查：工具注册、Source 激活、guide 已读、参数 Schema、Workspace 边界、敏感级别、副作用、审批有效性。
3. 审批绑定 Workspace、Session、ToolCall、工具版本、参数摘要、有效期。
4. 正式发布单独二次确认，绑定草稿版本和接收人。

**验收标准：**

- 普通聚合 ALLOW；费用明细 ASK；未注册工具、跨 Workspace Source DENY。
- 参数变化或接收人变化后旧审批失效。

### FR-04 Runtime 状态隔离与恢复

**描述：** Workspace 管长期配置，Session 管单次任务状态，支持检查点恢复。

**规则：**

1. Session 状态机：`INIT → PLANNING → FETCHING → WAITING_APPROVAL → COMPUTING → VALIDATING → READY → DONE`，异常为 `PAUSED / BLOCKED / MANUAL_REVIEW / FAILED`。
2. 每个安全步骤保存检查点，记录 state、step、state_version、input_version、output_ref、approval_ref。
3. 审批恢复必须恢复原 ToolCall 并校验参数摘要。
4. 状态更新带版本号，防止旧执行器覆盖新状态。

**验收标准：**

- 审批等待期间服务重启，恢复原 ToolCall，不重新规划。
- 已完成步骤不重放；发布结果未知先查回执，不直接重发。

### FR-05 评测与回归

**描述：** 用固定样本和事件轨迹做端到端回归。

**规则：**

1. 样本集覆盖正常、审批、拒绝、凭据过期、部分结果、Schema 不兼容、审批漂移、重启恢复、发布变化、回执未知等路径。
2. 每个样本固定输入、配置、数据/规则/Skill 版本和期望事件序列。
3. 确定性程序按样本期望逐步骤校验实际轨迹，输出首个异常步骤。

**验收标准：**

- 自动化程序输出 PASS/FAIL 和首个异常步骤。
- 权限、状态、Schema、恢复为确定性校验；LLM Judge 仅作辅助。

### FR-06 发布与回执

**描述：** 报表发布前二次确认，发布后查询回执。

**规则：**

1. 发布前检查完整性、指标冲突、数据版本、接收人范围。
2. 发布确认绑定草稿版本和接收人。
3. 发布结果未知时先查询回执，已发送不重发，未确认转人工。

**验收标准：**

- 接收人变化后原确认失效。
- 超时结果未知时不重复发布。

## 7. 数据模型

```text
workspace：id、name、sources、skills、default_permission_mode、rule_version、currency、timezone
session：id、workspace_id、state、step、state_version、skill_version、input_version、created_at
source：id、workspace_id、slug、type、config_ref、guide_ref、auth_type、enabled
skills：id、name、description、required_sources、version、stop_rules
tool_call：id、session_id、tool_name、params_hash、status、result_ref
approval：id、session_id、tool_call_id、approver、params_hash、expires_at、status
checkpoint：session_id、step、state_version、input_version、output_ref、approval_ref
event：session_id、trace_id、event_type、payload、timestamp
report：id、session_id、draft_version、status、recipients_hash、receipt_id
```

## 8. 非功能需求

| 类别 | 要求 |
|---|---|
| 性能 | 单任务 P50 秒级可完成；聚合查询端到端可控 |
| 可用性 | 服务重启后任务可恢复；单任务失败不影响其他任务 |
| 安全 | 凭据不进上下文/日志；审批绑定参数；工具级权限与数据平台权限分离 |
| 审计 | 每次工具调用、审批、发布都有事件记录 |
| 可扩展 | 新 Source 通过配置接入；评测样本可扩展 |
| 可维护 | Skill/规则/权限版本化，支持对比回归 |

## 9. 技术架构建议

```text
前端（可选）React / 简单 Console
  -> 后端 API 服务
  -> AgentBackend 抽象（Claude SDK / Pi Agent SDK / OpenAI-compatible）
  -> Harness：Permission Mode、PreToolUse、Skill 加载、工具注册
  -> Runtime：Session 状态机、检查点、恢复、并发控制
  -> 接入层：MCP stdio / HTTP API / local / SourceServerBuilder
  -> 存储：状态库 + JSONL 事件轨迹 + 对象存储
```

建议技术栈（已确认）：

- 后端：TypeScript + Node.js，HTTP 框架 Fastify
- 前端：React + Vite + TypeScript；M1 先做 Console，M3 起接入最小 WebUI（会话/任务查看页），后续可选 Electron
- 工具协议：MCP SDK（stdio / HTTP）
- 模型：通过 AgentBackend 抽象接 Claude / OpenAI-compatible；本地开发默认 Mock 模型，实现后可随时切换
- 状态存储：MVP 用 SQLite + JSONL 事件轨迹；后续可迁移 PostgreSQL
- 对象存储：本地目录 / MinIO
- 评测：TypeScript 回归脚本 + YAML 样本
- 部署：Docker（可选）
- ORM/数据库访问：Drizzle ORM

### 已确认技术决策

1. 后端 HTTP 框架：Fastify。
2. ORM：Drizzle ORM。
3. 模型：MVP 默认本地 Mock；AgentBackend 预留 OpenAI-compatible / Claude 接口，后续可切换。
4. 前端：M1 只做 Console（API + CLI 验证链路）；最小 WebUI 在 M3 起接入。

## 10. 开发里程碑

### M1 基础链路（第 1-2 周）

- Source 基础类型与 config/guide 加载
- 简单 Agent Loop + 工具调用
- 收入取数 → 计算 → 草稿
- 固定样本最小集
- 交付形态为 Console：Fastify API + 启动脚本，不做 WebUI

### M2 权限与审批（第 3-4 周）

- Permission Mode
- PreToolUse 检查链
- 费用明细 ASK
- 审批绑定与恢复
- 发布二次确认

### M3 状态与恢复（第 5-6 周）

- Session 状态机
- 检查点与 JSONL 事件轨迹
- 服务重启恢复
- `state_version` 条件更新
- 最小 WebUI：任务列表、Session 状态、事件轨迹查看页

### M4 评测与发布闭环（第 7-8 周）

- 固定样本扩展为 8-10 类路径
- 事件轨迹回归输出首个异常
- 发布回执与结果未知处理
- 版本化回归报告

## 11. 验收测试清单

- 3 个 Source 正常接入并生成工具
- 经营月报全链路可跑通
- 无审批直读费用被拒（APPROVAL_REQUIRED）
- 接收人变化导致发布确认失效
- 重启后恢复原 ToolCall，不重新规划
- 事件轨迹回归自动输出 PASS/FAIL 和首个异常
- 跨 Workspace Source 被拒绝

## 12. 风险与待确认

1. 技术栈已确定：TS + React，后端 Fastify，ORM Drizzle，模型默认 Mock 可切换，M1 只做 Console；WebUI 范围以 M3 最小查看页为准。
2. 真实企业数据源接入属于后期扩展，MVP 用本地模拟服务。
3. 是否要前端界面，或 MVP 只做 Console/API。
4. 模型供应商与成本预算需确认。
5. Workspace/Session 不等于数据库行级权限，边界要在文档和代码中明确。

## 13. 交付 Coding Agent 的约定

1. 本 PRD 为 MVP 范围，coding agent 只实现第 6-11 节内容，不做“本期不做”的模块。
2. 仓库建议结构：

```text
packages/backend      TS API + Agent Loop + Harness + Runtime
packages/mcp-sources  Source / MCP 模拟服务
packages/web          React + Vite 前端
packages/core         类型、Schema、事件定义
tests/evals           固定样本与回归脚本
```

3. 必须先实现 Mock 数据源和 Mock 模型，保证无外部依赖可运行。
4. 每条 FR 的验收标准都要对应至少一个自动化测试或回归样例。
5. AgentEvent 事件轨迹必须写入 JSONL，并可由回归脚本读取。
6. 权限、审批、状态恢复是正确性核心，不能用 Prompt 替代。
7. 交付时提供 README、启动命令、样本配置和回归报告说明。
8. coding agent 可以第一步先生成完整仓库骨架与目录，但功能实现仍按 M1-M4 顺序分片交付，每片跑通对应测试后再进入下一片。
