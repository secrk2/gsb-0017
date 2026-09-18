import { Router } from 'express'
import { redis } from '../redis.js'
import { asyncH } from '../middleware/error.js'
import { requireRole } from '../middleware/auth.js'
import { createCase, transitionCase } from '../services/caseService.js'
import { completeDeadline, payFee } from '../services/workflowService.js'
import { registerDoc, archiveDoc, withdrawDoc } from '../services/docService.js'

const router = Router()

// 离线变更合并入口：前端恢复网络后，把离线期间排队的操作一次性提交。
// 每条操作带客户端生成的幂等 key：
//   - 同 key 重放 → 返回首次结果（duplicate）
//   - case.create 另有 client_uuid 唯一约束兜底，绝不产生重复案件
//   - case.transition 按服务器当前状态重新校验：仍合法则执行（合并），
//     目标状态已达成则视为重复，非法回退/跳级则标记 conflict 并带回服务器现状
router.post(
  '/batch',
  requireRole('admin', 'agent', 'reviewer'),
  asyncH(async (req, res) => {
    const ops = Array.isArray(req.body?.ops) ? req.body.ops.slice(0, 100) : []
    const results = []
    for (const op of ops) {
      results.push(await applyOp(req.user, op))
    }
    res.json({ data: { results } })
  })
)

async function applyOp(user, op) {
  const { key, op: type, payload = {} } = op || {}
  if (!key || !type) return { key: key || null, status: 'error', code: 'BAD_OP', message: '操作缺少 key 或 op 类型' }
  const cacheKey = `sync:${key}`
  try {
    const hit = await redis().get(cacheKey)
    if (hit) return { key, status: 'duplicate', result: JSON.parse(hit) }
  } catch {}
  let out
  try {
    switch (type) {
      case 'case.create': {
        const r = await createCase(user, payload)
        out = { status: r.deduped ? 'duplicate' : 'applied', data: { case_id: r.case.id, case_no: r.case.case_no } }
        break
      }
      case 'case.transition': {
        out = await syncTransition(user, payload)
        break
      }
      case 'deadline.complete': {
        await completeDeadline(user, Number(payload.id))
        out = { status: 'applied', data: { id: Number(payload.id) } }
        break
      }
      case 'fee.pay': {
        await payFee(user, Number(payload.id))
        out = { status: 'applied', data: { id: Number(payload.id) } }
        break
      }
      case 'doc.register': {
        out = await syncDocRegister(user, payload)
        break
      }
      case 'doc.archive': {
        await archiveDoc(user, Number(payload.id))
        out = { status: 'applied', data: { id: Number(payload.id) } }
        break
      }
      case 'doc.withdraw': {
        await withdrawDoc(user, Number(payload.id), { reason: payload.reason })
        out = { status: 'applied', data: { id: Number(payload.id) } }
        break
      }
      default:
        out = { status: 'error', code: 'UNKNOWN_OP', message: `未知操作类型：${type}` }
    }
  } catch (e) {
    out = { status: 'error', code: e.code || 'INTERNAL', message: e.message || '处理失败' }
  }
  try {
    await redis().set(cacheKey, JSON.stringify(out), 'EX', 72 * 3600)
  } catch {}
  return { key, ...out }
}

async function syncTransition(user, payload) {
  const { case_id, to, reason = '', agent_id = null } = payload
  try {
    const r = await transitionCase(user, Number(case_id), { to, reason, agent_id })
    return { status: r.noop ? 'duplicate' : 'applied', data: { case_id: Number(case_id), status: r.case.status } }
  } catch (e) {
    if (e.code === 'ILLEGAL_ROLLBACK' || e.code === 'ILLEGAL_TRANSITION' || e.code === 'NOT_ASSIGNEE' || e.code === 'ROLE_DENIED' || e.code === 'CTYPE_PATH_MISMATCH') {
      // 与服务器现状冲突：不强行应用，带回当前状态由前端提示人工处理
      return { status: 'conflict', code: e.code, message: e.message }
    }
    throw e
  }
}

async function syncDocRegister(user, payload) {
  try {
    const r = await registerDoc(user, Number(payload.case_id), payload.body || {})
    return {
      status: 'applied',
      data: { id: r.id, deadline_id: r.deadline_id, case_status: r.case_status, transitioned: r.transitioned || null },
    }
  } catch (e) {
    // 官文驱动的流转与服务器现状冲突，或落点逾期未二次确认：交回前端人工处理，不丢操作
    if (['ILLEGAL_ROLLBACK', 'ILLEGAL_TRANSITION', 'NOT_ASSIGNEE', 'ROLE_DENIED', 'CTYPE_PATH_MISMATCH', 'OVERDUE_CONFIRM', 'OVERDUE_REASON_REQUIRED'].includes(e.code)) {
      return { status: 'conflict', code: e.code, message: e.message, details: e.details }
    }
    throw e
  }
}

export default router
