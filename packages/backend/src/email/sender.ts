import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import nodemailer from 'nodemailer'
import type { TransportOptions } from 'nodemailer'
import type { DataPaths } from '@datasentry/core'

/**
 * 真实的邮件投递。
 *
 * 两种模式：
 * - `smtp`：真的连 SMTP 服务器发出去（生产、本地收件器都走这条）
 * - `stream`：nodemailer 的 streamTransport，只组装 RFC822 报文并落盘，
 *   **不发网络请求**。回归与单元测试用它，保证结果可复现、不依赖外部服务。
 *
 * 模式必须显式指定，不做「没配就降级成 stream」那种猜测——
 * 生产上悄悄没发出去，比启动失败危险得多。
 */

export type MailMode = 'smtp' | 'stream'

export interface MailAttachment {
  filename: string
  path: string
  contentType: string
}

export interface OutgoingMail {
  to: string[]
  subject: string
  text: string
  attachments: MailAttachment[]
  from?: string
}

export interface SentMail {
  messageId: string
  transport: MailMode
  /** stream 模式下把报文落到了哪个文件；smtp 模式为 null。 */
  rawPath: string | null
}

export function mailModeOf(env: NodeJS.ProcessEnv = process.env): MailMode {
  return env['DATASENTRY_SMTP_MODE'] === 'stream' ? 'stream' : 'smtp'
}

export function mailFromOf(env: NodeJS.ProcessEnv = process.env): string {
  return env['DATASENTRY_SMTP_FROM'] || 'datasentry@example.com'
}

function smtpOptions(env: NodeJS.ProcessEnv): TransportOptions {
  const user = env['DATASENTRY_SMTP_USER']
  return {
    host: env['DATASENTRY_SMTP_HOST'] || '127.0.0.1',
    port: Number(env['DATASENTRY_SMTP_PORT'] ?? 1025),
    secure: env['DATASENTRY_SMTP_SECURE'] === '1',
    ...(user ? { auth: { user, pass: env['DATASENTRY_SMTP_PASS'] ?? '' } } : {}),
    // 宁可快失败，也不要让一次发布卡住十分钟
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 15_000,
  } as TransportOptions
}

export async function sendMail(
  mail: OutgoingMail,
  paths: DataPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SentMail> {
  const mode = mailModeOf(env)
  const message = {
    from: mail.from ?? mailFromOf(env),
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    attachments: mail.attachments.map((item) => ({
      filename: item.filename,
      path: item.path,
      contentType: item.contentType,
    })),
  }

  if (mode === 'stream') {
    const transporter = nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'unix',
    })
    const info = (await transporter.sendMail(message)) as unknown as {
      messageId: string
      message: Buffer
    }

    mkdirSync(paths.mail, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const rawPath = join(paths.mail, `${stamp}-report.eml`)
    writeFileSync(rawPath, info.message)

    return { messageId: info.messageId, transport: 'stream', rawPath }
  }

  const transporter = nodemailer.createTransport(smtpOptions(env))
  try {
    const info = await transporter.sendMail(message)
    return { messageId: info.messageId ?? '', transport: 'smtp', rawPath: null }
  } finally {
    transporter.close()
  }
}
