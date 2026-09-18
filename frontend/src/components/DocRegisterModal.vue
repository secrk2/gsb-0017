<template>
  <Modal :title="title" @close="$emit('close')">
    <div class="field">
      <label>官文类型 *</label>
      <select v-model="form.doc_type" @change="onTypeChange">
        <option value="" disabled>请选择</option>
        <optgroup v-for="(keys, g) in dict.groups" :key="g" :label="g">
          <option v-for="k in keys" :key="k" :value="k">{{ k }}</option>
        </optgroup>
      </select>
      <p v-if="def" class="small mt8" :class="def.to ? '' : 'muted'">
        <template v-if="def.to">登记效力：案件将流转至「{{ def.to }}」，禁跳步。</template>
        <template v-else>中性通知：只登记归档，不改变案件状态。</template>
      </p>
    </div>

    <div class="field"><label>文书文号</label><input v-model="form.doc_no" placeholder="如 第一次审查意见通知书编号，可留空" /></div>
    <div class="grid" style="grid-template-columns: 1fr 1fr">
      <div class="field">
        <label>发文日</label>
        <input v-model="form.dispatch_date" type="date" @change="schedulePreview" />
      </div>
      <div class="field">
        <label>收到日（实际签收）</label>
        <input v-model="form.receive_date" type="date" @change="schedulePreview" />
      </div>
    </div>
    <p class="small muted" style="margin-top: -4px">
      未补录收到日时按<strong>发文日+15 日推定收到日</strong>起算；发文日与收到日相差数日，起算口径以下方明示为准。
    </p>

    <div v-if="def?.deadline" class="deadline-box">
      <label class="row spread" style="font-size: 13px">
        <span>同步生成法定期限</span>
        <input type="checkbox" v-model="form.create_deadline" style="width: auto" />
      </label>
      <template v-if="form.create_deadline">
        <div class="field"><label>期限事项</label><input v-model="dl.label" /></div>
        <div class="field">
          <label>起算口径（以哪天为第 0 天）*</label>
          <div class="seg">
            <button type="button" :class="dl.anchor === 'receive' ? 'on' : ''" @click="dl.anchor = 'receive'; schedulePreview()">自收到日</button>
            <button type="button" :class="dl.anchor === 'dispatch' ? 'on' : ''" @click="dl.anchor = 'dispatch'; schedulePreview()">自发文日</button>
          </div>
          <p class="small muted mt8" style="margin-bottom: 0">当前以「{{ preview?.start_kind || '—' }}」{{ preview?.start_date || '' }} 为起算日。</p>
        </div>
        <div class="grid" style="grid-template-columns: 1fr 96px">
          <div class="field">
            <label>天数口径 *</label>
            <select v-model="dl.day_basis" @change="schedulePreview()">
              <option value="natural">自然日（不顺延）</option>
              <option value="workday">工作日（跳过周末/法定节假日，调休计入）</option>
              <option value="legal">法定节假日顺延（自然日届满，逢假顺延）</option>
            </select>
          </div>
          <div class="field">
            <label>天数 *</label>
            <input v-model.number="dl.duration_days" type="number" min="1" @input="schedulePreview" />
          </div>
        </div>
        <p class="small muted">{{ basisHint }}</p>

        <!-- 实时预览：到期日 + 剩余天数，口径全部写明 -->
        <div v-if="preview" class="preview-box" :class="preview.overdue ? 'overdue' : ''">
          <div class="spread">
            <strong>到期日 {{ preview.due_date }}</strong>
            <span class="chip" :class="leftCls">{{ leftText }}</span>
          </div>
          <div class="small muted mt8">
            {{ preview.anchor_label }}起算 · 第 1 日为起算日次日 · 共 {{ preview.duration_days }} 天
            <span v-if="dl.day_basis === 'natural'">（自然日）</span>
            <span v-else-if="dl.day_basis === 'workday'">（工作日）</span>
            <span v-else>（法定口径{{ preview.rolled ? '，已节假日顺延' : '，未触发顺延' }}）</span>
          </div>
          <div class="small muted">代理所今日（{{ firmTz }}）：{{ preview.server_today }}</div>
        </div>
        <div v-else-if="previewError" class="small" style="color: var(--bad)">{{ previewError }}</div>
      </template>
    </div>

    <div class="field"><label>备注</label><textarea v-model="form.note" rows="2"></textarea></div>

    <!-- 落点逾期：二次确认 + 必填原因留痕 -->
    <div v-if="overdue" class="overdue-confirm">
      <strong>该期限落点已逾期 {{ -preview.days_left }} 天</strong>
      <p class="small" style="margin: 6px 0">到期日 {{ preview.due_date }} 早于代理所今日（{{ preview.server_today }}）。超期登记将全程留痕，请二次确认并说明原因。</p>
      <label class="row small" style="gap: 6px"><input type="checkbox" v-model="confirmOverdue" style="width: auto" /> 我已知悉超期风险并确认登记</label>
      <div class="field mt8" style="margin-bottom: 0"><label>超期补登原因（不少于 2 字，必填）*</label>
        <textarea v-model="overdueReason" rows="2" placeholder="如：纸质通知书收发室延误、客户转交滞后……"></textarea>
      </div>
    </div>

    <p v-if="submitError" class="small" style="color: var(--bad)">{{ submitError }}</p>
    <div class="modal-actions">
      <button class="btn" @click="$emit('close')">取消</button>
      <button class="btn primary" :disabled="saving" @click="submit">{{ overdue ? '确认超期并登记' : '登记官文' }}</button>
    </div>
  </Modal>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { get, mutate } from '../api.js'
import { store } from '../store.js'
import Modal from './Modal.vue'

const props = defineProps({
  caseId: { type: Number, required: true },
  ctype: { type: String, default: '' },
})
const emit = defineEmits(['close', 'registered'])

const dict = ref({ types: [], groups: {} })
const form = reactive({ doc_type: '', doc_no: '', dispatch_date: '', receive_date: '', note: '', create_deadline: true })
const dl = reactive({ label: '', anchor: 'receive', day_basis: 'legal', duration_days: null })
const preview = ref(null)
const previewError = ref('')
const overdue = ref(false)
const confirmOverdue = ref(false)
const overdueReason = ref('')
const submitError = ref('')
const saving = ref(false)
let timer = null

const def = computed(() => dict.value.types.find((t) => t.key === form.doc_type) || null)
const title = computed(() => (overdue.value ? '登记官文 · 超期二次确认' : '登记官文'))
const firmTz = computed(() => preview.value?.firm_tz || 'Asia/Shanghai')
const basisHint = computed(() => ({
  natural: '自然日口径：直接按日历日届满，周末/节假日不顺延。',
  workday: '工作日口径：跳过周六日与法定节假日，国务院调休补班的周末日照常计入。',
  legal: '法定口径：按自然日届满；届满日为休息日或法定节假日的，顺延至其后第一个工作日（春节/国庆长假会显著后移）。',
}[dl.day_basis]))
const leftText = computed(() => {
  const n = preview.value?.days_left
  if (n == null) return ''
  if (n < 0) return `已逾期 ${-n} 天`
  if (n === 0) return '今天到期'
  return `剩 ${n} 天`
})
const leftCls = computed(() => {
  const n = preview.value?.days_left ?? 0
  return n < 0 ? 'bad' : n <= 3 ? 'bad' : n <= 7 ? 'warn' : 'ok'
})

onMounted(async () => {
  try {
    dict.value = (await get('/doc-types')).data
  } catch (e) {
    submitError.value = `官文类型字典加载失败：${e.message}`
  }
})
onUnmounted(() => clearTimeout(timer))

function onTypeChange() {
  const d = def.value
  if (d?.deadline) {
    form.create_deadline = true
    dl.label = d.deadline.label
    dl.anchor = d.deadline.anchor
    dl.day_basis = d.deadline.dayBasis
    dl.duration_days = d.deadline.days
  } else {
    form.create_deadline = false
  }
  overdue.value = false
  confirmOverdue.value = false
  overdueReason.value = ''
  schedulePreview()
}

function schedulePreview() {
  clearTimeout(timer)
  timer = setTimeout(doPreview, 250)
}

async function doPreview() {
  preview.value = null
  previewError.value = ''
  if (!form.create_deadline || !def.value?.deadline) return
  if (!form.dispatch_date && !form.receive_date) return
  if (!dl.duration_days || dl.duration_days <= 0) return
  try {
    const { data } = await mutate('POST', `/cases/${props.caseId}/deadline-preview`, {
      anchor: dl.anchor,
      day_basis: dl.day_basis,
      duration_days: dl.duration_days,
      dispatch_date: form.dispatch_date || null,
      receive_date: form.receive_date || null,
    })
    preview.value = data
    if (data.overdue) overdue.value = true
    else if (overdue.value) {
      overdue.value = false
      confirmOverdue.value = false
      overdueReason.value = ''
    }
  } catch (e) {
    previewError.value = e.message
  }
}

async function submit() {
  submitError.value = ''
  if (!form.doc_type) {
    submitError.value = '请选择官文类型'
    return
  }
  if (!form.dispatch_date && !form.receive_date) {
    submitError.value = '请至少填写发文日或收到日'
    return
  }
  if (overdue.value && (!confirmOverdue.value || overdueReason.value.trim().length < 2)) {
    submitError.value = '超期登记必须勾选确认并填写不少于 2 字的原因'
    return
  }
  saving.value = true
  const body = {
    doc_type: form.doc_type,
    doc_no: form.doc_no,
    dispatch_date: form.dispatch_date || null,
    receive_date: form.receive_date || null,
    note: form.note,
    create_deadline: form.create_deadline && Boolean(def.value?.deadline),
    deadline: form.create_deadline && def.value?.deadline
      ? { label: dl.label, anchor: dl.anchor, day_basis: dl.day_basis, duration_days: dl.duration_days }
      : undefined,
    confirm_overdue: overdue.value,
    overdue_reason: overdue.value ? overdueReason.value.trim() : '',
  }
  try {
    // 在线直接提交（表单内预览已实时算过到期日）；断网时进入离线队列，回放时按冲突/超期规则处理
    const r = await mutate('POST', `/cases/${props.caseId}/docs`, body, {
      offlineOp: { op: 'doc.register', payload: { case_id: props.caseId, body }, label: `登记官文「${form.doc_type}」` },
    })
    if (r.queued) {
      store.showToast('当前离线：官文登记已加入待同步队列', 'info')
    } else {
      store.showToast(r.data.transitioned ? `官文已登记，案件流转至「${r.data.case_status}」` : '官文已登记', 'success')
    }
    emit('registered', r.data)
    emit('close')
  } catch (e) {
    if (e.code === 'OVERDUE_CONFIRM') {
      preview.value = e.details?.preview || preview.value
      overdue.value = true
      submitError.value = ''
    } else {
      submitError.value = e.message
    }
  } finally {
    saving.value = false
  }
}
</script>
