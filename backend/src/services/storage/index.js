// 定稿附件对象存储：统一抽象，文件本体不入库。
//   - local：开发/测试/单机，落盘到 STORAGE_LOCAL_DIR；
//   - s3：生产，S3 兼容（MinIO / AWS），用原生 fetch + Web Crypto 做 SigV4，免引重型 SDK。
// 换版必生成新 object_key；旧对象不删除、不覆盖 → 历史版本引用的旧 key 永远打得开。

import { promises as fs } from 'node:fs'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../../config.js'

let driverPromise = null

export async function getStorage() {
  if (!driverPromise) driverPromise = initStorage()
  return driverPromise
}

async function initStorage() {
  if (config.storage.driver === 's3') return createS3Storage(config.storage.s3)
  return createLocalStorage(config.storage.localDir)
}

// 仅供测试切换/重置
export async function resetStorage() {
  driverPromise = null
}

function safeName(name) {
  return String(name || 'file').replace(/[\\/]+/g, '_').slice(0, 180)
}

// 生成不可复用的对象 key：同附件每次换版都是全新 key（含内容 hash 与 uuid），
// 天然不可变，历史版本持有的旧 key 不受新版影响。
export function buildObjectKey({ caseId, dtype, attachmentId, versionNo, filename, sha256 }) {
  const ext = path.extname(safeName(filename))
  const rand = crypto.randomUUID()
  return `cases/${caseId}/${dtype}/attachments/${attachmentId}/v${versionNo}/${sha256.slice(0, 12)}-${rand}${ext}`
}

export function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

// ---------------- local ----------------

async function createLocalStorage(rootDir) {
  await fs.mkdir(rootDir, { recursive: true })
  return {
    name: 'local',
    bucket: '',
    async put(key, body /* Buffer */) {
      const full = path.join(rootDir, key)
      await fs.mkdir(path.dirname(full), { recursive: true })
      // 先写临时文件再改名，避免解析端读到半截对象
      const tmp = `${full}.tmp-${process.pid}-${crypto.randomUUID()}`
      await fs.writeFile(tmp, body)
      await fs.rename(tmp, full)
      return { key, size: body.length }
    },
    async get(key) {
      const full = path.join(rootDir, key)
      const buf = await fs.readFile(full)
      return { body: buf, stream: () => createReadStream(full), size: buf.length }
    },
    async exists(key) {
      try {
        await fs.access(path.join(rootDir, key))
        return true
      } catch {
        return false
      }
    },
  }
}

// ---------------- S3（SigV4，无第三方依赖） ----------------

function enc(n) {
  return encodeURIComponent(n).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

async function hmac(key, data) {
  const ck = key instanceof Uint8Array ? key : new TextEncoder().encode(key)
  const w = await crypto.subtle.importKey('raw', ck, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', w, new TextEncoder().encode(data)))
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

async function createS3Storage(cfg) {
  if (!cfg.endpoint || !cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error('S3 存储缺少配置：S3_ENDPOINT / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY')
  }
  const endpoint = cfg.endpoint.replace(/\/+$/, '')
  const host = new URL(endpoint).host

  async function signedRequest(method, key, { body, contentType } = {}) {
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)
    const payloadHash = body ? sha256Hex(body) : 'UNSIGNED-PAYLOAD'
    const url = cfg.forcePathStyle ? `${endpoint}/${cfg.bucket}/${enc(key).replace(/%2F/g, '/')}` : `${endpoint}/${enc(key).replace(/%2F/g, '/')}`
    const headers = {
      host: cfg.forcePathStyle ? host : `${cfg.bucket}.${host}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    }
    if (body) headers['content-type'] = contentType || 'application/octet-stream'
    const signedHeaders = Object.keys(headers).sort().join(';')
    const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${String(headers[k]).trim()}\n`).join('')
    const canonical = [method, `/${cfg.forcePathStyle ? `${cfg.bucket}/${key}` : key}`, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
    const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n')
    let k = await hmac(`AWS4${cfg.secretAccessKey}`, dateStamp)
    k = await hmac(k, cfg.region)
    k = await hmac(k, 's3')
    k = await hmac(k, 'aws4_request')
    const sig = Buffer.from(await hmac(k, stringToSign)).toString('hex')
    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`
    const resp = await fetch(url, { method, headers: body ? { ...headers } : headers, body })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`对象存储 ${method} 失败（${resp.status}）：${text.slice(0, 300)}`)
    }
    return resp
  }

  return {
    name: 's3',
    bucket: cfg.bucket,
    async put(key, body, { contentType } = {}) {
      await signedRequest('PUT', key, { body: Buffer.from(body), contentType })
      return { key, size: body.length }
    },
    async get(key) {
      const resp = await signedRequest('GET', key)
      const ab = await resp.arrayBuffer()
      const buf = Buffer.from(ab)
      return { body: buf, stream: () => null, size: buf.length }
    },
    async exists(key) {
      try {
        await signedRequest('HEAD', key)
        return true
      } catch {
        return false
      }
    },
  }
}
