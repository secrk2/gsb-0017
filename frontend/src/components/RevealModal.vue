<template>
  <Modal title="查看客户全称（敏感操作）" @close="$emit('close')">
    <p class="muted small" style="margin-top: 0">
      该客户已立项，名称按所内保密制度脱敏为「缩写·编号」。查看全称需二次确认并填写业务理由，
      <strong style="color: var(--bad)">本次查看将全程留痕</strong>，供管理员与审核员审计。
    </p>
    <div class="field">
      <label>查看理由（必填，将写入留痕日志）</label>
      <textarea v-model="reason" rows="3" placeholder="例如：答复审查意见需核对申请人全称"></textarea>
    </div>
    <div class="field">
      <label class="row" style="cursor: pointer; color: var(--ink)">
        <input type="checkbox" v-model="confirmed" style="width: auto" />
        我确认因办案需要查看，并知晓本次查看将被记录
      </label>
    </div>
    <p v-if="error" class="small" style="color: var(--bad)">{{ error }}</p>
    <div class="modal-actions">
      <button class="btn" @click="$emit('close')">取消</button>
      <button class="btn primary" :disabled="!confirmed || reason.trim().length < 2 || loading" @click="submit">
        {{ loading ? '提交中…' : '确认查看' }}
      </button>
    </div>
  </Modal>
</template>

<script setup>
import { ref } from 'vue'
import Modal from './Modal.vue'
import { mutate } from '../api.js'

const props = defineProps({
  clientId: { type: Number, required: true },
  caseId: { type: Number, default: null },
})
const emit = defineEmits(['close', 'revealed'])

const reason = ref('')
const confirmed = ref(false)
const loading = ref(false)
const error = ref('')

async function submit() {
  loading.value = true
  error.value = ''
  try {
    const { data } = await mutate('POST', `/clients/${props.clientId}/reveal`, {
      reason: reason.value.trim(),
      case_id: props.caseId,
    })
    emit('revealed', data.name)
    emit('close')
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}
</script>
