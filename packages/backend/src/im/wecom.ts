import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * 企业微信群机器人投递。
 *
 * 两步，都只用一个 webhook key：
 *   1. `POST /cgi-bin/webhook/upload_media?key=K&type=file` 换 media_id
 *   2. `POST /cgi-bin/webhook/send?key=K` 发 file 消息
 *
 * 参数说明见 https://developer.work.weixin.qq.com/document/path/91770
 *
 * 几个必须照做的细节：
 * - 上传是 multipart，字段名必须是 `media`，且 Content-Disposition 里要带 `filelength`。
 *   所以这里手写 multipart，不用 FormData —— 它没法加这个属性。
 * - 群机器人只属于一个群：一次投递就是一个目标，不存在「多发几个人」。
 * - 接口只回 `errcode/errmsg`，**没有消息 id**。回执只能记「已接收」。
 */

export interface WecomSendResult {
  mediaId: string
  /** 摘要消息（如果发了）的返回；企微只给 errcode，没有 id。 */
  summarySent: boolean
}

export interface WecomSendInput {
  baseUrl: string
  webhookKey: string
  filePath: string
  fileName: string
  /** 可选：发文件之前先发一条 markdown 摘要。 */
  summaryMarkdown?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** 默认指向真实企微；测试与本地演示用 `DATASENTRY_IM_BASE_URL` 指向兼容服务。 */
export function wecomBaseUrlOf(env: NodeJS.ProcessEnv = process.env): string {
  return env['DATASENTRY_IM_BASE_URL'] || 'https://qyapi.weixin.qq.com'
}

export class WecomError extends Error {
  constructor(
    readonly step: 'summary' | 'upload' | 'send',
    readonly errcode: number,
    errmsg: string,
  ) {
    super(`企业微信 ${step} 失败：errcode=${errcode} ${errmsg}`)
    this.name = 'WecomError'
  }
}

async function readErrcode(response: Response, step: 'summary' | 'upload' | 'send'): Promise<Record<string, unknown>> {
  const text = await response.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new WecomError(step, -1, `返回不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }

  const errcode = typeof body['errcode'] === 'number' ? body['errcode'] : -1
  if (!response.ok || errcode !== 0) {
    throw new WecomError(step, errcode, String(body['errmsg'] ?? `HTTP ${response.status}`))
  }
  return body
}

/** 手写 multipart：企微要求 Content-Disposition 里带 filelength。 */
function buildUploadBody(filePath: string, fileName: string): {
  body: Buffer
  contentType: string
} {
  const boundary = `----datasentry${randomBytes(8).toString('hex')}`
  const bytes = readFileSync(filePath)
  const safeName = basename(fileName).replace(/["\r\n]/g, '_')

  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="media"; filename="${safeName}"; filelength=${bytes.length}\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`
  const tail = `\r\n--${boundary}--\r\n`

  return {
    body: Buffer.concat([Buffer.from(head, 'utf8'), bytes, Buffer.from(tail, 'utf8')]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

export async function sendWecomFile(input: WecomSendInput): Promise<WecomSendResult> {
  const doFetch = input.fetchImpl ?? fetch
  const timeoutMs = input.timeoutMs ?? 15_000
  const base = input.baseUrl.replace(/\/+$/, '')
  const key = encodeURIComponent(input.webhookKey)

  let summarySent = false

  if (input.summaryMarkdown) {
    const response = await doFetch(`${base}/cgi-bin/webhook/send?key=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: input.summaryMarkdown } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    await readErrcode(response, 'summary')
    summarySent = true
  }

  const { body, contentType } = buildUploadBody(input.filePath, input.fileName)
  const uploadResponse = await doFetch(`${base}/cgi-bin/webhook/upload_media?key=${key}&type=file`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const uploaded = await readErrcode(uploadResponse, 'upload')
  const mediaId = String(uploaded['media_id'] ?? '')
  if (!mediaId) throw new WecomError('upload', -1, '没有返回 media_id')

  const sendResponse = await doFetch(`${base}/cgi-bin/webhook/send?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'file', file: { media_id: mediaId } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  await readErrcode(sendResponse, 'send')

  return { mediaId, summarySent }
}
