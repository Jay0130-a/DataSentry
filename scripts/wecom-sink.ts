import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'

/**
 * 企业微信兼容的本地收件服务。
 *
 * 只实现群机器人用到的两个接口，用来在没有真实企业租户时验证投递链路：
 *   POST /cgi-bin/webhook/upload_media?key=K&type=file  → media_id
 *   POST /cgi-bin/webhook/send?key=K                    → errcode 0
 *
 * 它**不校验 key**（真实环境才校验），但会记录文件名、字节数与 sha256，
 * 所以「发出去的是不是那一份文件」照样能断言。
 */

export interface WecomReceived {
  kind: 'upload' | 'markdown' | 'file'
  at: string
  fileName?: string
  sizeBytes?: number
  sha256?: string
  mediaId?: string
  content?: string
}

export interface WecomSink {
  port: number
  received: WecomReceived[]
  /** 让下一次指定步骤返回非 0 errcode，用于验证失败路径。 */
  failNext: (step: 'upload' | 'send', errcode: number) => void
  close: () => Promise<void>
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export async function startWecomSink(
  options: { port?: number; verbose?: boolean } = {},
): Promise<WecomSink> {
  const received: WecomReceived[] = []
  let failure: { step: 'upload' | 'send'; errcode: number } | null = null

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const body = await readBody(req)
      const reply = (data: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }

      if (url.pathname === '/cgi-bin/webhook/upload_media') {
        if (failure?.step === 'upload') {
          const code = failure.errcode
          failure = null
          return reply({ errcode: code, errmsg: 'mock failure' })
        }

        // 只读前 2KB 的头部就够了：文件名与 filelength 都在第一段。
        const head = body.subarray(0, 2048).toString('latin1')
        const fileName = /filename="([^"]*)"/.exec(head)?.[1] ?? ''
        const fileLength = Number(/filelength=(\d+)/.exec(head)?.[1] ?? 0)
        const start = body.indexOf('\r\n\r\n') + 4
        const bytes = body.subarray(start, start + fileLength)

        const mediaId = `media_${randomUUID().replace(/-/g, '').slice(0, 12)}`
        const entry: WecomReceived = {
          kind: 'upload',
          at: new Date().toISOString(),
          fileName,
          sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          mediaId,
        }
        received.push(entry)
        if (options.verbose) process.stdout.write(`[im] 上传 ${fileName} ${bytes.length}B\n`)

        return reply({
          errcode: 0,
          errmsg: 'ok',
          type: 'file',
          media_id: mediaId,
          created_at: String(Date.now()),
        })
      }

      if (url.pathname === '/cgi-bin/webhook/send') {
        if (failure?.step === 'send') {
          const code = failure.errcode
          failure = null
          return reply({ errcode: code, errmsg: 'mock failure' })
        }

        let payload: Record<string, unknown> = {}
        try {
          payload = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>
        } catch {
          return reply({ errcode: 40058, errmsg: 'invalid json' })
        }

        if (payload['msgtype'] === 'markdown') {
          const markdown = payload['markdown'] as { content?: string } | undefined
          received.push({
            kind: 'markdown',
            at: new Date().toISOString(),
            content: markdown?.content ?? '',
          })
          if (options.verbose) process.stdout.write('[im] 摘要已发送\n')
        } else if (payload['msgtype'] === 'file') {
          const file = payload['file'] as { media_id?: string } | undefined
          received.push({
            kind: 'file',
            at: new Date().toISOString(),
            mediaId: file?.media_id ?? '',
          })
          if (options.verbose) process.stdout.write(`[im] 文件已发送 ${file?.media_id ?? ''}\n`)
        }

        return reply({ errcode: 0, errmsg: 'ok' })
      }

      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ errcode: 404, errmsg: 'not found' }))
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  const port =
    address !== null && typeof address === 'object' ? address.port : (options.port ?? 0)

  return {
    port,
    received,
    failNext: (step, errcode) => {
      failure = { step, errcode }
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/wecom-sink.ts')) {
  const port = Number(process.env['DATASENTRY_IM_PORT'] ?? 1026)
  const sink = await startWecomSink({ port, verbose: true })
  process.stdout.write(
    `企微兼容收件服务已启动：http://127.0.0.1:${sink.port}\n` +
      `把后端指向它：DATASENTRY_IM_BASE_URL=http://127.0.0.1:${sink.port}\n`,
  )

  const shutdown = async (): Promise<void> => {
    await sink.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}
