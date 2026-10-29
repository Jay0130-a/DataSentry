import { z } from 'zod'
import {
  authTypeSchema,
  isoTimestamp,
  jsonObject,
  sensitivitySchema,
  sideEffectSchema,
  SourceType,
  sourceTypeSchema,
} from './common.ts'

/**
 * 单个工具的声明。`paramsSchema` / `resultSchema` 用 JSON Schema 表达而不是 Zod，
 * 原因有二：一是它同时要喂给 MCP 服务端（MCP 协议本身就是 JSON Schema），
 * 二是它要能写进 `sources/<slug>/config.json` 被人直接阅读和编辑。
 * 后端在运行时用 `z.fromJSONSchema()` 转成校验器，得到 Zod 级别的错误信息。
 */
export const sourceToolSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  /** 会与 guide.md 一起注入给模型，必须写清楚能做什么、不能做什么。 */
  description: z.string().min(1),
  paramsSchema: jsonObject,
  resultSchema: jsonObject,
  sensitivity: sensitivitySchema,
  sideEffect: sideEffectSchema,
  /** 为 true 时，本 Session 未读过该 Source 的 guide 就调用会被 PreToolUse 阻断。 */
  requiresGuide: z.boolean().default(true),
  /**
   * 仅 `local` 类型使用：模块内 handler 函数名，省略时与工具名相同。
   * 模块本身由 `transport.module` 指定，这里指的是模块**里面**的那个函数。
   */
  handler: z.string().min(1).optional(),
  /**
   * 仅 `postgres` 类型使用：固定下来的参数化查询。
   *
   * SQL 写在配置里，不来自模型——模型只能填 `params` 声明的参数。
   * 这是「受控工具」和「让模型自由写 SQL」的分界线。
   */
  sql: z.string().min(1).optional(),
  /** 参数顺序：数组第 n 项对应 SQL 里的 `$n`。 */
  params: z.array(z.string().min(1)).default([]),
})

export type SourceToolConfig = z.infer<typeof sourceToolSchema>

const mcpStdioTransportSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** 静态环境变量；真正的凭据由 CredentialManager 在 spawn 时注入，不写在这里。 */
  env: z.record(z.string(), z.string()).default({}),
})

const httpTransportSchema = z
  .object({
    /**
     * 外部 HTTP 服务地址。与 `managed` 二选一。
     * 支持 `${REPO_ROOT}` / `${DATA_DIR}` 占位符，避免配置写死机器路径。
     */
    baseUrl: z.string().min(1).optional(),
    /** 工具调用的 HTTP 路径模板，`{tool}` 会被工具名替换。 */
    toolPath: z.string().default('/tools/{tool}'),
    timeoutMs: z.number().int().positive().default(10_000),
    /**
     * 由 DataSentry 自己拉起的本地模拟服务。真实企业环境接外部服务时删掉这段、
     * 只留 `baseUrl` 即可，其余代码路径完全一致。
     */
    managed: z
      .object({
        /** 内置服务名，在 ManagedServices 注册表中查找。 */
        module: z.string().min(1),
        /** 监听端口；省略则用操作系统分配的临时端口。 */
        port: z.number().int().min(1).max(65535).optional(),
      })
      .optional(),
  })
  .refine((t) => Boolean(t.baseUrl) !== Boolean(t.managed), {
    message: 'http 传输必须且只能配置 baseUrl 或 managed 其中之一',
  })

const localTransportSchema = z.object({
  /** 内置 handler 注册表的名字，例如 `excel-manual-adjustments`。 */
  module: z.string().min(1),
  /** handler 的运行时参数，例如 Excel 文件相对仓库根的路径。 */
  options: jsonObject.default({}),
})

const postgresTransportSchema = z.object({
  /**
   * 连接串所在的环境变量名。设置了就连真实 Postgres；
   * 没设置时回退到内嵌 PGlite（Postgres 的 WASM 构建）并把数据落到 `dataDir`。
   */
  connectionStringEnv: z.string().min(1).default('DATASENTRY_PG_URL'),
  /** 内嵌模式的数据目录，相对数据目录。 */
  dataDir: z.string().min(1).default('pg'),
  /** 单次查询超时，避免一条慢查询拖住整个任务。 */
  timeoutMs: z.number().int().positive().default(10_000),
})

const commonSourceShape = {
  slug: z.string().regex(/^[a-z][a-z0-9-]*$/, 'slug 只能是小写字母、数字与连字符'),
  title: z.string().min(1),
  description: z.string().min(1),
  auth: z.object({
    type: authTypeSchema,
    /** 凭据在 credentials.json / 环境变量中的键名；其值永不进入模型上下文。 */
    credentialKey: z.string().min(1).optional(),
  }),
  tools: z.array(sourceToolSchema).min(1),
  guide: z.string().min(1).default('guide.md'),
}

/** `sources/<slug>/config.json` 的形态（PRD FR-01.1）。 */
export const sourceConfigSchema = z.discriminatedUnion('type', [
  z.object({
    ...commonSourceShape,
    type: z.literal(SourceType.MCP_STDIO),
    transport: mcpStdioTransportSchema,
  }),
  z.object({
    ...commonSourceShape,
    type: z.literal(SourceType.HTTP),
    transport: httpTransportSchema,
  }),
  z.object({
    ...commonSourceShape,
    type: z.literal(SourceType.LOCAL),
    transport: localTransportSchema,
  }),
  z.object({
    ...commonSourceShape,
    type: z.literal(SourceType.POSTGRES),
    transport: postgresTransportSchema,
  }),
])

export type SourceConfig = z.infer<typeof sourceConfigSchema>

/** DB 中的 source 行（PRD §7）。 */
export const sourceSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  slug: z.string().min(1),
  type: sourceTypeSchema,
  configRef: z.string().min(1),
  guideRef: z.string().min(1),
  authType: authTypeSchema,
  enabled: z.boolean(),
  /** config.json + guide.md 的内容摘要，作为工具版本参与审批绑定。 */
  version: z.string().min(1),
  createdAt: isoTimestamp,
})

export type Source = z.infer<typeof sourceSchema>
