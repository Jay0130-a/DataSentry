import type { AuthUser } from './api.ts'

/**
 * 权限判定。
 *
 * 身份来自后端 `/auth/me`，前端只负责「藏入口」与「给出可读的解释」。
 * 真正的边界在服务端：即使有人手工调接口，/sources 与 /recovery 也会 403。
 */
export type Role = AuthUser['role']
export type CurrentUser = AuthUser
export type Permission = 'sources.view' | 'recovery.manage' | 'audit.view'

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // 业务用户：发起报表、处理自己范围内的审批。
  analyst: [],
  // 管理员：额外能看到数据源清单、执行恢复、查看登录审计。
  admin: ['sources.view', 'recovery.manage', 'audit.view'],
}

const ROLE_LABELS: Record<Role, string> = {
  analyst: '业务用户',
  admin: '管理员',
}

export function can(user: CurrentUser, permission: Permission): boolean {
  return ROLE_PERMISSIONS[user.role].includes(permission)
}

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role]
}
