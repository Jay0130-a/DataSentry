import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CredentialManager } from '@datasentry/backend/credentials/manager.ts'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

let temp: TempPaths

afterEach(() => {
  temp?.cleanup()
})

function withCredentials(values: Record<string, string>): CredentialManager {
  temp = tempPaths()
  mkdirSync(dirname(temp.paths.credentials), { recursive: true })
  writeFileSync(temp.paths.credentials, JSON.stringify(values), 'utf8')
  return CredentialManager.load(temp.paths)
}

describe('凭据管理', () => {
  it('从 credentials.json 读取凭据', () => {
    const manager = withCredentials({ 'erp.token': 'secret-erp-token' })
    expect(manager.get('erp.token')).toBe('secret-erp-token')
    expect(manager.has('erp.token')).toBe(true)
    expect(manager.has('nope')).toBe(false)
  })

  it('缺失凭据时 require 抛错，而不是返回空字符串', () => {
    const manager = withCredentials({})
    expect(() => manager.require('erp.token')).toThrowError(/缺少凭据/)
  })

  it('envFor 按 core 的命名约定生成子进程环境变量', () => {
    const manager = withCredentials({ 'erp.token': 'abc', 'finance.token': 'def' })
    expect(manager.envFor(['erp.token', 'finance.token'])).toEqual({
      DATASENTRY_CRED_ERP_TOKEN: 'abc',
      DATASENTRY_CRED_FINANCE_TOKEN: 'def',
    })
  })

  it('scrub 把出现过的凭据值替换掉——这是审计轨迹不泄漏的最后一道出口', () => {
    const manager = withCredentials({ 'erp.token': 'super-secret-value' })
    const text = 'authorization: Bearer super-secret-value'
    expect(manager.scrub(text)).toBe('authorization: Bearer ***redacted***')
    expect(manager.scrub(text)).not.toContain('super-secret-value')
  })

  it('scrubValue 递归清洗对象与数组', () => {
    const manager = withCredentials({ 'erp.token': 'super-secret-value' })
    const cleaned = manager.scrubValue({
      headers: { auth: 'Bearer super-secret-value' },
      rows: [{ note: 'token=super-secret-value' }],
      count: 3,
    }) as { headers: { auth: string }; rows: { note: string }[]; count: number }

    expect(cleaned.headers.auth).toBe('Bearer ***redacted***')
    expect(cleaned.rows[0]!.note).toBe('token=***redacted***')
    expect(cleaned.count).toBe(3)
  })

  it('环境变量可以覆盖文件里的凭据', () => {
    temp = tempPaths()
    mkdirSync(dirname(temp.paths.credentials), { recursive: true })
    writeFileSync(temp.paths.credentials, JSON.stringify({ 'erp.token': 'from-file' }), 'utf8')

    process.env['DATASENTRY_CRED_ERP_TOKEN'] = 'from-env'
    try {
      const manager = CredentialManager.load(temp.paths)
      expect(manager.get('erp.token')).toBe('from-env')
      // 被替换掉的旧值不应留在清洗表里
      expect(manager.scrub('from-env')).toBe('***redacted***')
    } finally {
      delete process.env['DATASENTRY_CRED_ERP_TOKEN']
    }
  })
})
