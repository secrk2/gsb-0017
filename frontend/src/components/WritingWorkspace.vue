<template>
  <div class="card mt16 writing-workspace">
    <!-- 头部状态条 -->
    <div class="spread">
      <div>
        <div class="row">
          <h3 style="margin: 0">{{ kindDef.label }}</h3>
          <span class="chip" :class="statusChip">{{ doc.status }}</span>
          <span v-if="doc.head" class="chip blue">当前 v{{ doc.current_version }}</span>
          <span v-if="branchedHint" class="chip purple">基于 v{{ branchedHint }} 重开编辑</span>
        </div>
        <div class="small muted mt8">
          <template v-if="doc.finalized_at">定稿：{{ fmtDateTime(doc.finalized_at) }} · </template>
          最近更新 {{ fmtDateTime(doc.updated_at) }}
        </div>
      </div>
      <div class="row">
        <button v-if="isFirm" class="btn sm" @click="toggleMaskPreview">{{ maskPreview ? '切回原文视图' : '预览客户脱敏版' }}</button>
        <button class="btn sm" @click="showDiff = true">版本差异</button>
        <button v-if="canWrite && doc.status !== '已作废'" class="btn sm danger" @click="openVoid">作废此稿…</button>
      </div>
    </div>

    <!-- 待取舍冲突横幅：不锁定、可继续看全文，必须逐段取舍后才生成合并版本 -->
    <div v-if="doc.conflicts.length" class="conflict-banner mt16">
      <div class="row spread">
        <strong>⚠️ {{ doc.conflicts.length }} 处段落级冲突待取舍（你与他人基于同一版本改了同一段）</strong>
        <button class="btn sm primary" @click="openExistingConflicts">逐段取舍…</button>
      </div>
      <p class="small" style="margin: 6px 0 0">双方修改都已保留、无人被覆盖，也不会锁定文档；取舍完成后生成「冲突合并」版本。</p>
    </div>

    <div v-if="isFirm && maskPreview" class="mask-note mt8">
      正在以客户视角预览（按各版本保存时的脱敏规则快照渲染，规则更新不影响历史版本）；此视图只读，切回原文后可编辑。
    </div>

    <!-- 正文编辑 / 只读 -->
    <div class="writer-grid mt16">
      <div class="writer-main">
        <div v-for="sec in viewSections" :key="sec.key" class="wsection">
          <div class="wsection-head">
            <h4>{{ sec.title }}</h4>
            <span v-if="sec.hidden" class="chip warn">客户侧整章隐藏（在先引用/未公开）</span>
          </div>

          <!-- 客户侧隐藏章节：不展示任何原文 -->
          <div v-if="sec.hidden" class="hidden-section">
            {{ sec.placeholder || '本章按脱敏规则对客户不可见，代理所见原文。' }}
          </div>

          <template v-else>
            <div v-for="(p, idx) in sec.paragraphs" :key="p.id" class="para-row">
              <textarea
                v-model="p.text"
                rows="3"
                :readonly="readonly || p.masked"
                :class="{ maskedPara: p.masked }"
                :placeholder="`段落 ${idx + 1}`"
              ></textarea>
              <div class="para-ops">
                <span v-if="p.masked" class="chip warn" title="该段为未公开技术细节，客户侧不可见，原文以代理所存档为准">敏感段已隐藏</span>
                <label v-if="isFirm && canWrite && !readonly" class="row small" style="gap: 4px">
                  <input type="checkbox" v-model="p.sensitive" style="width: auto" /> 客户侧整段隐藏
                </label>
                <button v-if="canWrite && !readonly && !p.masked" class="link-btn danger" @click="removePara(sec, idx)">删段</button>
              </div>
            </div>
            <button v-if="canWrite && !readonly" class="btn sm ghost" @click="addPara(sec)">＋ 增加段落</button>
          </template>
        </div>

        <!-- 保存条 -->
        <div v-if="canWrite && !readonly" class="save-bar">
          <div class="small muted">
            编辑基线：<strong>v{{ baseVersionNo }}</strong>
            <span v-if="baseVersionNo !== doc.current_version">（链头已到 v{{ doc.current_version }}，保存时将自动合并；同段双改会进入取舍）</span>
          </div>
          <div class="row">
            <input v-model="saveSummary" class="summary-input" placeholder="本次保存说明（可留空）" />
            <button class="btn" :disabled="saving" @click="doSave(false)">保存草稿（新版本）</button>
            <button v-if="isFirm" class="btn primary" :disabled="saving" @click="openFinalize">提交定稿…</button>
          </div>
          <p v-if="saveError" class="small" style="color: var(--bad); margin: 6px 0 0">{{ saveError }}</p>
        </div>
        <div v-else-if="!doc.head" class="inline-empty">
          <div class="ie-icon">✍️</div>
          <p class="ie-title">文档链已建，还没有任何正文版本</p>
          <p class="small muted">填写上方章节后保存即生成第 1 版；原件附件可在下方先上传（解析不阻塞起草）。</p>
        </div>
      </div>

      <!-- 版本链侧栏 -->
      <aside class="version-aside">
        <h4>版本链</h4>
        <ul class="ver-chain">
          <li v-for="v in [...doc.versions].reverse()" :key="v.id" :class="{ head: v.id === doc.head_version_id, final: v.id === doc.final_version_id }">
            <div class="spread">
              <button class="link-btn" @click="viewVer(v)"><strong>v{{ v.version_no }}</strong></button>
              <span class="chip" :class="saveChip(v.save_type)">{{ v.save_type }}</span>
            </div>
            <div class="small muted">{{ v.actor_name }} · {{ fmtDateTime(v.created_at) }}</div>
            <p class="small" style="margin: 4px 0">{{ v.summary }}</p>
            <div v-if="v.branch_from_version_id" class="small" style="color: var(--purple)">↳ 自历史版本重开的分支</div>
            <div class="row mt8">
              <button class="btn sm" @click="viewVer(v)">查看</button>
              <button v-if="canWrite && !readonly" class="btn sm" @click="editFrom(v)">回到此版重开</button>
            </div>
          </li>
        </ul>

        <!-- 附件原件 -->
        <div class="attach-box">
          <div class="spread">
            <h4 style="margin: 0">附件原件（对象存储）</h4>
            <button v-if="canWrite" class="btn sm" @click="pickNewFile">＋ 上传原件</button>
          </div>
          <p class="small muted">原件不入库；每次换版生成不可变新版本，旧版本永久可下载。</p>
          <input ref="fileInput" type="file" style="display: none" @change="onFilePicked" />
          <ul v-if="doc.attachments.length" class="att-list">
            <li v-for="a in doc.attachments" :key="a.id">
              <div class="spread">
                <strong>{{ a.filename }}</strong>
                <span class="chip blue">v{{ a.current_version }}</span>
              </div>
              <ul class="att-ver-list">
                <li v-for="av in a.versions" :key="av.id">
                  <div class="spread small">
                    <span>v{{ av.version_no }} · {{ humanSize(av.size_bytes) }} · {{ av.uploaded_by_name }}</span>
                    <span class="chip" :class="av.status === '已完成' ? 'ok' : av.status === '解析失败' ? 'bad' : 'warn'">{{ av.status }}</span>
                  </div>
                  <div class="small muted">{{ fmtDateTime(av.created_at) }}<span v-if="av.parse_note"> · {{ av.parse_note }}</span></div>
                  <div class="row mt8">
                    <button class="btn sm" :disabled="!av.size_bytes" @click="downloadVer(a.id, av.version_no)">下载此版原件</button>
                    <template v-if="isFirm && canWrite && av.status === '解析中'">
                      <button class="btn sm" @click="markParsed(av.id, '已完成')">标记解析完成</button>
                      <button class="btn sm danger" @click="markParsed(av.id, '解析失败')">解析失败</button>
                    </template>
                  </div>
                </li>
              </ul>
              <button v-if="canWrite" class="btn sm mt8" @click="pickReplaceFile(a)">换版（保留旧版）…</button>
            </li>
          </ul>
          <div v-else class="small muted">暂无附件。定稿说明书通常需挂签字扫描件原件。</div>
        </div>
      </aside>
    </div>

    <!-- ============ 弹窗：版本查看 ============ -->
    <Modal v-if="versionView" :title="`第 ${versionView.version_no} 版 · ${versionView.save_type}`" @close="versionView = null">
      <div class="small muted mb8">{{ versionView.actor_name }}（{{ roleName(versionView.actor_role) }}）· {{ fmtDateTime(versionView.created_at) }} · {{ versionView.summary }}</div>
      <div v-if="versionView.masked" class="mask-note mb8">客户脱敏视图（按该版保存时规则 v{{ versionView.mask_rule_version }} 快照渲染，历史内容不随后续规则变化）</div>
      <div v-for="sec in versionView.content.sections" :key="sec.key" class="vsec">
        <h4>{{ sec.title }}</h4>
        <div v-if="sec.hidden" class="hidden-section">{{ sec.placeholder }}</div>
        <p v-for="p in sec.paragraphs" :key="p.id" class="vpara" :class="{ maskedPara: p.masked }">{{ p.text }}</p>
        <p v-if="!sec.hidden && !sec.paragraphs.length" class="small muted">（空）</p>
      </div>
      <div class="modal-actions">
        <button class="btn" @click="versionView = null">关闭</button>
        <button v-if="canWrite" class="btn primary" @click="editFrom(versionView); versionView = null">回到此版重开</button>
      </div>
    </Modal>

    <!-- ============ 弹窗：版本差异 ============ -->
    <Modal v-if="showDiff" title="版本前后差异" @close="showDiff = false">
      <div class="row mb8">
        <select v-model.number="diffFrom">
          <option :value="null">空文档（首版前）</option>
          <option v-for="v in doc.versions" :key="v.id" :value="v.id">v{{ v.version_no }}（{{ v.save_type }}）</option>
        </select>
        <span class="muted">→</span>
        <select v-model.number="diffTo">
          <option v-for="v in doc.versions" :key="v.id" :value="v.id">v{{ v.version_no }}（{{ v.save_type }}）</option>
        </select>
        <button class="btn sm" @click="loadDiff">对比</button>
      </div>
      <div v-if="diffData" style="max-height: 56vh; overflow: auto">
        <p class="small muted">共 {{ diffData.changed }} 处变化{{ diffData.masked ? '（脱敏视图）' : '' }}；{{ diffData.from_version ? `v${diffData.from_version.version_no}` : '空' }} → v{{ diffData.to_version.version_no }}</p>
        <div v-for="sec in diffData.sections" :key="sec.key" class="diff-sec">
          <h4 v-if="sec.changed || sec.key === diffFocus">{{ sec.title }}</h4>
          <template v-for="(it, i) in sec.items.filter((x) => x.change !== 'equal')" :key="i">
            <div class="diff-item" :class="it.change">
              <span class="chip" :class="diffChip(it.change)">{{ diffText(it.change) }}</span>
              <div class="diff-body">
                <div v-if="it.change !== 'added'" class="old small">{{ it.base_text || '（空）' }}</div>
                <div v-if="it.change !== 'removed'" class="new">{{ it.target_text || '（空）' }}</div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </Modal>

    <!-- ============ 弹窗：定稿 + 期限口径 ============ -->
    <Modal v-if="finalizeOpen" title="提交定稿并设定定稿提交期限" @close="finalizeOpen = false">
      <p class="small muted">定稿后该链锁定为「已定稿」；期限口径与官文期限完全一致，界面明示以何日起算、按何种天数计。</p>
      <div class="field">
        <label>定稿说明</label>
        <input v-model="saveSummary" placeholder="如：经客户确认的申请文本定稿" />
      </div>
      <div class="field"><label>期限事项</label><input v-model="dl.dtype" placeholder="定稿提交（默认）" /></div>
      <div class="grid" style="grid-template-columns: 1fr 1fr">
        <div class="field"><label>发文日</label><input v-model="dl.dispatch_date" type="date" @change="schedulePreview" /></div>
        <div class="field"><label>收到日（实际签收）</label><input v-model="dl.receive_date" type="date" @change="schedulePreview" /></div>
      </div>
      <div class="field">
        <label>截止日以谁为准（起算口径）*</label>
        <div class="seg">
          <button type="button" :class="dl.anchor === 'dispatch' ? 'on' : ''" @click="dl.anchor = 'dispatch'; schedulePreview()">自发文日</button>
          <button type="button" :class="dl.anchor === 'receive' ? 'on' : ''" @click="dl.anchor = 'receive'; schedulePreview()">自收到日</button>
        </div>
        <p class="small muted mt8" style="margin-bottom: 0">起算日：{{ dlPreview?.start_kind || '—' }} {{ dlPreview?.start_date || '' }}；无实际收到日时按发文日+15 日推定。</p>
      </div>
      <div class="grid" style="grid-template-columns: 1fr 96px">
        <div class="field">
          <label>天数口径 *</label>
          <select v-model="dl.day_basis" @change="schedulePreview()">
            <option value="natural">自然日（不顺延）</option>
            <option value="workday">工作日（跳周末/法定节假日，调休计入）</option>
            <option value="legal">法定节假日顺延</option>
          </select>
        </div>
        <div class="field"><label>天数 *</label><input v-model.number="dl.duration_days" type="number" min="1" @input="schedulePreview" /></div>
      </div>
      <div v-if="dlPreview" class="preview-box" :class="dlPreview.overdue ? 'overdue' : ''">
        <div class="spread"><strong>截止日 {{ dlPreview.due_date }}</strong><span class="chip" :class="dlPreview.overdue ? 'bad' : 'ok'">{{ dlPreview.overdue ? `已逾期 ${-dlPreview.days_left} 天` : `剩 ${dlPreview.days_left} 天` }}</span></div>
        <div class="small muted mt8">
          以「{{ dlPreview.start_kind }}」起算 · {{ basisText }} · 第 1 日为起算日次日
          <span v-if="dl.day_basis === 'legal'">{{ dlPreview.rolled ? ' · 已触发节假日顺延' : ' · 未触发顺延' }}</span>
        </div>
        <div class="small muted">代理所今日（{{ dlPreview.firm_tz }}）：{{ dlPreview.server_today }}，剩余天数以此为准</div>
      </div>
      <p v-if="dlError" class="small" style="color: var(--bad)">{{ dlError }}</p>
      <div v-if="dlPreview?.overdue" class="overdue-confirm">
        <label class="row small" style="gap: 6px"><input type="checkbox" v-model="confirmOverdue" style="width: auto" /> 我已知悉截止日落点逾期，确认提交定稿</label>
        <div class="field mt8" style="margin-bottom: 0"><label>超期原因（不少于 2 字，留痕）*</label><textarea v-model="overdueReason" rows="2"></textarea></div>
      </div>
      <div class="modal-actions">
        <button class="btn" @click="finalizeOpen = false">取消</button>
        <button class="btn primary" :disabled="saving" @click="submitFinal">确认定稿并生成期限</button>
      </div>
    </Modal>

    <!-- ============ 弹窗：段落级冲突取舍 ============ -->
    <Modal v-if="conflict" title="段落级冲突取舍" wide @close="conflict = null">
      <p class="small muted">
        你基于 <strong>v{{ conflict.base_version.version_no }}</strong> 修改，但链头已到
        <strong>v{{ conflict.head_version.version_no }}</strong>（{{ conflict.head_version.actor_name }} 已保存）。
        以下段落双方都改了——对方内容不会被覆盖，请逐段取舍后生成合并版本。
        {{ conflict.masked ? '（客户视图：文本按脱敏快照呈现，占位符在合并时自动回填真实内容）' : '' }}
      </p>
      <div v-for="(cf, i) in conflict.conflicts" :key="cf.id || i" class="cf-block">
        <div class="cf-title">
          <strong>{{ sectionTitle(cf.section_key) }}</strong>
          <span v-if="cf.incoming_deleted" class="chip bad">对方删除了该段</span>
          <span v-if="cf.pending_deleted" class="chip bad">你删除了该段</span>
        </div>
        <div class="cf-cols">
          <div class="cf-col"><div class="small muted">共同基线 v{{ conflict.base_version.version_no }}</div><p class="cf-text">{{ cf.base_text || '（新增段，无基线）' }}</p></div>
          <div class="cf-col"><div class="small muted">对方（{{ cf.incoming_actor_name }}，先来已保存）</div><p class="cf-text">{{ cf.incoming_deleted ? '（已删除）' : cf.incoming_text }}</p></div>
          <div class="cf-col"><div class="small muted">我的（{{ cf.pending_actor_name }}，本次）</div><p class="cf-text">{{ cf.pending_deleted ? '（已删除）' : cf.pending_text }}</p></div>
        </div>
        <div class="cf-actions">
          <label class="row small"><input type="radio" :name="'cf' + i" value="incoming" v-model="choices[i].choice" /> 采用对方</label>
          <label class="row small"><input type="radio" :name="'cf' + i" value="pending" v-model="choices[i].choice" /> 保留我的</label>
          <label class="row small"><input type="radio" :name="'cf' + i" value="merged" v-model="choices[i].choice" /> 合并为：</label>
          <textarea v-if="choices[i].choice === 'merged'" rows="2" v-model="choices[i].text"></textarea>
        </div>
      </div>
      <p v-if="resolveError" class="small" style="color: var(--bad)">{{ resolveError }}</p>
      <div class="modal-actions">
        <button class="btn" @click="conflict = null">取消（稍后取舍，双方内容均保留）</button>
        <button class="btn primary" :disabled="solving" @click="submitResolve">生成冲突合并版本</button>
      </div>
    </Modal>

    <!-- ============ 弹窗：作废 ============ -->
    <Modal v-if="voidOpen" title="作废此稿（留痕）" @close="voidOpen = false">
      <p class="small">作废后该链不再接受保存，所有版本保留；可从任一版本重开新链。</p>
      <div class="field"><label>作废原因（不少于 2 字）*</label><textarea v-model="voidReason" rows="3"></textarea></div>
      <p v-if="voidError" class="small" style="color: var(--bad)">{{ voidError }}</p>
      <div class="modal-actions">
        <button class="btn" @click="voidOpen = false">取消</button>
        <button class="btn danger" :disabled="saving" @click="submitVoid">确认作废</button>
      </div>
    </Modal>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { get, mutate, uploadBinary, downloadBinary, ApiError } from '../api.js'
import { store, roleName } from '../store.js'
import { fmtDateTime, ANCHOR_TEXT, BASIS_TEXT } from '../utils.js'
import Modal from './Modal.vue'

const props = defineProps({
  doc: { type: Object, required: true },
  kindDef: { type: Object, required: true },
  isFirm: { type: Boolean, required: true },
  serverToday: { type: String, default: '' },
})
const emit = defineEmits(['reload', 'changed'])

const saving = ref(false)
const saveError = ref('')
const saveSummary = ref('')
const draft = ref(null)
const baseVersionId = ref(null)
const maskPreview = ref(false)
const branchedHint = ref(null)

const versionView = ref(null)
const showDiff = ref(false)
const diffFrom = ref(null)
const diffTo = ref(null)
const diffData = ref(null)
const diffFocus = ref('')

const finalizeOpen = ref(false)
const dl = reactive({ dtype: '定稿提交', anchor: 'dispatch', dispatch_date: '', receive_date: '', day_basis: 'natural', duration_days: 30 })
const dlPreview = ref(null)
const dlError = ref('')
const confirmOverdue = ref(false)
const overdueReason = ref('')

const conflict = ref(null)
const choices = ref([])
const solving = ref(false)
const resolveError = ref('')

const voidOpen = ref(false)
const voidReason = ref('')
const voidError = ref('')

const fileInput = ref(null)
const replaceTarget = ref(null)

const canWrite = computed(() => props.doc.can_write && props.doc.status !== '已定稿')
// 待取舍冲突未处理完前正文只读：不是「锁定拒人」，而是所有改动经取舍弹窗逐段合并，
// 取舍完成立即恢复编辑；脱敏预览同样只读。
const editable = computed(() => canWrite.value && props.doc.conflicts.length === 0)
const readonly = computed(() => !editable.value || maskPreview.value)
const statusChip = computed(() => ({ 草稿中: 'warn', 已定稿: 'ok', 已作废: 'bad' })[props.doc.status] || '')
function saveChip(t) { return ({ 草稿: 'warn', 定稿: 'ok', 作废: 'bad', 冲突合并: 'purple' })[t] || '' }
const baseVersionNo = computed(() => docVersionNo(baseVersionId.value))

function docVersionNo(id) {
  return props.doc.versions.find((v) => v.id === id)?.version_no ?? (props.doc.head ? props.doc.current_version : 0)
}

// 编辑器内容来源：脱敏预览用临时拉取的客户视角文档；可写时用本地草稿；否则只读链头。
const maskedDoc = ref(null)
const viewSections = computed(() => {
  if (maskPreview.value && maskedDoc.value?.head) return maskedDoc.value.head.content.sections
  if (draft.value) return draft.value.sections
  if (props.doc.head) return props.doc.head.content.sections
  return props.kindDef.sections.map((s) => ({ key: s.key, title: s.title, paragraphs: [], hidden: false }))
})

function cloneHeadForEdit() {
  const src = props.doc.head?.content?.sections || props.kindDef.sections.map((s) => ({ key: s.key, title: s.title, paragraphs: [] }))
  draft.value = {
    sections: src.map((s) => ({
      key: s.key,
      title: s.title,
      hidden: Boolean(s.hidden),
      placeholder: s.placeholder || '',
      paragraphs: (s.paragraphs || []).map((p) => ({ id: p.id, text: p.text, sensitive: Boolean(p.sensitive), masked: Boolean(p.masked) })),
    })),
  }
}

watch(
  () => [props.doc.id, props.doc.current_version, props.doc.conflicts.length],
  () => {
    conflict.value = null
    maskPreview.value = false
    maskedDoc.value = null
    baseVersionId.value = props.doc.head_version_id
    branchedHint.value = null
    // 可写且非定稿：复制链头到本地草稿（客户侧拿到脱敏章节，遮蔽段只读）；零版本链则建空白章节草稿
    if (props.doc.can_write && props.doc.status !== '已定稿' && !props.doc.conflicts.length) cloneHeadForEdit()
    else draft.value = null
  },
  { immediate: true }
)

function addPara(sec) {
  sec.paragraphs.push({ id: null, text: '', sensitive: false })
}
function removePara(sec, idx) {
  sec.paragraphs.splice(idx, 1)
}

function payloadContent() {
  // 客户侧只读的遮蔽段（p.masked）必须原样回传占位文本，服务端按段落 id 对账回填原文；
  // 整章隐藏（s.hidden）不发送，服务端从链头补回。
  return {
    sections: viewSections.value
      .filter((s) => !s.hidden)
      .map((s) => ({ key: s.key, paragraphs: s.paragraphs.map((p) => ({ id: p.id, text: p.text, sensitive: p.sensitive })) })),
  }
}

async function doSave(finalize) {
  saveError.value = ''
  if (finalize) { openFinalize(); return }
  if (!baseVersionId.value && props.doc.head) {
    saveError.value = '缺少编辑基线索引，请刷新后重试。'
    return
  }
  saving.value = true
  try {
    const r = await mutate('POST', `/cases/${props.doc.case_id}/writing/${props.doc.doc_kind}/save`, {
      base_version_id: baseVersionId.value,
      content: payloadContent(),
      summary: saveSummary.value,
    })
    store.showToast(`已保存第 ${r.data.version_no} 版`, 'success')
    draft.value = null
    saveSummary.value = ''
    branchedHint.value = r.data.branched ? docVersionNo(baseVersionId.value) : null
    emit('reload')
    emit('changed')
  } catch (e) {
    if (e.code === 'PARAGRAPH_CONFLICT') openConflict(e.details)
    else saveError.value = e.message
  } finally {
    saving.value = false
  }
}

function openFinalize() {
  if (!viewSections.value.some((s) => s.paragraphs.some((p) => p.text.trim()))) {
    saveError.value = '定稿前至少要有一个非空段落。'
    return
  }
  Object.assign(dl, { dtype: '定稿提交', dispatch_date: '', receive_date: '', anchor: 'dispatch', day_basis: 'natural', duration_days: 30 })
  dlPreview.value = null
  dlError.value = ''
  confirmOverdue.value = false
  overdueReason.value = ''
  finalizeOpen.value = true
}

let previewTimer = null
function schedulePreview() {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(runPreview, 250)
}
async function runPreview() {
  dlError.value = ''
  dlPreview.value = null
  if (!dl.dispatch_date && !dl.receive_date) return
  try {
    const r = await mutate('POST', `/cases/${props.doc.case_id}/writing/${props.doc.doc_kind}/final-deadline-preview`, { deadline: { ...dl } })
    dlPreview.value = r.data
  } catch (e) {
    dlError.value = e.message
  }
}
const basisText = computed(() => BASIS_TEXT[dl.day_basis] || '')

// 定稿保存（从弹窗按钮触发）
async function submitFinal() {
  saveError.value = ''
  if (!dlPreview.value) { dlError.value = '请先让截止日预览成功（填写发文日/收到日与天数）。'; return }
  if (dlPreview.value.overdue && (!confirmOverdue.value || overdueReason.value.trim().length < 2)) {
    dlError.value = '落点逾期：必须勾选确认并填写不少于 2 字的超期原因。'
    return
  }
  saving.value = true
  try {
    const r = await mutate('POST', `/cases/${props.doc.case_id}/writing/${props.doc.doc_kind}/save`, {
      base_version_id: baseVersionId.value,
      content: payloadContent(),
      summary: saveSummary.value || '提交定稿',
      finalize: true,
      confirm_overdue: confirmOverdue.value,
      overdue_reason: overdueReason.value.trim(),
      deadline: { ...dl },
    })
    store.showToast(`已定稿（v${r.data.version_no}），定稿提交期限已生成`, 'success')
    finalizeOpen.value = false
    draft.value = null
    emit('reload')
    emit('changed')
  } catch (e) {
    if (e.code === 'PARAGRAPH_CONFLICT') { finalizeOpen.value = false; openConflict(e.details) }
    else dlError.value = e.message
  } finally {
    saving.value = false
  }
}

// ---- 冲突取舍 ----
function openConflict(details) {
  conflict.value = details
  choices.value = details.conflicts.map((cf) => ({
    choice: cf.incoming_deleted ? 'pending' : 'merged',
    text: cf.pending_text || cf.incoming_text || '',
  }))
  resolveError.value = ''
  store.showToast('检测到同段双改：请逐段取舍，不会覆盖任何一方', 'info')
}

function openExistingConflicts() {
  const d = props.doc
  conflict.value = {
    base_version: { id: d.conflicts[0].base_version_id, version_no: docVersionNo(d.conflicts[0].base_version_id) },
    head_version: { id: d.head_version_id, version_no: d.current_version, actor_name: d.conflicts[0].incoming_actor_name },
    conflicts: d.conflicts,
    masked: !props.isFirm,
  }
  choices.value = d.conflicts.map((cf) => ({ choice: 'merged', text: cf.pending_text || cf.incoming_text || '' }))
  // 刷新页面后仍可取舍：后来者的完整提交（客户侧为脱敏形态）存在待取舍记录里
  conflict.value.pending_content = d.conflicts[0]?.pending_content || null
  resolveError.value = ''
}

function sectionTitle(key) {
  return props.kindDef.sections.find((s) => s.key === key)?.title || key
}

async function submitResolve() {
  resolveError.value = ''
  const resolutions = conflict.value.conflicts.map((cf, i) => ({
    conflict_id: cf.id,
    choice: choices.value[i].choice,
    text: choices.value[i].text,
  }))
  if (resolutions.some((r) => !r.choice || (r.choice === 'merged' && !String(r.text || '').trim()))) {
    resolveError.value = '每段都必须给出取舍；选择「合并」时要填写合并文本。'
    return
  }
  solving.value = true
  try {
    // 待取舍全文来自 409 详情（同次会话）或文档详情里的 pending_content（刷新后），
    // 客户侧为脱敏形态（占位符），服务端对账回填；所内侧为原文。
    await mutate('POST', `/writing/docs/${props.doc.id}/conflicts/resolve`, {
      pending_content: conflict.value.pending_content,
      resolutions,
    })
    store.showToast('冲突已取舍，合并版本已生成', 'success')
    conflict.value = null
    draft.value = null
    emit('reload')
    emit('changed')
  } catch (e) {
    if (e.code === 'PARAGRAPH_CONFLICT') openConflict(e.details)
    else resolveError.value = e.message
  } finally {
    solving.value = false
  }
}

// ---- 版本操作 ----
async function viewVer(v) {
  try {
    const r = await get(`/writing/versions/${v.id}`)
    versionView.value = r.data.version
  } catch (e) {
    store.showToast(e.message, 'error')
  }
}

function editFrom(v) {
  // 回到任一历史版本重开：把该版全文装入编辑器，基线指向该版；保存时三路合并/冲突照常生效
  // 客户拿到的是脱敏形态：隐藏章带 hidden（不发送，服务端按基线补回），遮蔽段只读回传占位
  const src = v.id === props.doc.head_version_id ? Promise.resolve({ data: { version: props.doc.head } }) : get(`/writing/versions/${v.id}`)
  src.then((r) => {
    const ver = r.data.version
    draft.value = {
      sections: ver.content.sections.map((s) => ({
        key: s.key,
        title: s.title,
        hidden: Boolean(s.hidden),
        placeholder: s.placeholder || '',
        paragraphs: (s.paragraphs || []).map((p) => ({ id: p.id, text: p.text, sensitive: false, masked: Boolean(p.masked) })),
      })),
    }
    baseVersionId.value = v.id
    branchedHint.value = v.id === props.doc.head_version_id ? null : v.version_no
    versionView.value = null
    store.showToast(`已载入 v${v.version_no} 作为编辑基线，保存即从该版本重开`, 'info')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }).catch((e) => store.showToast(e.message, 'error'))
}

// ---- 差异 ----
watch(showDiff, (open) => {
  if (open && props.doc.versions.length) {
    const last = props.doc.versions[props.doc.versions.length - 1]
    const prev = props.doc.versions[props.doc.versions.length - 2]
    diffTo.value = last.id
    diffFrom.value = prev?.id ?? null
    loadDiff()
  }
})
async function loadDiff() {
  if (!diffTo.value) return
  const qs = `?to=${diffTo.value}${diffFrom.value ? `&from=${diffFrom.value}` : ''}`
  const r = await get(`/writing/docs/${props.doc.id}/diff${qs}`)
  diffData.value = r.data
}
function diffText(c) { return ({ added: '新增', removed: '删除', modified: '修改' })[c] }
function diffChip(c) { return ({ added: 'ok', removed: 'bad', modified: 'warn' })[c] }

// ---- 作废 ----
function openVoid() { voidReason.value = ''; voidError.value = ''; voidOpen.value = true }
async function submitVoid() {
  if (voidReason.value.trim().length < 2) { voidError.value = '作废原因不少于 2 个字'; return }
  saving.value = true
  try {
    await mutate('POST', `/writing/docs/${props.doc.id}/void`, { reason: voidReason.value.trim() })
    store.showToast('稿件已作废并留痕', 'success')
    voidOpen.value = false
    emit('reload')
    emit('changed')
  } catch (e) { voidError.value = e.message } finally { saving.value = false }
}

// ---- 附件 ----
function pickNewFile() { replaceTarget.value = null; fileInput.value.click() }
function pickReplaceFile(a) { replaceTarget.value = a; fileInput.value.click() }
async function onFilePicked(ev) {
  const f = ev.target.files?.[0]
  ev.target.value = ''
  if (!f) return
  try {
    const init = await mutate('POST', `/writing/docs/${props.doc.id}/attachments/init`, {
      filename: f.name, content_type: f.type || 'application/octet-stream',
      attachment_id: replaceTarget.value?.id ?? null,
    })
    await uploadBinary(`/writing/attachments/upload/${init.data.version_id}`, await f.arrayBuffer(), init.data.upload_token, f.type || 'application/octet-stream')
    store.showToast(replaceTarget.value ? `已换版 v${init.data.version_no}，旧版仍可下载` : '原件已上传，等待解析', 'success')
    emit('reload')
  } catch (e) {
    store.showToast(e.message, 'error')
  }
}
async function downloadVer(attId, no) {
  try {
    await downloadBinary(`/writing/attachments/${attId}/download?version=${no}`)
  } catch (e) { store.showToast(e.message, 'error') }
}
async function markParsed(versionId, status) {
  try {
    await mutate('POST', `/writing/attachments/versions/${versionId}/parsed`, { status })
    store.showToast(`附件已标记为「${status}」`, 'success')
    emit('reload')
  } catch (e) { store.showToast(e.message, 'error') }
}
function humanSize(n) {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function toggleMaskPreview() {
  const turningOn = !maskPreview.value
  maskPreview.value = turningOn
  if (turningOn) {
    try {
      const r = await get(`/writing/docs/${props.doc.id}?view=masked`)
      maskedDoc.value = r.data
    } catch (e) { store.showToast(e.message, 'error'); maskPreview.value = false }
  } else {
    maskedDoc.value = null
  }
}
</script>
