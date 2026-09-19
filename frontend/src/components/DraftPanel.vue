<template>
  <div class="card draft-panel">
    <div class="spread">
      <h3 style="margin: 0">撰稿与交底</h3>
      <div class="seg" v-if="!loading">
        <button v-for="t in TYPES" :key="t.key" :class="{ on: activeType === t.key }" @click="switchType(t.key)">
          {{ t.label }}
          <span v-if="badge(t.key)" class="draft-badge">{{ badge(t.key) }}</span>
        </button>
      </div>
    </div>
    <p class="small muted mt8">
      技术交底书、权利要求草稿、说明书定稿共用同一条版本链：每次保存生成一个版本，可看前后差异、可从任一历史版本重开。
      <span v-if="!firm">您当前看到的是<strong>脱敏版</strong>（未公开技术细节与在先引用已隐去），代理人所见为原文。</span>
    </p>

    <div v-if="loading || !detail" class="muted small">载入中…</div>

    <template v-else-if="detail">
      <!-- 脱敏提示条 -->
      <div v-if="detail.current_version?.masked" class="mask-banner">
        🔒 脱敏视图：本版本按 v{{ detail.current_version.mask_rule_version }} 规则生成；标记段落与在先引用对您隐去，您与代理人仍共用同一条版本链。
      </div>

      <!-- 空态一：还没有草稿 -->
      <div v-if="detail.empty_state === 'no_draft'" class="inline-empty">
        <div class="ie-icon">📝</div>
        <p class="ie-title">还没有{{ detail.label }}草稿</p>
        <p class="small muted">{{ noDraftHint }}</p>
        <button v-if="canEdit" class="btn primary sm mt8" @click="startEditing()">＋ 开始撰写</button>
      </div>

      <!-- 空态二：草稿全部作废 -->
      <div v-else-if="detail.empty_state === 'all_void'" class="inline-empty">
        <div class="ie-icon">🧹</div>
        <p class="ie-title">{{ detail.label }}草稿已全部作废</p>
        <p class="small muted">共有 {{ detail.versions.length }} 个历史版本被作废（原因随版本留痕）。可以从任一版本重开草稿，链不会断。</p>
        <ul class="void-list">
          <li v-for="v in detail.versions" :key="v.id" class="small">
            <span class="chip bad">v{{ v.version_no }} 已作废</span>
            <span class="muted">{{ v.author_name }} · {{ fmtDateTime(v.created_at) }}</span>
            <div class="muted">作废原因：{{ v.void_reason || '—' }}</div>
            <button v-if="canEdit" class="btn sm mt8" @click="askReopen(v)">从此版本重开</button>
          </li>
        </ul>
        <button v-if="canEdit" class="btn sm" @click="startEditing()">从空白版本重开</button>
      </div>

      <!-- 空态三：附件还在解析 -->
      <div v-else-if="detail.empty_state === 'attachment_parsing'" class="inline-empty">
        <div class="ie-icon parsing-spin">⌛</div>
        <p class="ie-title">交底原件还在解析</p>
        <p class="small muted">
          客户刚上传了原件（{{ parsingAttachment?.current?.original_name }}），正在做版式识别与全文索引，文本草稿需等解析就绪后基于其内容撰写。
          每 2.5 秒自动刷新；不会拿半截解析结果冒充就绪。
        </p>
        <p v-if="parsingAttachment?.current?.parse_note" class="small muted">{{ parsingAttachment.current.parse_note }}</p>
        <button v-if="firm" class="btn sm mt8" @click="startEditing()">不依赖解析，先手写草稿</button>
      </div>

      <template v-else>
        <!-- 当前版本 + 编辑器 -->
        <div class="spread mt16">
          <div class="row">
            <strong>{{ detail.finalized ? '已定稿文本' : '当前有效版本' }}</strong>
            <span class="chip blue">v{{ detail.current_version.version_no }}</span>
            <span v-if="detail.finalized" class="chip ok">已定稿</span>
            <span class="small muted">{{ detail.current_version.author_name }}（{{ roleLabel(detail.current_version.author_role) }}）· {{ fmtDateTime(detail.current_version.created_at) }}</span>
          </div>
          <div class="row">
            <button v-if="canEdit && !editing && !detail.finalized" class="btn sm primary" @click="startEditing()">✎ 编辑新版本</button>
            <button v-if="firm && !detail.finalized" class="btn sm" @click="openFinalize()">定稿…</button>
          </div>
        </div>
        <p v-if="detail.current_version.summary" class="small muted mt8">本次说明：{{ detail.current_version.summary }}</p>

        <!-- 只读段落 -->
        <div v-if="!editing" class="para-list">
          <div v-for="p in detail.current_version.paras" :key="p.key" class="para" :class="{ locked: p.masked || p.masked_tag }">
            <div class="para-tags">
              <span v-for="tg in (p.tags || [])" :key="tg" class="chip purple">{{ tagLabel(tg) }}</span>
              <span v-if="p.masked_tag" class="chip bad">{{ tagLabel(p.masked_tag) }}·已隐去</span>
              <span v-else-if="p.masked" class="chip warn">部分内容已脱敏</span>
            </div>
            <p class="para-text">{{ p.text }}</p>
          </div>
        </div>

        <!-- 编辑器 -->
        <div v-else class="editor">
          <div class="small muted">将基于 v{{ parentVersion?.version_no || '新' }} 保存为新版本；他人在此期间的改动会自动合并，同一段被双方改时会请你逐段取舍。</div>
          <div v-for="(p, i) in draftParas" :key="p.key" class="para-edit">
            <div class="spread">
              <div class="row">
                <span class="small muted">第 {{ i + 1 }} 段</span>
                <template v-if="firm">
                  <label class="row small" style="gap: 4px"><input type="checkbox" :checked="hasTag(p, 'secret')" @change="toggleTag(p, 'secret')" /> 未公开细节</label>
                  <label class="row small" style="gap: 4px"><input type="checkbox" :checked="hasTag(p, 'citation')" @change="toggleTag(p, 'citation')" /> 在先引用</label>
                </template>
                <span v-else-if="p.locked" class="chip bad">🔒 含敏感内容，客户侧锁定（保留原文）</span>
              </div>
              <button class="link-btn-small" :disabled="p.locked" @click="removePara(i)">删除段</button>
            </div>
            <textarea v-model="p.text" rows="3" :readonly="p.locked" :placeholder="p.locked ? '该段含未公开细节/在先引用，客户侧不可编辑，保存时自动保留代理人原文' : ''"></textarea>
          </div>
          <button v-if="canAddPara" class="btn sm mt8" @click="addPara">＋ 增加段落</button>
          <div class="field mt8"><label>本次修改说明（留痕）</label><input v-model="editSummary" placeholder="例如：补充实施例2、按客户意见调整背景技术" /></div>
          <p v-if="saveError" class="small" style="color: var(--bad)">{{ saveError }}</p>
          <div class="row mt8">
            <button class="btn primary sm" :disabled="saving" @click="saveDraft()">保存为新版本</button>
            <button class="btn sm" :disabled="saving" @click="cancelEditing()">取消</button>
            <span v-if="mergingHint" class="small muted">{{ mergingHint }}</span>
          </div>
        </div>

        <!-- 定稿提交期限 -->
        <div v-if="detail.deadline" class="deadline-strip">
          <div class="row">
            <strong>定稿提交期限</strong>
            <span class="chip" :class="deadlineChip(detail.deadline)">{{ deadlineText(detail.deadline) }}</span>
          </div>
          <div class="small muted mt8">
            到期 <strong>{{ fmtDate(detail.deadline.due_date) }}</strong>
            · 以<strong>{{ detail.deadline.anchor_basis === 'receive' ? '收到日' : '发文日' }}</strong>为准起算
            <template v-if="detail.deadline.start_date">（{{ fmtDate(detail.deadline.start_date) }}）</template>
            · {{ BASIS_TEXT[detail.deadline.day_basis] }}
            <template v-if="detail.deadline.day_basis === 'legal'">{{ detail.deadline.rolled ? '，已触发节假日顺延' : '，未触发顺延' }}</template>
            <template v-if="detail.deadline.duration_days"> · {{ detail.deadline.duration_days }} 天</template>
            <div>{{ detail.deadline.basis_hint }}</div>
          </div>
          <div v-if="detail.deadline.overdue_reason" class="small overdue-reason">超期定稿原因：{{ detail.deadline.overdue_reason }}</div>
        </div>

        <!-- 附件原件（对象存储，不入库） -->
        <div class="attach-box">
          <div class="spread">
            <strong class="small">附件原件（对象存储）</strong>
            <div class="row">
              <label v-if="canEdit && !detail.finalized" class="btn sm">
        {{ uploading ? '上传中…' : '上传 / 换版原件' }}
                <input type="file" style="display: none" :disabled="uploading" @change="onFile" />
              </label>
            </div>
          </div>
          <p v-if="!detail.attachments.length" class="small muted mt8">尚无附件。定稿可挂原件；换版生成新对象，历史版本引用的旧对象永久可下载。</p>
          <ul v-else class="att-list">
            <li v-for="a in detail.attachments" :key="a.id">
              <div class="spread">
                <div class="row">
                  <strong class="small">{{ a.current?.original_name || '原件' }}</strong>
                  <span class="chip blue">v{{ a.current?.version_no }}</span>
                  <span class="chip" :class="parseChip(a.status)">{{ a.status }}</span>
                </div>
                <button class="btn sm" @click="downloadCurrent(a.id)">下载当前版</button>
              </div>
              <div class="small muted mt8">
                {{ formatBytes(a.current?.size) }} · {{ fmtDateTime(a.current?.created_at) }}
                <span v-if="a.current?.parse_note"> · {{ a.current.parse_note }}</span>
              </div>
              <div v-if="a.files.length > 1" class="small muted mt8">
                历史文件版本：
                <span v-for="f in a.files.slice(1)" :key="f.id" class="chip" style="margin-right: 4px">v{{ f.version_no }}（{{ f.parse_status }}）</span>
              </div>
            </li>
          </ul>
        </div>

        <!-- 版本链 -->
        <div class="version-box">
          <strong class="small">版本链（{{ detail.versions.length }}）</strong>
          <ul class="ver-list">
            <li v-for="v in detail.versions" :key="v.id" :class="{ off: v.status === '已作废', current: v.id === detail.current_version.id }">
              <div class="spread">
                <div class="row">
                  <span class="chip" :class="v.status === '已作废' ? 'bad' : v.id === detail.current_version.id ? 'blue' : ''">v{{ v.version_no }}</span>
                  <span class="small">{{ v.author_name }}（{{ roleLabel(v.author_role) }}）· {{ fmtDateTime(v.created_at) }}</span>
                  <span v-if="v.merged_from_id" class="chip purple" title="与他人并发编辑后合并">并发合并</span>
                </div>
                <div class="row">
                  <button class="btn sm" @click="openDiff(v)">差异</button>
                  <button v-if="v.attachment_file_id" class="btn sm" @click="downloadVersion(v)">当时附件</button>
                  <button v-if="canEdit && !detail.finalized && v.status === '有效'" class="btn sm" @click="askReopen(v)">基于此版编辑</button>
                  <button v-if="firm && !detail.finalized && v.status === '有效' && detail.versions.filter((x) => x.status === '有效').length" class="btn sm danger" @click="askVoid(v)">作废</button>
                </div>
              </div>
              <div v-if="v.summary" class="small muted">说明：{{ v.summary }}</div>
              <div v-if="v.status === '已作废'" class="small" style="color: var(--bad)">已作废：{{ v.void_reason }}（{{ fmtDateTime(v.voided_at) }}）</div>
              <div v-if="v.merge_resolutions?.length" class="small muted">冲突取舍：{{ v.merge_resolutions.map((r) => `${r.by} 采用「${r.pick === 'mine' ? '自己' : r.pick === 'theirs' ? '对方' : '折中'}」`).join('；') }}</div>
            </li>
          </ul>
        </div>
      </template>
    </template>

    <!-- 段落冲突取舍 -->
    <Modal v-if="conflict" title="同一段落被双方同时修改，请逐段取舍" @close="conflict = null">
      <p class="small">你的修改<strong>不会</strong>被后来者静默覆盖，系统也不会用「已锁定」把你拒掉。请对下面 {{ conflict.conflicts.length }} 个冲突段落逐一选择：</p>
      <div v-for="cf in conflict.conflicts" :key="cf.key" class="conflict-block">
        <div class="small muted">段落 {{ paraIndex(cf.key) + 1 || '' }} · {{ cf.reason }}</div>
        <div class="conflict-cols">
          <label class="conflict-opt" :class="{ pick: choice(cf.key) === 'mine' }">
            <input type="radio" :name="'cf-' + cf.key" value="mine" @change="setChoice(cf.key, 'mine')" />
            <div><strong>我的版本</strong><p class="small">{{ cf.mine?.text || '（我删除了该段）' }}</p></div>
          </label>
          <label class="conflict-opt" :class="{ pick: choice(cf.key) === 'theirs' }">
            <input type="radio" :name="'cf-' + cf.key" value="theirs" @change="setChoice(cf.key, 'theirs')" />
            <div><strong>对方（v{{ conflict.current_version_no }}）</strong><p class="small">{{ cf.theirs?.text || '（对方删除了该段）' }}</p></div>
          </label>
        </div>
        <label class="conflict-opt" :class="{ pick: choice(cf.key) === 'custom' }">
          <input type="radio" :name="'cf-' + cf.key" value="custom" @change="setChoice(cf.key, 'custom')" />
          <span class="small">折中自拟：</span>
          <textarea rows="2" v-model="customText[cf.key]" @focus="setChoice(cf.key, 'custom')"></textarea>
        </label>
      </div>
      <p v-if="conflictError" class="small" style="color: var(--bad)">{{ conflictError }}</p>
      <div class="modal-actions">
        <button class="btn" @click="conflict = null">取消</button>
        <button class="btn primary" :disabled="saving" @click="resolveAndSave()">按取舍合并保存</button>
      </div>
    </Modal>

    <!-- 定稿 -->
    <Modal v-if="finalizeOpen" title="定稿与提交期限" @close="finalizeOpen = false">
      <p class="small">定稿将冻结文本（以当前 v{{ detail?.current_version?.version_no }} 为准），并可同时登记一条「{{ activeDef?.deadlineLabel }}」期限，口径与官文期限完全一致。</p>
      <div class="field">
        <label>起算依据</label>
        <select v-model="finForm.source_mode" @change="finForm.source_doc_id = null">
          <option value="doc">沿用官文（发文日/收到日）</option>
          <option value="manual">手工填写日期</option>
        </select>
      </div>
      <div v-if="finForm.source_mode === 'doc'" class="field">
        <label>选择官文</label>
        <select v-model="finForm.source_doc_id">
          <option :value="null" disabled>请选择</option>
          <option v-for="d in activeDocs" :key="d.id" :value="d.id" :disabled="d.status === '已撤回'">
            {{ d.doc_type }}（发文 {{ fmtDate(d.dispatch_date) }} / 收到 {{ fmtDate(d.receive_date) }}）
          </option>
        </select>
      </div>
      <div v-else class="grid" style="grid-template-columns: 1fr 1fr">
        <div class="field"><label>发文日</label><input type="date" v-model="finForm.dispatch_date" /></div>
        <div class="field"><label>收到日</label><input type="date" v-model="finForm.receive_date" /></div>
      </div>
      <div class="grid" style="grid-template-columns: 1fr 1fr">
        <div class="field">
          <label>起算口径（以谁为准）</label>
          <select v-model="finForm.anchor">
            <option value="receive">自收到日（缺收到日按发文+15日推定）</option>
            <option value="dispatch">自发文日</option>
          </select>
        </div>
        <div class="field">
          <label>天数口径</label>
          <select v-model="finForm.day_basis">
            <option value="natural">自然日</option>
            <option value="workday">工作日</option>
            <option value="legal">法定节假日顺延</option>
          </select>
        </div>
      </div>
      <div class="field"><label>期限天数</label><input type="number" min="1" v-model.number="finForm.duration_days" /></div>
      <div v-if="finPreview" class="preview-box" :class="{ overdue: finPreview.overdue }">
        <div class="small">
          起算日 <strong>{{ fmtDate(finPreview.start_date) }}</strong>（{{ finPreview.start_kind }}）
          → 到期 <strong>{{ fmtDate(finPreview.due_date) }}</strong>
          <span v-if="finPreview.rolled" class="chip bad">已顺延</span>
          · {{ finPreview.overdue ? `已逾期 ${-finPreview.days_left} 天` : `剩余 ${finPreview.days_left} 天` }}
        </div>
        <div class="small muted mt8">{{ finPreview.anchor_hint }}；{{ finPreview.basis_hint }}（代理所今日 {{ finPreview.server_today }}，{{ finPreview.firm_tz }}）</div>
      </div>
      <div v-if="finPreview?.overdue" class="overdue-confirm">
        <strong>到期日早于代理所今日，定稿即超期</strong>
        <label class="row small mt8" style="gap: 6px"><input type="checkbox" v-model="finForm.confirm_overdue" style="width: auto" /> 我已知悉超期仍确认定稿</label>
        <div class="field mt8" style="margin-bottom: 0"><label>超期原因（不少于 2 字，留痕）*</label><textarea rows="2" v-model="finForm.overdue_reason"></textarea></div>
      </div>
      <p v-if="finalizeError" class="small" style="color: var(--bad)">{{ finalizeError }}</p>
      <div class="modal-actions">
        <button class="btn" @click="finalizeOpen = false">取消</button>
        <button class="btn primary" :disabled="saving" @click="submitFinalize()">确认定稿</button>
      </div>
    </Modal>

    <!-- 作废 -->
    <Modal v-if="voidTarget" title="作废版本（留痕）" @close="voidTarget = null">
      <p class="small">作废 v{{ voidTarget.version_no }} 后它不再参与有效版本链；若这是最后一个有效版本，该案将进入「草稿全部作废」空态，仍可随时从本版本重开。</p>
      <div class="field"><label>作废原因（不少于 2 字）*</label><textarea rows="3" v-model="voidReason"></textarea></div>
      <p v-if="voidError" class="small" style="color: var(--bad)">{{ voidError }}</p>
      <div class="modal-actions">
        <button class="btn" @click="voidTarget = null">取消</button>
        <button class="btn danger" :disabled="saving" @click="submitVoid()">确认作废</button>
      </div>
    </Modal>

    <!-- 重开 -->
    <Modal v-if="reopenTarget" title="从历史版本重开草稿" @close="reopenTarget = null">
      <p class="small">将复制 v{{ reopenTarget.version_no }} 的段落另起一个新版本（链不断，旧版本原样保留），保存前你可以继续修改。</p>
      <div class="field"><label>重开说明</label><input v-model="reopenSummary" :placeholder="`基于 v${reopenTarget.version_no} 重开`" /></div>
      <div class="modal-actions">
        <button class="btn" @click="reopenTarget = null">取消</button>
        <button class="btn primary" :disabled="saving" @click="submitReopen()">重开并进入编辑</button>
      </div>
    </Modal>

    <!-- 差异 -->
    <Modal v-if="diffData" :title="`版本差异：v${diffData.from.version_no} → v${diffData.to.version_no}${diffData.masked ? '（脱敏视图）' : ''}`" @close="diffData = null">
      <div class="row small muted">新增 {{ diffData.summary.added }} · 修改 {{ diffData.summary.changed }} · 删除 {{ diffData.summary.removed }}</div>
      <div v-for="d in diffData.diff" :key="d.key" class="diff-row" :class="d.status">
        <span class="chip sm">{{ diffStatusLabel(d.status) }}</span>
        <div v-if="d.status === 'changed'" class="diff-texts">
          <p class="diff-from">{{ d.from.text }}</p>
          <p class="diff-to">{{ d.to.text }}</p>
        </div>
        <p v-else class="small">{{ (d.to || d.from).text }}</p>
      </div>
    </Modal>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { get, mutate, uploadRaw, downloadBytes, saveBlob } from '../api.js'
import { store } from '../store.js'
import { fmtDate, fmtDateTime, BASIS_TEXT } from '../utils.js'
import Modal from './Modal.vue'

const props = defineProps({
  caseId: { type: Number, required: true },
  docs: { type: Array, default: () => [] },
})

const TYPES = [
  { key: 'technical_disclosure', label: '技术交底书' },
  { key: 'claims', label: '权利要求草稿' },
  { key: 'specification', label: '说明书定稿' },
]

const firm = ['admin', 'agent', 'reviewer'].includes(store.user?.role)
const loading = ref(true)
const overview = ref([])
const activeType = ref('technical_disclosure')
const detail = ref(null)
const saving = ref(false)
const uploading = ref(false)

// 编辑器
const editing = ref(false)
const draftParas = ref([])
const editSummary = ref('')
const parentVersion = ref(null)
const saveError = ref('')
const mergingHint = ref('')

// 冲突
const conflict = ref(null)
const conflictChoices = ref({})
const customText = ref({})
const conflictError = ref('')

// 定稿
const finalizeOpen = ref(false)
const finForm = ref(blankFin())
const finPreview = ref(null)
const finalizeError = ref('')

// 作废 / 重开 / 差异
const voidTarget = ref(null)
const voidReason = ref('')
const voidError = ref('')
const reopenTarget = ref(null)
const reopenSummary = ref('')
const diffData = ref(null)

let pollTimer = null

const activeDef = computed(() => TYPES.find((t) => t.key === activeType.value))
const canEdit = computed(() => {
  if (!detail.value) return false
  if (detail.value.finalized) return false
  return firm || detail.value.client_editable
})
const canAddPara = computed(() => canEdit.value)
const parsingAttachment = computed(() => (detail.value?.attachments || []).find((a) => a.current?.parse_status === '解析中' || a.status === '解析中') || null)
const noDraftHint = computed(() => activeType.value === 'technical_disclosure'
  ? '代理人与客户可共同撰写交底；客户侧保存的内容与代理人共用同一条版本链。'
  : '由代理人基于交底内容起草，客户侧可查看脱敏版。')
const activeDocs = computed(() => props.docs.filter((d) => d.status !== '已撤回'))

function blankFin() {
  return {
    source_mode: 'manual', source_doc_id: null, dispatch_date: '', receive_date: '',
    anchor: 'receive', day_basis: 'legal', duration_days: 60,
    confirm_overdue: false, overdue_reason: '',
  }
}

function badge(key) {
  const d = overview.value.find((x) => x.dtype === key)
  if (!d || !d.exists) return ''
  if (d.status === '已定稿') return '定稿'
  return d.valid_count || ''
}

function roleLabel(r) {
  return { admin: '管理员', agent: '代理人', reviewer: '审核员', client_admin: '客户' }[r] || r
}
function tagLabel(t) {
  return { secret: '未公开技术细节', citation: '在先引用' }[t] || t
}
function hasTag(p, t) {
  return (p.tags || []).includes(t)
}
function toggleTag(p, t) {
  const tags = new Set(p.tags || [])
  if (tags.has(t)) tags.delete(t); else tags.add(t)
  p.tags = [...tags]
}

async function loadOverview() {
  const r = await get(`/cases/${props.caseId}/drafts`, { cacheKey: `drafts:${props.caseId}` })
  overview.value = r.data
  if (r.stale) store.showToast('撰稿概览为离线缓存，可能已过期', 'info')
}

async function loadDetail() {
  const r = await get(`/cases/${props.caseId}/drafts/${activeType.value}`, { cacheKey: `draft:${props.caseId}:${activeType.value}` })
  detail.value = r.data
  setupPoll()
}

async function switchType(key) {
  if (editing.value && !window.confirm('当前编辑尚未保存，切换文书将放弃修改，确定？')) return
  editing.value = false
  activeType.value = key
  detail.value = null
  loading.value = false
  await loadDetail()
}

function setupPoll() {
  clearInterval(pollTimer)
  const parsing = (detail.value?.attachments || []).some((a) => a.current?.parse_status === '解析中' || a.status === '解析中')
  if (parsing) {
    pollTimer = setInterval(async () => {
      const r = await get(`/cases/${props.caseId}/drafts/${activeType.value}`)
      const stillParsing = (r.data.attachments || []).some((a) => a.current?.parse_status === '解析中' || a.status === '解析中')
      detail.value = r.data
      if (!stillParsing) { clearInterval(pollTimer); store.showToast('附件解析完成，可以基于原件撰稿', 'success') }
    }, 2500)
  }
}

// ---------- 编辑 ----------
function startEditing(fromVersion = null) {
  const base = fromVersion || detail.value.current_version
  parentVersion.value = base
  draftParas.value = (base ? base.paras : []).map((p) => ({
    key: p.key || '',
    text: p.text,
    tags: firm ? p.tags || [] : [],
    // 客户侧：脱敏过的段落锁定，保存时服务端按原文恢复
    locked: !firm && Boolean(p.masked || p.masked_tag),
  }))
  editSummary.value = fromVersion ? `基于 v${fromVersion.version_no} 重开` : ''
  saveError.value = ''
  mergingHint.value = ''
  editing.value = true
}
function cancelEditing() {
  editing.value = false
  draftParas.value = []
}
function addPara() {
  draftParas.value.push({ key: '', text: '', tags: [], locked: false })
}
function removePara(i) {
  draftParas.value.splice(i, 1)
}

function buildPayload(paras, extra = {}) {
  return {
    paras: paras.filter((p) => p.text.trim()).map((p) => ({ key: p.key, text: p.text, tags: firm ? p.tags || [] : [] })),
    summary: editSummary.value,
    parent_id: parentVersion.value?.id || null,
    ...extra,
  }
}

async function saveDraft() {
  saveError.value = ''
  saving.value = true
  try {
    const body = buildPayload(draftParas.value)
    const r = await mutate('POST', `/cases/${props.caseId}/drafts/${activeType.value}/versions`, body, {
      offlineOp: { op: 'draft.save', payload: { case_id: props.caseId, dtype: activeType.value, body }, label: `保存《${activeDef.value.label}》新版本` },
    })
    if (r.queued) {
      store.showToast('当前离线：已加入待同步队列，联网后若有冲突会提示取舍', 'info')
      editing.value = false
      return
    }
    detail.value = r.data.draft
    editing.value = false
    conflict.value = null
    store.showToast(`已保存为 v${r.data.versionNo}${r.data.hadConflicts ? '（含冲突取舍）' : ''}`, 'success')
  } catch (e) {
    if (e.code === 'PARAGRAPH_CONFLICT') {
      conflict.value = e.details
      conflictChoices.value = {}
      customText.value = {}
      mergingHint.value = '检测到并发修改，已弹出逐段取舍'
    } else {
      saveError.value = e.message
    }
  } finally {
    saving.value = false
  }
}

function choice(key) { return conflictChoices.value[key] }
function setChoice(key, c) { conflictChoices.value[key] = c }
function paraIndex(key) {
  return draftParas.value.findIndex((p) => p.key === key)
}

async function resolveAndSave() {
  conflictError.value = ''
  const resolutions = []
  for (const cf of conflict.value.conflicts) {
    const c = conflictChoices.value[cf.key]
    if (!c) { conflictError.value = '还有冲突段落未选择取舍方式'; return }
    if (c === 'custom' && !(customText.value[cf.key] || '').trim()) { conflictError.value = '选择「折中自拟」时必须填写内容'; return }
    resolutions.push({ key: cf.key, choice: c, text: customText.value[cf.key] || '' })
  }
  const payload = buildPayload(draftParas.value)
  saving.value = true
  try {
    const r = await mutate('POST', `/cases/${props.caseId}/drafts/${activeType.value}/versions`, { ...payload, resolutions })
    if (r.queued) { store.showToast('离线队列暂不支持冲突取舍回放，请联网后处理', 'info'); return }
    detail.value = r.data.draft
    editing.value = false
    conflict.value = null
    store.showToast(`已按取舍合并为 v${r.data.versionNo}`, 'success')
  } catch (e) {
    if (e.code === 'PARAGRAPH_CONFLICT') { conflict.value = e.details; conflictError.value = '仍有未处理冲突，请再次取舍' }
    else conflictError.value = e.message
  } finally {
    saving.value = false
  }
}

// ---------- 作废 / 重开 ----------
function askVoid(v) {
  voidTarget.value = v
  voidReason.value = ''
  voidError.value = ''
}
async function submitVoid() {
  if (voidReason.value.trim().length < 2) { voidError.value = '作废原因不少于 2 字'; return }
  saving.value = true
  try {
    const r = await mutate('POST', `/cases/${props.caseId}/drafts/${activeType.value}/void`, {
      version_id: voidTarget.value.id, reason: voidReason.value.trim(),
    }, {
      offlineOp: { op: 'draft.void', payload: { case_id: props.caseId, dtype: activeType.value, body: { version_id: voidTarget.value.id, reason: voidReason.value.trim() } }, label: `作废 v${voidTarget.value.version_no}` },
    })
    if (!r.queued) { detail.value = r.data; store.showToast('版本已作废并留痕', 'success') }
    else store.showToast('已加入待同步队列', 'info')
    voidTarget.value = null
  } catch (e) { voidError.value = e.message } finally { saving.value = false }
}
function askReopen(v) {
  reopenTarget.value = v
  reopenSummary.value = `基于 v${v.version_no} 重开`
}
async function submitReopen() {
  saving.value = true
  try {
    const r = await mutate('POST', `/cases/${props.caseId}/drafts/${activeType.value}/reopen`, {
      from_version_id: reopenTarget.value.id, summary: reopenSummary.value,
    }, {
      offlineOp: { op: 'draft.reopen', payload: { case_id: props.caseId, dtype: activeType.value, body: { from_version_id: reopenTarget.value.id, summary: reopenSummary.value } }, label: '重开草稿' },
    })
    if (r.queued) { store.showToast('已加入待同步队列', 'info'); reopenTarget.value = null; return }
    detail.value = r.data
    const nv = detail.value.versions.find((x) => x.id === detail.value.current_version.id)
    reopenTarget.value = null
    if (canEdit.value) startEditing(nv)
  } catch (e) { store.showToast(e.message, 'error') } finally { saving.value = false }
}

// ---------- 差异 ----------
async function openDiff(v) {
  const vers = detail.value.versions
  const idx = vers.findIndex((x) => x.id === v.id)
  if (idx <= 0) { store.showToast('v1 没有更早版本可对比，显示其全部段落为新增', 'info') }
  const from = idx > 0 ? vers[idx - 1] : { id: v.id }
  if (idx === 0) {
    diffData.value = {
      from: { id: v.id, version_no: v.version_no }, to: { id: v.id, version_no: v.version_no },
      masked: v.masked, summary: { added: v.paras.length, changed: 0, removed: 0 },
      diff: v.paras.map((p) => ({ key: p.key, status: 'added', from: null, to: p })),
    }
    return
  }
  try {
    const r = await get(`/cases/${props.caseId}/drafts/${activeType.value}/diff?from=${from.id}&to=${v.id}`)
    diffData.value = r.data
  } catch (e) { store.showToast(e.message, 'error') }
}
function diffStatusLabel(s) { return { same: '未变', changed: '修改', added: '新增', removed: '删除' }[s] }

// ---------- 定稿 ----------
function openFinalize() {
  finForm.value = blankFin()
  if (activeDocs.value.length) {
    finForm.value.source_mode = 'doc'
    finForm.value.source_doc_id = activeDocs.value[0].id
  }
  finPreview.value = null
  finalizeError.value = ''
  finalizeOpen.value = true
  schedulePreview()
}
let previewDebounce = null
function schedulePreview() {
  clearTimeout(previewDebounce)
  previewDebounce = setTimeout(runPreview, 350)
}
async function runPreview() {
  if (!finalizeOpen.value) return
  const f = finForm.value
  try {
    const body = {
      anchor: f.anchor, day_basis: f.day_basis, duration_days: f.duration_days,
    }
    if (f.source_mode === 'doc') body.source_doc_id = f.source_doc_id
    else { body.dispatch_date = f.dispatch_date || null; body.receive_date = f.receive_date || null }
    const resp = await fetch(`/api/cases/${props.caseId}/drafts/${activeType.value}/finalize-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${store.token}` },
      body: JSON.stringify(body),
    }).then((x) => x.json())
    if (resp.error) finPreview.value = null
    else finPreview.value = resp.data
  } catch { finPreview.value = null }
}
async function submitFinalize() {
  finalizeError.value = ''
  const f = finForm.value
  const body = {
    anchor: f.anchor, day_basis: f.day_basis, duration_days: f.duration_days,
    confirm_overdue: f.confirm_overdue, overdue_reason: f.overdue_reason,
  }
  if (f.source_mode === 'doc') body.source_doc_id = f.source_doc_id
  else { body.dispatch_date = f.dispatch_date || null; body.receive_date = f.receive_date || null }
  saving.value = true
  try {
    const r = await mutate('POST', `/cases/${props.caseId}/drafts/${activeType.value}/finalize`, body)
    detail.value = r.data.draft
    finalizeOpen.value = false
    store.showToast('已定稿，提交期限已按官文口径登记', 'success')
  } catch (e) { finalizeError.value = e.message } finally { saving.value = false }
}

// ---------- 附件 ----------
async function onFile(ev) {
  const file = ev.target.files?.[0]
  ev.target.value = ''
  if (!file) return
  if (!store.online) { store.showToast('离线状态不能上传附件原件，请联网后再传', 'error'); return }
  uploading.value = true
  try {
    const r = await uploadRaw(`/cases/${props.caseId}/drafts/${activeType.value}/attachments`, file)
    detail.value = r.data
    setupPoll()
    store.showToast('原件已存入对象存储，正在后台解析', 'success')
  } catch (e) { store.showToast(e.message, 'error') } finally { uploading.value = false }
}
async function downloadCurrent(id) {
  try {
    const { blob, name } = await downloadBytes(`/attachments/${id}/download`)
    saveBlob(blob, name)
  } catch (e) { store.showToast(e.message, 'error') }
}
async function downloadVersion(v) {
  try {
    const { blob, name } = await downloadBytes(`/draft-versions/${v.id}/download`)
    saveBlob(blob, `v${v.version_no}-${name}`)
  } catch (e) { store.showToast(e.message, 'error') }
}

function formatBytes(n) {
  if (!n && n !== 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
function parseChip(s) { return s === '就绪' ? 'ok' : s === '解析失败' ? 'bad' : 'warn' }
function deadlineChip(d) {
  if (d.status === '已完成') return 'ok'
  if (d.days_left === null) return ''
  return d.days_left < 0 ? 'bad' : d.days_left <= 7 ? 'warn' : 'ok'
}
function deadlineText(d) {
  if (d.status === '已完成') return '已完成'
  if (d.days_left === null) return '—'
  return d.days_left < 0 ? `逾期${-d.days_left}天` : d.days_left === 0 ? '今天到期' : `剩 ${d.days_left} 天`
}

// 定稿表单变化即刷新预览
watch(finForm, () => { if (finalizeOpen.value) schedulePreview() }, { deep: true })

onMounted(async () => {
  try {
    await loadOverview()
    await loadDetail()
  } catch (e) {
    store.showToast(e.message, 'error')
  } finally { loading.value = false }
  window.addEventListener('pc:synced', loadDetail)
})
onUnmounted(() => {
  clearInterval(pollTimer)
  clearTimeout(previewDebounce)
  window.removeEventListener('pc:synced', loadDetail)
})
</script>
