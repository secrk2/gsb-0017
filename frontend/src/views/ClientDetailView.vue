<template>
  <div>
    <ErrorState v-if="error" :code="errorCode" :message="error" />
    <template v-else-if="detail">
      <div v-if="stale" class="offline-banner" style="position: static; border-radius: 8px; margin-bottom: 12px">
        <strong>缓存数据</strong>更新于 {{ fmtDateTime(cachedAt) }}，可能已过期。
      </div>

      <!-- 链路步骤条 -->
      <div class="card">
        <div class="spread">
          <h3 style="margin: 0">
            {{ revealedName || detail.client.name }}
            <span v-if="detail.client.masked && !revealedName" class="lock">🔒 已脱敏</span>
            <span class="chip" :class="detail.client.status === '已签约' ? 'ok' : 'blue'">{{ detail.client.status }}</span>
          </h3>
          <button
            v-if="detail.client.masked && !revealedName && isFirm()"
            class="btn sm"
            @click="showReveal = true"
          >查看全称（留痕）</button>
        </div>
        <p v-if="revealedName" class="small" style="color: var(--warn); margin: 6px 0 0">全称已按留痕流程解密展示，本次查看已记录审计日志。</p>
        <div class="steps">
          <div class="step done">① 客户建档<div class="small muted">{{ fmtDate(detail.client.created_at) }}</div></div>
          <div class="step" :class="hasContract ? 'done' : 'current'">② 签委托合同<div class="small muted">{{ hasContract ? detail.contracts[0].contract_no : '待签订' }}</div></div>
          <div class="step" :class="hasInitiated ? 'done' : hasContract ? 'current' : ''">③ 案件立项派代理人<div class="small muted">{{ hasInitiated ? '已立项办案' : '待立项' }}</div></div>
        </div>
        <div class="row mt16">
          <span class="muted small">联系人：{{ detail.client.contact_name || '—' }} · {{ detail.client.contact_phone || '—' }} · {{ detail.client.contact_email || '—' }}</span>
        </div>
        <div class="row mt8">
          <button v-if="store.user?.role === 'admin' && !hasContract" class="btn primary sm" @click="showContract = true">签订委托合同</button>
          <button v-if="isFirm()" class="btn sm" @click="showCase = true">＋ 新建委托案件</button>
        </div>
      </div>

      <!-- 合同 -->
      <div class="card">
        <h3>委托合同</h3>
        <table class="rtable static" v-if="detail.contracts.length">
          <thead><tr><th>合同号</th><th>标的</th><th>金额</th><th>状态</th><th>签署时间</th></tr></thead>
          <tbody>
            <tr v-for="c in detail.contracts" :key="c.id">
              <td data-label="合同号">{{ c.contract_no }}</td>
              <td data-label="标的">{{ c.title }}</td>
              <td data-label="金额">{{ fmtMoney(c.amount) }}</td>
              <td data-label="状态"><span class="chip ok">{{ c.status }}</span></td>
              <td data-label="签署时间">{{ fmtDateTime(c.signed_at) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">尚未签订委托合同。未签约前案件不能立项（系统会拦截并提示）。</p>
      </div>

      <!-- 案件 -->
      <div class="card">
        <h3>名下案件（{{ detail.cases.length }}）</h3>
        <table class="rtable" v-if="detail.cases.length">
          <thead><tr><th>案件号</th><th>名称</th><th>类型</th><th>状态</th><th>代理人</th><th>更新时间</th></tr></thead>
          <tbody>
            <tr v-for="c in detail.cases" :key="c.id" @click="$router.push(`/cases/${c.id}`)">
              <td data-label="案件号">{{ c.case_no }}</td>
              <td data-label="名称">{{ c.title }}</td>
              <td data-label="类型">{{ c.ctype }}</td>
              <td data-label="状态"><StatusBadge :status="c.status" /></td>
              <td data-label="代理人">{{ c.agent_name || '待指派' }}</td>
              <td data-label="更新时间">{{ fmtDateTime(c.updated_at) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">暂无案件，点击「新建委托案件」开始。</p>
      </div>

      <!-- 签约弹窗 -->
      <Modal v-if="showContract" title="签订委托合同" @close="showContract = false">
        <div class="field"><label>合同标的 *</label><input v-model="contractForm.title" placeholder="例如：专利代理委托合同（XX）" /></div>
        <div class="field"><label>合同金额（元）</label><input v-model.number="contractForm.amount" type="number" min="0" /></div>
        <p v-if="contractError" class="small" style="color: var(--bad)">{{ contractError }}</p>
        <div class="modal-actions">
          <button class="btn" @click="showContract = false">取消</button>
          <button class="btn primary" :disabled="saving" @click="signContract">签订</button>
        </div>
      </Modal>

      <!-- 新建案件弹窗 -->
      <Modal v-if="showCase" title="新建委托案件" @close="showCase = false">
        <p class="small muted" style="margin-top: 0">创建后状态为「委托中」；签约完成后方可在案件详情中立项。断网时也可创建，将自动进入待同步队列。</p>
        <div class="field"><label>发明名称 *</label><input v-model="caseForm.title" placeholder="例如：一种 XXX 方法" /></div>
        <div class="field">
          <label>案件类型</label>
          <select v-model="caseForm.ctype"><option>发明</option><option>实用新型</option><option>外观设计</option></select>
        </div>
        <div class="field">
          <label>优先级</label>
          <select v-model="caseForm.priority"><option>普通</option><option>高</option><option>低</option></select>
        </div>
        <p v-if="caseError" class="small" style="color: var(--bad)">{{ caseError }}</p>
        <div class="modal-actions">
          <button class="btn" @click="showCase = false">取消</button>
          <button class="btn primary" :disabled="saving" @click="createCase">创建</button>
        </div>
      </Modal>

      <RevealModal
        v-if="showReveal"
        :client-id="detail.client.id"
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
import { fmtDate, fmtDateTime, fmtMoney, uuid } from '../utils.js'
import Modal from '../components/Modal.vue'
import StatusBadge from '../components/StatusBadge.vue'
import ErrorState from '../components/ErrorState.vue'
import RevealModal from '../components/RevealModal.vue'

const route = useRoute()
const id = Number(route.params.id)
const detail = ref(null)
const stale = ref(false)
const cachedAt = ref(null)
const error = ref('')
const errorCode = ref('ERROR')
const revealedName = ref('')
const showReveal = ref(false)
const showContract = ref(false)
const showCase = ref(false)
const saving = ref(false)
const contractForm = ref({ title: '', amount: 0 })
const contractError = ref('')
const caseForm = ref({ title: '', ctype: '发明', priority: '普通' })
const caseError = ref('')

const hasContract = computed(() => detail.value?.contracts?.length > 0)
const hasInitiated = computed(() => detail.value?.cases?.some((c) => c.status !== '委托中'))

async function load() {
  try {
    const r = await get(`/clients/${id}`, { cacheKey: `client:${id}` })
    detail.value = r.data
    stale.value = r.stale
    cachedAt.value = r.cachedAt
  } catch (e) {
    error.value = e.message
    errorCode.value = e.code
  }
}

async function signContract() {
  contractError.value = ''
  if (!contractForm.value.title.trim()) {
    contractError.value = '请填写合同标的'
    return
  }
  saving.value = true
  try {
    await mutate('POST', `/clients/${id}/contracts`, contractForm.value)
    showContract.value = false
    store.showToast('合同已签订，客户状态更新为「已签约」', 'success')
    await load()
  } catch (e) {
    contractError.value = e.message
  } finally {
    saving.value = false
  }
}

async function createCase() {
  caseError.value = ''
  if (!caseForm.value.title.trim()) {
    caseError.value = '请填写发明名称'
    return
  }
  saving.value = true
  // client_uuid 在离线/在线两种路径下保持一致：重试、刷新、同步重放都不会产生重复案件
  const body = { client_uuid: uuid(), client_id: id, ...caseForm.value }
  try {
    const r = await mutate('POST', '/cases', body, { offlineOp: { op: 'case.create', payload: body, label: `新建案件「${body.title}」` } })
    showCase.value = false
    if (r.queued) {
      store.showToast('当前离线：案件已加入待同步队列，恢复网络后自动创建', 'info')
    } else {
      store.showToast('委托案件已创建', 'success')
      await load()
    }
    caseForm.value = { title: '', ctype: '发明', priority: '普通' }
  } catch (e) {
    caseError.value = e.message
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
