// 撰稿附件原件的对象存储。
//
// 设计约束：
//   1. 原件只存对象存储，数据库 writing_attachment_versions 只留 object_key 等元数据，绝不入库内容；
//   2. object_key 不可变：附件换版 = 写新 key，旧版本 key 永不覆盖、永不删除，旧版本永远打得开；
//   3. 本环境零外部依赖，driver=local 时落本地目录（compose 挂卷）；生产可换 S3 兼容驱动，
//      put/get/presign 三个方法签名保持不变，业务层无感知。
//
// 上传走两阶段（对齐真实对象存储的直传语义）：
//   reserveKey() 先分配不可变 key 与一次性上传令牌（落内存登记，仅本次进程有效），
//   客户端随后 POST 二进制到该 key（经本服务鉴权后 putObject），模拟「拿预签名 URL → 直传对象存储」。

import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { nowIso } from '../lib/dates.js'

let driverPromise = null

async function localDriver() {
  const root = path.resolve(config.objectStoreDir)
  await fs.mkdir(root, { recursive: true })
  return {
    kind: 'local',
    async putObject(key, buf) {
      const full = path.join(root, key)
      await fs.mkdir(path.dirname(full), { recursive: true })
      // x 标志：key 已存在即失败，绝不覆盖旧原件
      await fs.writeFile(full, buf, { flag: 'wx' })
      return { key, size: buf.length }
    },
    async getObject(key) {
      const full = path.join(root, key)
      return fs.readFile(full) // 不存在时抛 ENOENT，由上层映射 404
    },
  }
}

// S3 兼容（MinIO/OSS/COS）接入位：按 OBJECT_STORE_DRIVER=s3 与端点/桶/AK/SK 实现 putObject/getObject/presignPut。
// 当前里程碑环境不引入额外 SDK，故未提供 s3 驱动；保留 seam 以便切换时不动业务代码。
export async function objectStore() {
  if (!driverPromise) {
    if (config.objectStoreDriver === 'local') driverPromise = localDriver()
    else throw new Error(`不支持的对象存储驱动：${config.objectStoreDriver}（当前内置 local，S3 为预留 seam）`)
  }
  return driverPromise
}

// 不可变 key：附件逻辑 id/版本号 + 随机 nonce。内容不参与命名，故上传授权（reserve）
// 阶段即可分配 key；putObject 用 wx 标志兜底，任何已有 key 都不会被覆盖。
export function buildObjectKey({ attachmentId, versionNo, filename }) {
  const nonce = crypto.randomBytes(8).toString('hex')
  const safe = String(filename || 'attachment').replace(/[^\w.\-一-龥]+/g, '_').slice(-80)
  const date = nowIso().slice(0, 10).replace(/-/g, '')
  return `writing/${date}/att${attachmentId}/v${versionNo}_${nonce}_${safe}`
}

// 一次性上传令牌：reserve 后 10 分钟内有效、仅可用一次，模拟预签名直传。
const uploadGrants = new Map()
const GRANT_TTL_MS = 10 * 60 * 1000

export function grantUpload(key) {
  const token = crypto.randomBytes(24).toString('hex')
  uploadGrants.set(token, { key, expires: Date.now() + GRANT_TTL_MS, used: false })
  return token
}

export function consumeUploadGrant(token, key) {
  const g = uploadGrants.get(token)
  if (!g) return { ok: false, reason: '上传令牌不存在或已失效，请重新发起上传' }
  if (g.used) return { ok: false, reason: '上传令牌已使用，附件每次换版需重新发起' }
  if (g.expires < Date.now()) {
    uploadGrants.delete(token)
    return { ok: false, reason: '上传令牌已过期，请重新发起上传' }
  }
  if (g.key !== key) return { ok: false, reason: '上传令牌与目标对象不匹配' }
  g.used = true
  uploadGrants.delete(token)
  return { ok: true }
}

export async function putObject(key, buf) {
  const s = await objectStore()
  return s.putObject(key, buf)
}

export async function getObject(key) {
  const s = await objectStore()
  return s.getObject(key)
}
