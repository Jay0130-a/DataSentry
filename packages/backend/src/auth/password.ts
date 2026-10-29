import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * 口令摘要。
 *
 * 用 Node 内置的 scrypt，不引第三方库：它把「慢」写进了算法本身，
 * 而慢正是这里需要的性质。参数连同盐一起存进摘要串，
 * 将来调高 cost 不会让老摘要失效——校验时按存下来的参数重算。
 *
 * 存储格式：`scrypt$N$r$p$saltHex$hashHex`
 */

const N = 16_384
const R = 8
const P = 1
const KEY_LENGTH = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, KEY_LENGTH, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${derived.toString('hex')}`
}

/**
 * 校验口令。
 *
 * 比较用 `timingSafeEqual`：普通的 `===` 会在第一个不同的字节就返回，
 * 攻击者能靠耗时差异逐字节猜出摘要。
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, nText, rText, pText, saltHex, hashHex] = parts
  const n = Number(nText)
  const r = Number(rText)
  const p = Number(pText)
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  let expected: Buffer
  let salt: Buffer
  try {
    expected = Buffer.from(hashHex ?? '', 'hex')
    salt = Buffer.from(saltHex ?? '', 'hex')
  } catch {
    return false
  }
  if (expected.length === 0 || salt.length === 0) return false

  const derived = scryptSync(password, salt, expected.length, { N: n, r, p })
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}
