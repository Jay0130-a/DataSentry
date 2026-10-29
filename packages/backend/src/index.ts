/**
 * @datasentry/backend —— API、Harness、Runtime、Agent Loop、Source 接入。
 *
 * 分层（PRD §9）：
 * - `sources/`   接入层：把外部能力变成受控工具（mcp-stdio / http / local）
 * - `harness/`   权限链、Skill 加载、工具注册、guide 追踪
 * - `runtime/`   Session 状态机、检查点、乐观锁
 * - `agent/`     AgentBackend 抽象与 Agent Loop
 * - `reports/`   指标规则、校验、草稿产物
 * - `server/`    Fastify API
 * - `db/`        状态库
 */
export * from './agent/backend.ts'
// 两个后端都有 buildMessages，导出时加前缀避免歧义。
export {
  ClaudeAgentBackend,
  createClaudeClient,
  buildMessages as buildClaudeMessages,
} from './agent/claude-backend.ts'
export type {
  ClaudeBackendOptions,
  ClaudeClientLike,
  ClaudeContentBlock,
  ClaudeResponse,
} from './agent/claude-backend.ts'
export {
  OpenAiCompatibleBackend,
  createOpenAiCompatibleBackend,
  buildMessages as buildOpenAiMessages,
} from './agent/openai-backend.ts'
export type { FetchLike, OpenAiBackendOptions } from './agent/openai-backend.ts'
export {
  PiAiBackend,
  resolvePiModel,
  buildMessages as buildPiMessages,
} from './agent/pi-ai-backend.ts'
export type { PiAiBackendOptions, PiAiClient, PiCompleteOptions } from './agent/pi-ai-backend.ts'
export * from './agent/loop.ts'
export * from './agent/mock-backend.ts'
export * from './agent/model-config.ts'
export * from './agent/planner.ts'
export * from './agent/prompt.ts'
export * from './auth/password.ts'
export * from './auth/service.ts'
export * from './context.ts'
export * from './credentials/manager.ts'
export * from './db/index.ts'
export * from './events/event-store.ts'
export * from './harness/guide-tracker.ts'
export * from './harness/permission-mode.ts'
export * from './harness/pretooluse.ts'
export * from './harness/skill-loader.ts'
export * from './harness/tool-registry.ts'
export * from './reports/draft.ts'
export * from './reports/metrics.ts'
export * from './reports/publish-service.ts'
export * from './reports/publishing.ts'
export * from './reports/validate.ts'
export * from './runtime/approval-store.ts'
export * from './runtime/checkpoint.ts'
export * from './runtime/report-store.ts'
export * from './runtime/session-store.ts'
export * from './runtime/tool-call-store.ts'
export * from './server/app.ts'
export * from './sources/builder.ts'
export * from './sources/loader.ts'
export * from './sources/managed-services.ts'
export * from './sources/placeholders.ts'
export * from './sources/transports/types.ts'
export * from './workspace/loader.ts'
