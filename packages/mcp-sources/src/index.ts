/**
 * @datasentry/mcp-sources —— 模拟数据源。
 *
 * 覆盖 PRD FR-01 要求的三种 Source 类型：
 * - `erp` / `finance`：MCP stdio 服务（`mcp-server.ts`）
 * - `warehouse`：HTTP 服务（`startWarehouseHttp`），真实读写 SQLite 数仓文件
 * - `excel`：local 类型，由 backend 的 LocalHandlerRegistry 进程内读取 xlsx
 *
 * 这些服务是**真实进程 + 真实文件**，不是内存桩：MCP 走 stdio 协议、
 * 数仓走 HTTP 与 SQLite、Excel 是真实 xlsx。这样 M2 的审批、M3 的恢复、
 * M4 的回归才有可测的对象。
 */
export * from './dataset.ts'
export * from './excel.ts'
export * from './paths.ts'
export * from './seed.ts'
export * from './sourceConfig.ts'
export * from './types.ts'
export * from './warehouse-http.ts'
export { erpHandlers } from './erp.ts'
export { financeHandlers } from './finance.ts'
