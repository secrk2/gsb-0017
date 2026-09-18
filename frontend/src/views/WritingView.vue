<template>
  <div>
    <ErrorState v-if="error" :code="errorCode" :message="error" />
    <template v-else-if="ov">
      <!-- 头部 -->
      <div class="card">
        <div class="spread">
          <div>
            <div class="row">
              <router-link :to="`/cases/${caseId}`" class="back-link">← 返回案件</router-link>
            </div>
            <h3 style="margin: 6px 0 0">撰稿 · {{ ov.case_no }} {{ ov.case_title }}</h3>
            <div class="muted small mt8">
              {{ ov.case_status }} · 代理所今日 <strong>{{ ov.server_today }}</strong>（{{ ov.firm_tz }}）·
              三类文档共用一条版本链，每次保存生成不可变版本
            </div>
          </div>
          <div v-if="!isFirm()" class="mask-banner-box">
            <span class="chip warn">客户脱敏版</span>
            <p class="small muted" style="margin: 6px 0 0">未公开技术细节与在先引用已按规则隐藏（{{ maskedRuleHint }}）；代理所见原文，两边共用同一条版本链。</p>
          </div>
        </div>
        <div class="tabs mt16">
          <button
            v-for="k in KINDS"
            :key="k.key"
            class="tab"
            :class="{ active: kind === k.key }"
            @click="switchKind(k.key)"
          >
            {{ k.label }}
            <span class="tab-state" :class="stateClass(ov.kinds[k.key].state)">{{ stateText(ov.kinds[k.key].state) }}</span>
          </button>
        </div>
      </div>

      <!-- ========== 空态一：还没有草稿 ========== -->
      <div v-if="cur.state === 'none'" class="card mt16">
        <div class="inline-empty">
          <div class="ie-icon">📝</div>
          <p class="ie-title">还没有{{ curKindLabel }}草稿</p>
          <p class="small muted">
            {{ kind === 'disclosure'
              ? '交底书由客户与代理人协同完成：新建后每次保存生成版本，双方同改一段会进入段落级取舍，不会互相覆盖。'
              : '由代理人起草，保存即生成版本；定稿后可挂附件原件并联动定稿提交期限。' }}
          </p>
          <button v-if="canCreate" class="btn primary mt8" @click="createDoc">＋ 新建{{ curKindLabel }}</button>
          <p v-else class="small" style="color: var(--warn); margin-top: 8px">权利要求草稿与说明书定稿由代理人侧起草，您可在其定稿后查看脱敏版。</p>
        </div>
      </div>

      <!-- ========== 空态二：草稿全部作废 ========== -->
      <div v-else-if="cur.state === 'void'" class="card mt16">
        <div class="inline-empty" style="text-align: left">
          <div class="ie-icon">🗃️</div>
          <p class="ie-title">{{ curKindLabel }}草稿已全部作废（{{ cur.voided_count }} 条链）</p>
          <p class="small muted">作废稿的每个版本与原文均保留留痕，可查看差异，也可回到任一版本重开一条新草稿链。</p>
          <ul class="void-list mt8">
            <li v-for="d in cur.voided_docs" :key="d.id" class="void-item">
              <div class="spread">
                <strong>{{ d.title || curKindLabel }}</strong>
                <span class="chip bad">已作废 · {{ d.current_version }} 版</span>
              </div>
              <div class="row mt8">
                <button class="btn sm" @click="openVoidDoc(d)">查看作废链 / 差异</button>
                <button v-if="canWriteKind" class="btn sm primary" @click="openRestartPicker(d)">回到历史版本重开…</button>
              </div>
            </li>
          </ul>
        </div>
      </div>

      <!-- ========== 空态三：附件还在解析（选择直接起草后由下方工作区接管） ========== -->
      <div v-else-if="cur.state === 'parsing' && !forceOpen" class="card mt16">
        <div class="inline-empty">
          <div class="ie-icon parsing">⏳</div>
          <p class="ie-title">原件已上传，附件还在解析</p>
          <p class="small muted">交底正文尚未开始；扫描件/OCR 解析完成后即可据此起草。解析期间原件已可下载，换版会保留旧版本。</p>
          <div class="row mt8" style="justify-content: center">
            <button class="btn" @click="refreshParsing">刷新解析状态</button>
            <button class="btn primary" @click="openBlankDraft">先建空白正文起草</button>
          </div>
        </div>
      </div>

      <!-- ========== 活动文档（含 parsing 空态下选择直接起草零版本链） ========== -->
      <template v-else-if="cur.doc && (cur.state === 'active' || forceOpen)">
        <WritingWorkspace
          v-if="doc && doc.id === cur.doc.id"
          :doc="doc"
          :kind-def="doc.kind_def"
          :is-firm="isFirm()"
          :server-today="ov.server_today"
          @reload="onWorkspaceReload"
          @changed="onChanged"
        />
        <p v-else class="muted mt16">载入中…</p>
      </template>

      <!-- 作废链查看（只读 + 重开入口） -->
      <Modal v-if="voidDoc" :title="`作废链 · ${voidDoc.title || curKindLabel}`" @close="voidDoc = null">
        <p class="small muted">该链已作废，以下版本只读；可回到任一版本重开新链。</p>
        <ul class="ver-chain">
          <li v-for="v in voidDoc.versions" :key="v.id">
            <div class="spread">
              <span><strong>v{{ v.version_no }}</strong> <span class="chip" :class="saveChip(v.save_type)">{{ v.save_type }}</span></span>
              <span class="small muted">{{ v.actor_name }} · {{ fmtDateTime(v.created_at) }}</span>
            </div>
            <p class="small mt8" style="margin-bottom: 6px">{{ v.summary }}</p>
            <div class="row">
              <button class="btn sm" @click="viewVersion(v)">查看全文 / 差异</button>
              <button v-if="canWriteKind" class="btn sm primary" @click="restartFrom(voidDoc, v)">回到此版重开</button>
            </div>
          </li>
        </ul>
      </Modal>

      <!-- 作废链历史版本只读全文 -->
      <Modal v-if="voidVersion" :title="`v${voidVersion.version_no} · ${voidVersion.save_type}`" @close="voidVersion = null">
        <div class="small muted mb8">{{ voidVersion.actor_name }}（{{ roleName(voidVersion.actor_role) }}）· {{ fmtDateTime(voidVersion.created_at) }} · {{ voidVersion.summary }}</div>
        <div v-if="voidVersion.masked" class="mask-note mb8">客户脱敏视图（按该版保存时规则 v{{ voidVersion.mask_rule_version }} 快照渲染）</div>
        <div v-for="sec in voidVersion.content.sections" :key="sec.key" class="vsec">
          <h4>{{ sec.title }}</h4>
          <div v-if="sec.hidden" class="hidden-section">{{ sec.placeholder }}</div>
          <p v-for="p in sec.paragraphs" :key="p.id" class="vpara" :class="{ maskedPara: p.masked }">{{ p.text }}</p>
          <p v-if="!sec.hidden && !sec.paragraphs.length" class="small muted">（空）</p>
        </div>
        <div class="modal-actions">
          <button class="btn" @click="voidVersion = null">关闭</button>
          <button v-if="canWriteKind" class="btn primary" @click="restartFrom(voidDoc, { id: voidVersion.id, version_no: voidVersion.version_no }); voidVersion = null">回到此版重开</button>
        </div>
      </Modal>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { get, mutate } from '../api.js'
import { store, isFirm, roleName } from '../store.js'
import { fmtDateTime } from '../utils.js'
import ErrorState from '../components/ErrorState.vue'
import Modal from '../components/Modal.vue'
import WritingWorkspace from '../components/WritingWorkspace.vue'

const route = useRoute()
const caseId = Number(route.params.id)
const KINDS = [
  { key: 'disclosure', label: '技术交底书' },
  { key: 'claims', label: '权利要求草稿' },
  { key: 'specification', label: '说明书定稿' },
]

const ov = ref(null)
const kind = ref('disclosure')
const doc = ref(null)
const forceOpen = ref(false)
const error = ref('')
const errorCode = ref('ERROR')
const voidDoc = ref(null)
const voidVersion = ref(null)

const cur = computed(() => ov.value?.kinds[kind.value])
const curKindLabel = computed(() => KINDS.find((k) => k.key === kind.value).label)
const canCreate = computed(() => (isFirm() ? true : kind.value === 'disclosure'))
const canWriteKind = computed(() => (isFirm() ? true : kind.value === 'disclosure'))
const maskedRuleHint = computed(() => `规则 v${ov.value?.mask_rule_version ?? '—'}：隐藏未公开章节，参数/文献号句内遮蔽`)

function stateText(s) {
  return ({ none: '无草稿', void: '已作废', parsing: '解析中', active: '在办' })[s] || s
}
function stateClass(s) {
  return ({ none: 'st-none', void: 'st-void', parsing: 'st-parsing', active: 'st-active' })[s] || ''
}
function saveChip(t) {
  return ({ 草稿: 'warn', 定稿: 'ok', 作废: 'bad', 冲突合并: 'purple' })[t] || ''
}

async function reloadOverview() {
  const r = await get(`/cases/${caseId}/writing`, { cacheKey: `writing:${caseId}` })
  ov.value = r.data
}

async function switchKind(k) {
  kind.value = k
  doc.value = null
  forceOpen.value = false
  const c = ov.value.kinds[k]
  if (c.state === 'active' && c.doc) loadDoc(c.doc.id)
}

async function createDoc() {
  try {
    const r = await mutate('POST', `/cases/${caseId}/writing/${kind.value}`, { title: curKindLabel.value })
    store.showToast('已新建草稿链', 'success')
    await reloadOverview()
    await loadDoc(r.data.id)
  } catch (e) {
    store.showToast(e.message, 'error')
  }
}

async function loadDoc(id, silent = false) {
  try {
    const r = await get(`/writing/docs/${id}`)
    doc.value = r.data
  } catch (e) {
    if (!silent) { error.value = e.message; errorCode.value = e.code }
  }
}

async function startEditingBlank() {
  // parsing 态下链已存在（零版本），直接打开该链的工作区起草，不再调新建（会撞 DOC_EXISTS）
  await openBlankDraft()
}
async function openBlankDraft() {
  await loadDoc(cur.value.doc.id)
  forceOpen.value = true
}
async function onChanged() {
  await reloadOverview()
  if (cur.value.state === 'active') forceOpen.value = true
}
// 工作区内部触发的重载：附件标记解析完成等场景顺带刷新总览（可能从 parsing 转为 active）
async function onWorkspaceReload() {
  await loadDoc(cur.value.doc.id, true)
  await reloadOverview()
}
async function refreshParsing() {
  await reloadOverview()
  store.showToast('解析状态已刷新', 'info')
}

async function openVoidDoc(d) {
  try {
    const r = await get(`/writing/docs/${d.id}`)
    voidDoc.value = r.data
  } catch (e) {
    store.showToast(e.message, 'error')
  }
}

function openRestartPicker(d) {
  openVoidDoc(d)
}

async function restartFrom(d, v) {
  try {
    await mutate('POST', `/cases/${caseId}/writing/${kind.value}/restart`, { version_id: v.id })
    store.showToast(`已自第 ${v.version_no} 版重开新草稿链`, 'success')
    voidDoc.value = null
    await reloadOverview()
    const nd = ov.value.kinds[kind.value].doc
    if (nd) await loadDoc(nd.id)
  } catch (e) {
    store.showToast(e.message, 'error')
  }
}

async function viewVersion(v) {
  try {
    const r = await get(`/writing/versions/${v.id}`)
    voidVersion.value = r.data.version
  } catch (e) {
    store.showToast(e.message, 'error')
  }
}

onMounted(async () => {
  try {
    await reloadOverview()
    const firstActive = KINDS.find((k) => ov.value.kinds[k.key].state === 'active')
    if (firstActive) {
      kind.value = firstActive.key
      await loadDoc(ov.value.kinds[firstActive.key].doc.id)
    }
  } catch (e) {
    error.value = e.message
    errorCode.value = e.code
  }
})
</script>
