import { startWarehouseHttp, type ManagedService } from '@datasentry/mcp-sources'
import type { DataPaths } from '@datasentry/core'
import { ToolExecutionError } from './transports/types.ts'

export interface ManagedServiceOptions {
  paths: DataPaths
  port?: number | undefined
}

export type ManagedServiceStarter = (options: ManagedServiceOptions) => Promise<ManagedService>

/**
 * 由 DataSentry 自己拉起的模拟服务。
 *
 * 真实企业环境里 `http` 类型的 Source 指向外部系统，用配置里的 `baseUrl`；
 * 本地开发则用这里的 managed 服务起一个真实 HTTP 端口。两条路径在下游完全一致。
 */
const STARTERS: Record<string, ManagedServiceStarter> = {
  'warehouse-http': ({ paths, port }) => startWarehouseHttp({ paths, ...(port ? { port } : {}) }),
}

export function registeredManagedModules(): string[] {
  return Object.keys(STARTERS).sort()
}

/**
 * 管理服务生命周期。同一个 module 只启一次，多个 Source 共享。
 * 关闭由 `closeAll` 统一负责，避免进程退出后端口还占着。
 */
export class ManagedServiceManager {
  private readonly started = new Map<string, Promise<ManagedService>>()

  ensure(module: string, options: ManagedServiceOptions): Promise<ManagedService> {
    const existing = this.started.get(module)
    if (existing) return existing

    const starter = STARTERS[module]
    if (!starter) {
      throw new ToolExecutionError(
        'SOURCE_CONFIG_INVALID',
        `未注册的 managed 服务 "${module}"，已注册：${registeredManagedModules().join(', ') || '（无）'}`,
      )
    }

    const promise = starter(options)
    this.started.set(module, promise)
    return promise
  }

  async closeAll(): Promise<void> {
    const services = [...this.started.values()]
    this.started.clear()
    await Promise.allSettled(
      services.map(async (promise) => {
        const service = await promise
        await service.close()
      }),
    )
  }
}
