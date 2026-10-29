import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataPaths } from '@datasentry/core'
import { SMTPServer } from 'smtp-server'
import { simpleParser, type AddressObject } from 'mailparser'

/**
 * 本地 SMTP 收件器。
 *
 * 两个用途：
 * 1. `npm run mail` 起一个常驻收件器，把邮件原样写成 `.eml`，开发时不用真邮箱；
 * 2. 冒烟脚本在进程内把它拉起来，直接断言「收件人、标题、附件的字节数」。
 *
 * 它只做 SMTP 握手与存盘，不做投递——正是这样才适合验证「我们真的发了一封信」。
 */

export interface ReceivedMail {
  from: string
  to: string[]
  subject: string
  attachments: { filename: string; sizeBytes: number; contentType: string }[]
  raw: Buffer
  receivedAt: string
}

export interface SmtpSink {
  port: number
  received: ReceivedMail[]
  close: () => Promise<void>
}

function addressesOf(field: AddressObject | AddressObject[] | undefined): string[] {
  if (!field) return []
  const list = Array.isArray(field) ? field : [field]
  return list
    .flatMap((item) => item.value)
    .map((item) => item.address ?? '')
    .filter(Boolean)
}

async function toReceived(raw: Buffer): Promise<ReceivedMail> {
  const parsed = await simpleParser(raw)
  return {
    from: parsed.from?.text ?? '',
    to: addressesOf(parsed.to),
    subject: parsed.subject ?? '',
    attachments: parsed.attachments.map((item) => ({
      filename: item.filename ?? '',
      sizeBytes: item.size,
      contentType: item.contentType,
    })),
    raw,
    receivedAt: new Date().toISOString(),
  }
}

/** 读一个目录里落盘的 `.eml`，按文件名（时间戳）升序。冒烟脚本用它断言「信真的到了」。 */
export async function readMailDir(dir: string): Promise<ReceivedMail[]> {
  if (!existsSync(dir)) return []
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.eml'))
    .sort()
  const out: ReceivedMail[] = []
  for (const name of files) {
    try {
      out.push(await toReceived(readFileSync(join(dir, name))))
    } catch {
      // 坏邮件不阻塞统计：宁可少一条，也不要让整个检查炸掉
    }
  }
  return out
}

export async function startSmtpSink(
  options: { port?: number; saveDir?: string; verbose?: boolean } = {},
): Promise<SmtpSink> {
  const port = options.port ?? Number(process.env['DATASENTRY_SMTP_PORT'] ?? 1025)
  const received: ReceivedMail[] = []

  const server = new SMTPServer({
    authOptional: true,
    // 没有配置证书就不要广告 STARTTLS，否则客户端会尝试升级后失败。
    disabledCommands: ['STARTTLS', 'AUTH'],
    onData(stream, session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        const raw = Buffer.concat(chunks)
        void (async () => {
          try {
            const mail = await toReceived(raw)
            received.push(mail)

            if (options.saveDir) {
              mkdirSync(options.saveDir, { recursive: true })
              const stamp = new Date().toISOString().replace(/[:.]/g, '-')
              // 标题来自配置，不能直接当文件名：路径分隔符与 Windows 保留字符要剔掉。
              const safeSubject = mail.subject.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80)
              writeFileSync(join(options.saveDir, `${stamp}-${safeSubject}.eml`), raw)
            }

            if (options.verbose !== false) {
              process.stdout.write(
                `[mail] ${mail.subject} → ${mail.to.join(', ')}（附件 ${mail.attachments.length} 个）\n`,
              )
            }
          } catch (err) {
            process.stderr.write(`[mail] 解析失败：${String(err)}\n`)
          }
          callback()
        })()
      })
      stream.on('error', callback)
      void session
    },
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })

  return {
    port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// 作为脚本直接运行时：常驻并把邮件落到 data/mail/
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/smtp-sink.ts')) {
  const paths = dataPaths()
  const sink = await startSmtpSink({ saveDir: paths.mail })
  process.stdout.write(`SMTP 收件器已启动：smtp://127.0.0.1:${sink.port}，邮件落到 ${paths.mail}\n`)

  const shutdown = async (): Promise<void> => {
    await sink.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}
