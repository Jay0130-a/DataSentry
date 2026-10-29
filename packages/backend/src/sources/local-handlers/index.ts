import { excelManualAdjustmentsHandlers } from './excel-manual-adjustments.ts'
import { publishGatewayHandlers } from './publish-gateway.ts'
import { registerLocalHandlers, registeredLocalModules } from '../transports/local.ts'

/**
 * 注册全部 `local` 类型的工具实现。
 *
 * 幂等：同进程内可能建多份 context（测试、回归各一份），重复注册以最后一次为准。
 */
export function registerBuiltinLocalHandlers(): void {
  registerLocalHandlers('excel-manual-adjustments', excelManualAdjustmentsHandlers)
  registerLocalHandlers('publish-gateway', publishGatewayHandlers)
}

export { registeredLocalModules }
