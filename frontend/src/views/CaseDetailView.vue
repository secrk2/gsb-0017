<template>
  <div>
    <ErrorState v-if="error" :code="errorCode" :message="error" />
    <template v-else-if="c">
      <div v-if="stale" class="offline-banner" style="position: static; border-radius: 8px; margin-bottom: 12px">
        <strong>缓存数据</strong>更新于 {{ fmtDateTime(cachedAt) }}，可能已过期；请勿据此办理期限。
      </div>

      <!-- 概要 -->
      <div class="card">
        <div class="spread">
          <div>
            <div class="row">
              <h3 style="margin: 0">{{ c.title }}</h3>
              <StatusBadge :status="c.status" />
              <span v-if="c.priority === '高'" class="chip bad">高优先级</span>
            </div>
            <div class="muted small mt8">
              {{ c.case_no }} · {{ c.ctype }} · 代理人：{{ c.agent_name || '待指派' }}
              <span v-if="c.contract_no"> · 合同 {{ c.contract_no }}</span>
            </div>
          </div>
          <div style="text-align: right">
            <div class="row" style="justify-content: flex-end">
              <span class="muted small">客户</span>
              <strong>{{ revealedName || c.client_name }}</strong>
              <span v-if="c.client_masked && !revealedName" class="lock">🔒</span>
            </div>
            <button
              v-if="c.client_masked && !revealedName && c.can_reveal"
              class="btn sm mt8"
              @click="showReveal = true"
            >查看全称（留痕）</button>
            <p v-if="revealedName" class="small" style="color: var(--warn); margin: 4px 0 0">已留痕解密展示</p>
          </div>
        </div>
        <div v-if="isFirm() && c.allowed_transitions.length" class="row mt16">
          <span class="small muted">可执行：</span>
          <button
            v-for="t in c.allowed_transitions"
            :key="t.to"
            class="btn primary sm"
            @click="openTransition(t.to, t.label)"
          >{{ t.label }} → {{ t.to }}</button>
          <button class="btn sm" title="尝试其他状态变更（非法操作将被状态机拦截并说明原因）" @click="openTransition('', '')">其他状态…</button>
        </div>
      </div>

      <!-- 完成度：两口径写明，作战台/详情/导出同一算法 -->
      <div class="card mt16">
        <CompletionMeter :completion="c.completion" v-model:basis="completionBasis" />
      </div>

      <!-- 撰稿：交底书 / 权利要求草稿 / 说明书定稿（统一版本链） -->
      <div class="card mt16">
        <div class="spread">
          <h3 style="margin: 0">撰稿</h3>
          <router-link class="btn sm primary" :to="`/cases/${id}/writing`">进入撰稿工作台 →</router-link>
        </div>
        <div class="grid grid-2 mt16" v-if="writing">
          <div v-for="k in writingKinds" :key="k.key" class="writing-mini">
            <div class="spread">
              <strong>{{ k.label }}</strong>
              <span class="chip" :class="writingChip(k.key)">{{ writingStateText(k.key) }}</span>
            </div>
            <p class="small muted mt8" style="margin-bottom: 0">{{ writingHint(k.key) }}</p>
          </div>
        </div>
        <p v-else class="muted small mt8">撰稿状态加载中…</p>
      </div>

      <!-- 官文与期限 -->
      <div class="grid grid-2 mt16">
        <!-- 官文 -->
        <div class="card">
          <div class="spread">
            <h3 style="margin: 0">官文</h3>
            <button v-if="isFirm()" class="btn sm primary" @click="showDoc = true">＋ 登记官文</button>
          </div>
          <p class="small muted mt8" style="margin-bottom: 10px">
            官文驱动案件在受理/初审/实审/授权/驳回/复审/无效间流转；登记落点的起算口径（收到日/发文日）与天数口径均在每条期限上明示。
          </p>

          <!-- 空态一：本案无任何官文 -->
          <div v-if="!c.docs.length" class="inline-empty">
            <div class="ie-icon">📭</div>
            <p class="ie-title">该案暂无官文</p>
            <p class="small muted">受理通知书、审查意见、授权办登、驳回决定等收到后请点「登记官文」，登记后将按法定期限自动生成待办。</p>
          </div>

          <!-- 空态二：全部撤回（有记录但均已撤回） -->
          <div v-else-if="activeDocs.length === 0" class="inline-empty">
            <div class="ie-icon">↩️</div>
            <p class="ie-title">官文已全部撤回</p>
            <p class="small muted">本案登记的 {{ c.docs.length }} 份官文均已被官方撤回/作废，不再产生效力；撤回原因留痕如下。</p>
            <ul class="withdraw-list">
              <li v-for="d in c.docs" :key="d.id" class="small">
                <span class="chip bad">已撤回</span> {{ d.doc_type }}
                <span class="muted">{{ fmtDate(d.dispatch_date || d.receive_date) }}</span>
                <div class="muted">原因：{{ d.withdraw_reason || '—' }}</div>
              </li>
            </ul>
          </div>

          <!-- 正常列表 -->
          <ul v-else class="doc-list">
            <li v-for="d in c.docs" :key="d.id" :class="{ 'is-off': d.status === '已撤回' }">
              <div class="spread">
                <strong>{{ d.doc_type }}</strong>
                <span class="chip" :class="DOC_STATUS_CHIP[d.status]">{{ DOC_STATUS_TEXT[d.status] }}</span>
              </div>
              <div class="small muted mt8 doc-dates">
                <span>发文日 <strong :class="d.dispatch_date ? '' : 'dim'">{{ fmtDate(d.dispatch_date) }}</strong></span>
                <span>收到日 <strong :class="d.receive_date ? '' : 'dim'">{{ fmtDate(d.receive_date) }}</strong></span>
                <span v-if="!d.receive_date && d.dispatch_date" title="未补录实际收到日时，按发文日+15日推定">
                  推定收到日 <strong class="presumed">{{ fmtDate(d.presumed_receive_date) }}</strong>
                </span>
                <span v-if="d.doc_no" class="doc-no">文号 {{ d.doc_no }}</span>
              </div>
              <div v-if="d.note" class="small muted">备注：{{ d.note }}</div>
              <div v-if="d.status === '已撤回'" class="small" style="color: var(--bad)">撤回原因：{{ d.withdraw_reason || '—' }}</div>
              <div v-if="isFirm() && d.status === '已登记'" class="row mt8">
                <button class="btn sm" @click="archiveDoc(d)">归档</button>
                <button class="btn sm danger" @click="openWithdraw(d)">撤回…</button>
              </div>
            </li>
          </ul>
        </div>

        <!-- 期限 -->
        <div class="card">
          <div class="spread">
            <h3 style="margin: 0">期限</h3>
            <button v-if="isFirm()" class="btn sm" @click="showDeadline = true">＋ 手工登记</button>
          </div>
          <p class="small muted mt8" style="margin-bottom: 10px">
            代理所今日：<strong>{{ c.completion.server_today }}</strong>（{{ c.completion.firm_tz }}）；剩余天数以此为准，不按浏览器本地时区猜。
          </p>
          <ul v-if="c.deadlines.length" class="dl-list">
            <li v-for="d in c.deadlines" :key="d.id">
              <div class="spread">
                <strong>{{ d.dtype }}</strong>
                <span v-if="d.status === '已完成'" class="chip ok">已完成</span>
                <span v-else class="chip" :class="dday(d.due_date, c.completion.server_today).cls">{{ dday(d.due_date, c.completion.server_today).text }}</span>
              </div>
              <div class="small muted mt8">
                到期 {{ fmtDate(d.due_date) }} ·
                {{ ANCHOR_TEXT[d.anchor_basis] || '—' }}起算
                <template v-if="d.start_date">（{{ fmtDate(d.start_date) }}）</template>
                · {{ BASIS_TEXT[d.day_basis] }}
                <template v-if="d.day_basis === 'natural'">不顺延</template>
                <template v-else-if="d.day_basis === 'workday'">跳节假日</template>
                <template v-else>{{ d.rolled ? '·已顺延' : '·未触发顺延' }}</template>
                <template v-if="d.duration_days"> · {{ d.duration_days }} 天</template>
                <span v-if="d.doc_id" class="chip blue" style="margin-left: 4px">官文生成</span>
              </div>
              <div v-if="d.overdue_reason" class="small overdue-reason">超期补登原因：{{ d.overdue_reason }}</div>
              <div v-if="d.note" class="small muted">备注：{{ d.note }}</div>
              <div v-if="isFirm() && d.status !== '已完成'" class="row mt8">
                <button class="btn sm" @click="completeDeadline(d)">标记完成</button>
              </div>
            </li>
          </ul>
          <div v-else class="inline-empty">
            <div class="ie-icon">🗓️</div>
            <p class="ie-title">暂无期限</p>
            <p class="small muted">登记带期限的官文会自动生成，也可手工登记。</p>
          </div>
        </div>
      </div>

      <!-- 费用 -->
      <div class="card">
        <div class="spread">
          <h3 style="margin: 0">费用</h3>
          <button v-if="isFirm()" class="btn sm" @click="showFee = true">＋ 添加</button>
        </div>
        <table class="rtable static mt8" v-if="c.fees.length">
          <tbody>
            <tr v-for="f in c.fees" :key="f.id">
              <td data-label="费用"><span v-if="f.overdue" class="dot"></span> {{ f.kind }}</td>
              <td data-label="金额">{{ fmtMoney(f.amount) }}</td>
              <td data-label="状态">
                <span v-if="f.status === '已缴'" class="chip ok">已缴</span>
                <span v-else-if="f.overdue" class="chip bad">逾期</span>
                <span v-else class="chip warn">待缴 · {{ fmtDate(f.due_date) }}</span>
              </td>
              <td class="no-label" style="text-align: right">
                <button v-if="isFirm() && f.status !== '已缴'" class="btn sm" @click="payFee(f)">缴费</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">暂无费用记录</p>
      </div>

      <!-- 流转记录 -->
      <div class="card">
        <h3>流转记录</h3>
        <ul class="timeline">
          <li v-for="e in c.events" :key="e.id">
            <div class="row">
              <strong>{{ e.action }}</strong>
              <template v-if="e.from_status"><StatusBadge :status="e.from_status" /> → <StatusBadge :status="e.to_status" /></template>
              <template v-else><StatusBadge :status="e.to_status" /></template>
            </div>
            <div class="t-meta">{{ e.actor_name }} · {{ fmtDateTime(e.created_at) }}<span v-if="e.reason"> · {{ e.reason }}</span></div>
          </li>
        </ul>
      </div>

      <!-- 状态流转弹窗 -->
      <Modal v-if="showTransition" title="变更案件状态" @close="showTransition = false">
        <div class="field">
          <label>目标状态（当前：{{ c.status }}）</label>
          <select v-model="transitionForm.to">
            <option v-for="s in allStatuses" :key="s" :value="s" :disabled="s === c.status">
              {{ s }}{{ isAllowed(s) ? '（可执行）' : '' }}
            </option>
          </select>
          <p class="small muted" style="margin: 6px 0 0">法定回退（驳回→复审→发回实审/初审）合法；其余回退与跳步将被状态机拦截并说明原因。</p>
        </div>
        <div v-if="transitionForm.to === '已立项'" class="field">
          <label>指派代理人 *</label>
          <select v-model="transitionForm.agent_id">
            <option :value="null" disabled>请选择</option>
            <option v-for="a in agents" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
        </div>
        <div class="field">
          <label>备注/理由</label>
          <textarea v-model="transitionForm.reason" rows="2" placeholder="将写入流转记录"></textarea>
        </div>
        <p v-if="transitionError" class="small" style="color: var(--bad)">{{ transitionError }}</p>
        <div class="modal-actions">
          <button class="btn" @click="showTransition = false">取消</button>
          <button class="btn primary" :disabled="saving || !transitionForm.to" @click="submitTransition">提交</button>
        </div>
      </Modal>

      <!-- 登记官文 -->
      <DocRegisterModal
        v-if="showDoc"
        :case-id="id"
        :ctype="c.ctype"
        @close="showDoc = false"
        @registered="onDocRegistered"
      />

      <!-- 撤回官文 -->
      <Modal v-if="withdrawTarget" title="撤回官文（留痕）" @close="withdrawTarget = null">
        <p class="small">将撤回「<strong>{{ withdrawTarget.doc_type }}</strong>」。撤回后该官文不再计入归档完成度，原因必填且全程留痕。</p>
        <div class="field"><label>撤回原因（不少于 2 字）*</label>
          <textarea v-model="withdrawReason" rows="3" placeholder="如：官方通知系误发并已撤回、登记有误……"></textarea>
        </div>
        <p v-if="withdrawError" class="small" style="color: var(--bad)">{{ withdrawError }}</p>
        <div class="modal-actions">
          <button class="btn" @click="withdrawTarget = null">取消</button>
          <button class="btn danger" :disabled="saving" @click="submitWithdraw">确认撤回</button>
        </div>
      </Modal>

      <!-- 添加期限（手工） -->
      <Modal v-if="showDeadline" title="手工登记期限" @close="showDeadline = false">
        <div class="field"><label>事项 *</label><input v-model="deadlineForm.dtype" placeholder="例如：口头审理意见陈述" /></div>
        <div class="field"><label>到期日 *</label><input v-model="deadlineForm.due_date" type="date" /></div>
        <div class="grid" style="grid-template-columns: 1fr 1fr">
          <div class="field">
            <label>起算口径</label>
            <select v-model="deadlineForm.anchor_basis">
              <option value="receive">自收到日</option>
              <option value="dispatch">自发文日</option>
            </select>
          </div>
          <div class="field">
            <label>天数口径</label>
            <select v-model="deadlineForm.day_basis">
              <option value="natural">自然日</option>
              <option value="workday">工作日</option>
              <option value="legal">法定节假日顺延</option>
            </select>
          </div>
        </div>
        <div class="grid" style="grid-template-columns: 1fr 96px">
          <div class="field"><label>起算日（留档）</label><input v-model="deadlineForm.start_date" type="date" /></div>
          <div class="field"><label>天数</label><input v-model.number="deadlineForm.duration_days" type="number" min="1" /></div>
        </div>
        <div class="field"><label>备注</label><input v-model="deadlineForm.note" /></div>
        <div v-if="manualOverdue" class="overdue-confirm">
          <strong>到期日早于代理所今日（{{ c.completion.server_today }}），登记即超期</strong>
          <label class="row small mt8" style="gap: 6px"><input type="checkbox" v-model="deadlineForm.confirm_overdue" style="width: auto" /> 我已知悉超期并确认登记</label>
          <div class="field mt8" style="margin-bottom: 0"><label>超期补登原因（不少于 2 字）*</label>
            <textarea v-model="deadlineForm.overdue_reason" rows="2"></textarea>
          </div>
        </div>
        <p v-if="deadlineError" class="small" style="color: var(--bad)">{{ deadlineError }}</p>
        <div class="modal-actions">
          <button class="btn" @click="showDeadline = false">取消</button>
          <button class="btn primary" :disabled="saving" @click="addDeadline">登记</button>
        </div>
      </Modal>

      <!-- 添加费用 -->
      <Modal v-if="showFee" title="添加费用" @close="showFee = false">
        <div class="field"><label>费用项目 *</label><input v-model="feeForm.kind" placeholder="例如：实质审查费" /></div>
        <div class="field"><label>金额（元）*</label><input v-model.number="feeForm.amount" type="number" min="0" /></div>
        <div class="field"><label>缴费截止日 *</label><input v-model="feeForm.due_date" type="date" /></div>
        <div class="modal-actions">
          <button class="btn" @click="showFee = false">取消</button>
          <button class="btn primary" :disabled="saving" @click="addFee">添加</button>
        </div>
      </Modal>

      <RevealModal
        v-if="showReveal"
        :client-id="c.client_id"
        :case-id="c.id"
        @close="showReveal = false"
        @revealed="(n) => (revealedName = n)"
      />
    </template>
    <p v-else class="muted">加载中…</p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { get, mutate } from '../api.js'
import { store, isFirm } from '../store.js'
import { fmtDate, fmtDateTime, fmtMoney, dday, ANCHOR_TEXT, BASIS_TEXT, DOC_STATUS_TEXT, DOC_STATUS_CHIP } from '../utils.js'
import Modal from '../components/Modal.vue'
import StatusBadge from '../components/StatusBadge.vue'
import ErrorState from '../components/ErrorState.vue'
import RevealModal from '../components/RevealModal.vue'
import CompletionMeter from '../components/CompletionMeter.vue'
import DocRegisterModal from '../components/DocRegisterModal.vue'

const route = useRoute()
const id = Number(route.params.id)
const c = ref(null)
const stale = ref(false)
const cachedAt = ref(null)
const error = ref('')
const errorCode = ref('ERROR')
const revealedName = ref('')
const showReveal = ref(false)
const showTransition = ref(false)
const showDoc = ref(false)
const showDeadline = ref(false)
const showFee = ref(false)
const saving = ref(false)
const agents = ref([])
const allStatuses = ['委托中', '已立项', '申请', '受理', '初审', '实审中', '复审中', '授权', '驳回', '无效']
const transitionForm = ref({ to: '', reason: '', agent_id: null })
const transitionError = ref('')
const completionBasis = ref('stage')
const deadlineForm = ref(blankDeadline())
const deadlineError = ref('')
const feeForm = ref({ kind: '', amount: null, due_date: '' })
const withdrawTarget = ref(null)
const withdrawReason = ref('')
const withdrawError = ref('')

function blankDeadline() {
  return { dtype: '', due_date: '', anchor_basis: 'receive', day_basis: 'natural', start_date: '', duration_days: null, note: '', confirm_overdue: false, overdue_reason: '' }
}

const activeDocs = computed(() => (c.value?.docs || []).filter((d) => d.status !== '已撤回'))
const manualOverdue = computed(() => Boolean(deadlineForm.value.due_date && c.value && deadlineForm.value.due_date < c.value.completion.server_today))

// 撰稿三态摘要
const writing = ref(null)
const writingKinds = [
  { key: 'disclosure', label: '技术交底书' },
  { key: 'claims', label: '权利要求草稿' },
  { key: 'specification', label: '说明书定稿' },
]
async function loadWriting() {
  try {
    writing.value = (await get(`/cases/${id}/writing`)).data
  } catch { writing.value = null }
}
function writingStateText(key) {
  return ({ none: '无草稿', void: '草稿全部作废', parsing: '附件解析中', active: '在办' })[writing.value?.kinds[key]?.state] || '—'
}
function writingChip(key) {
  return ({ none: '', void: 'bad', parsing: 'warn', active: 'ok' })[writing.value?.kinds[key]?.state] || ''
}
function writingHint(key) {
  const k = writing.value?.kinds[key]
  if (!k) return ''
  if (k.state === 'none') return '尚未开始；可在工作台新建草稿链。'
  if (k.state === 'void') return `${k.voided_count} 条草稿链已作废，可回到任一历史版本重开。`
  if (k.state === 'parsing') return '原件已上传仍在解析，正文尚未起草。'
  const d = k.doc
  return `${d.status} · 当前 v${d.current_version}${d.status === '已定稿' ? '（定稿提交期限见上方期限列表）' : ''}`
}

const isAllowed = (s) => c.value?.allowed_transitions?.some((t) => t.to === s)

async function load() {
  try {
    const r = await get(`/cases/${id}`, { cacheKey: `case:${id}` })
    c.value = r.data
    stale.value = r.stale
    cachedAt.value = r.cachedAt
    loadWriting()
  } catch (e) {
    // 空态一：加载失败（与「无官文/全撤回」完全分开，由 ErrorState 呈现）
    error.value = e.message
    errorCode.value = e.code
  }
}

async function openTransition(to) {
  transitionError.value = ''
  transitionForm.value = { to: to || allStatuses.find((s) => isAllowed(s)) || '', reason: '', agent_id: null }
  if (!agents.value.length && isFirm()) {
    try {
      agents.value = (await get('/ops/agents')).data
    } catch {}
  }
  showTransition.value = true
}

async function submitTransition() {
  saving.value = true
  transitionError.value = ''
  const body = {
    to: transitionForm.value.to,
    reason: transitionForm.value.reason,
    agent_id: transitionForm.value.agent_id,
  }
  try {
    const r = await mutate('POST', `/cases/${id}/transition`, body, {
      offlineOp: { op: 'case.transition', payload: { case_id: id, ...body }, label: `案件 ${c.value.case_no} 变更为「${body.to}」` },
    })
    showTransition.value = false
    if (r.queued) store.showToast('当前离线：状态变更已加入待同步队列', 'info')
    else {
      store.showToast('状态已更新', 'success')
      await load()
    }
  } catch (e) {
    transitionError.value = e.message
  } finally {
    saving.value = false
  }
}

function onDocRegistered() {
  showDoc.value = false
  load()
}

async function archiveDoc(d) {
  try {
    const r = await mutate('POST', `/docs/${d.id}/archive`, undefined, {
      offlineOp: { op: 'doc.archive', payload: { id: d.id }, label: `归档官文「${d.doc_type}」` },
    })
    store.showToast(r.queued ? '已加入待同步队列' : '官文已归档', r.queued ? 'info' : 'success')
    if (!r.queued) await load()
  } catch (e) {
    store.showToast(e.message, 'error')
  }
}

function openWithdraw(d) {
  withdrawTarget.value = d
  withdrawReason.value = ''
  withdrawError.value = ''
}

async function submitWithdraw() {
  if (withdrawReason.value.trim().length < 2) {
    withdrawError.value = '撤回原因不少于 2 个字'
    return
  }
  saving.value = true
  withdrawError.value = ''
  try {
    await mutate('POST', `/docs/${withdrawTarget.value.id}/withdraw`, { reason: withdrawReason.value.trim() }, {
      offlineOp: { op: 'doc.withdraw', payload: { id: withdrawTarget.value.id, reason: withdrawReason.value.trim() }, label: `撤回官文「${withdrawTarget.value.doc_type}」` },
    })
    store.showToast('官文已撤回并留痕', 'success')
    withdrawTarget.value = null
    await load()
  } catch (e) {
    withdrawError.value = e.message
  } finally {
    saving.value = false
  }
}

async function completeDeadline(d) {
  try {
    const r = await mutate('POST', `/ops/deadlines/${d.id}/complete`, undefined, {
      offlineOp: { op: 'deadline.complete', payload: { id: d.id }, label: `完成期限「${d.dtype}」` },
    })
    store.showToast(r.queued ? '已加入待同步队列' : '期限已标记完成', r.queued ? 'info' : 'success')
    if (!r.queued) await load()
  } catch (e) {
    store.showToast(e.message, 'error')
  }
}

async function payFee(f) {
  try {
    const r = await mutate('POST', `/ops/fees/${f.id}/pay`, undefined, {
      offlineOp: { op: 'fee.pay', payload: { id: f.id }, label: `缴纳「${f.kind}」` },
    })
    store.showToast(r.queued ? '已加入待同步队列' : '已登记缴费', r.queued ? 'info' : 'success')
    if (!r.queued) await load()
  } catch (e) {
    store.showToast(e.message, 'error')
  }
}

async function addDeadline() {
  deadlineError.value = ''
  const f = deadlineForm.value
  if (!f.dtype || !f.due_date) {
    deadlineError.value = '事项与到期日必填'
    return
  }
  if (manualOverdue.value && (!f.confirm_overdue || f.overdue_reason.trim().length < 2)) {
    deadlineError.value = '超期登记必须勾选确认并填写不少于 2 字的原因'
    return
  }
  saving.value = true
  try {
    await mutate('POST', `/cases/${id}/deadlines`, {
      dtype: f.dtype, due_date: f.due_date, note: f.note,
      anchor_basis: f.anchor_basis, day_basis: f.day_basis,
      start_date: f.start_date || null, duration_days: f.duration_days,
      confirm_overdue: f.confirm_overdue, overdue_reason: f.overdue_reason.trim(),
    })
    showDeadline.value = false
    deadlineForm.value = blankDeadline()
    await load()
  } catch (e) {
    deadlineError.value = e.message
  } finally {
    saving.value = false
  }
}

async function addFee() {
  if (!feeForm.value.kind || feeForm.value.amount == null || !feeForm.value.due_date) return
  saving.value = true
  try {
    await mutate('POST', `/cases/${id}/fees`, feeForm.value)
    showFee.value = false
    feeForm.value = { kind: '', amount: null, due_date: '' }
    await load()
  } catch (e) {
    store.showToast(e.message, 'error')
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  load()
  window.addEventListener('pc:synced', load)
})
onUnmounted(() => window.removeEventListener('pc:synced', load))
</script>
