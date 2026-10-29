/**
 * 凭据的**命名约定**，不含任何凭据读写。
 *
 * 真正的凭据由 backend 的 CredentialManager 在 spawn 进程 / 发请求时注入，
 * 只出现在子进程环境变量与 HTTP 头里，永不进入模型上下文、日志或报表产物。
 */
export const CREDENTIAL_ENV_PREFIX = 'DATASENTRY_CRED_'

/** `erp.token` → `DATASENTRY_CRED_ERP_TOKEN` */
export function credentialEnvVar(credentialKey: string): string {
  return (
    CREDENTIAL_ENV_PREFIX + credentialKey.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  )
}

/** 用于日志与错误信息中的占位，绝不返回真实值。 */
export const REDACTED = '***redacted***'
