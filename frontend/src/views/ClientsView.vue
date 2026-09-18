<template>
  <div>
    <div class="spread">
      <h2 style="margin: 0">委托与客户</h2>
      <button v-if="store.user?.role === 'admin'" class="btn primary" @click="showCreate = true">＋ 客户建档</button>
    </div>
    <p class="muted small">业务链路：客户建档 → 签委托合同 → 案件立项派代理人。立项后客户名称按保密制度脱敏。</p>

    <div v-if="stale" class="offline-banner" style="position: static; border-radius: 8px; margin: 12px 0">
      <strong>缓存数据</strong>更新于 {{ fmtDateTime(cachedAt) }}，可能已过期。
    </div>

    <ErrorState v-if="error" :code="errorCode" :message="error" />
    <div v-else class="card" style="padding: 6px 0">
      <table class="rtable">
        <thead>
          <tr><th>编号</th><th>客户名称</th><th>联系人</th><th>状态</th><th>委托合同</th><th>案件数</th></tr>
        </thead>
        <tbody>
          <tr v-for="c in clients" :key="c.id" @click="$router.push(`/clients/${c.id}`)">
            <td data-label="编号">{{ c.code }}</td>
            <td data-label="客户名称">
              {{ c.name }}
              <span v-if="c.masked" class="lock" title="已脱敏，查看全称需留痕">🔒</span>
            </td>
            <td data-label="联系人">{{ c.contact_name || '—' }}<div class="small muted">{{ c.contact_phone }}</div></td>
            <td data-label="状态"><span class="chip" :class="c.status === '已签约' ? 'ok' : 'blue'">{{ c.status }}</span></td>
            <td data-label="委托合同"><span class="chip" :class="c.has_contract ? 'ok' : 'warn'">{{ c.has_contract ? '已签署' : '未签' }}</span></td>
            <td data-label="案件数">{{ c.case_count }}</td>
          </tr>
          <tr v-if="!clients.length"><td class="muted no-label" colspan="6" style="text-align:center">暂无客户</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 客户建档 -->
    <Modal v-if="showCreate" title="客户建档" @close="showCreate = false">
      <div class="field"><label>客户全称 *</label><input v-model="form.name" placeholder="例如：某某科技有限公司" /></div>
      <div class="field"><label>缩写（脱敏展示用，2-4 位字母）*</label><input v-model="form.short_code" placeholder="例如：MK" /></div>
      <div class="field"><label>联系人</label><input v-model="form.contact_name" /></div>
      <div class="field"><label>联系电话</label><input v-model="form.contact_phone" /></div>
      <div class="field"><label>邮箱</label><input v-model="form.contact_email" /></div>
      <p v-if="formError" class="small" style="color: var(--bad)">{{ formError }}</p>
      <div class="modal-actions">
        <button class="btn" @click="showCreate = false">取消</button>
        <button class="btn primary" :disabled="saving" @click="createClient">建档</button>
      </div>
    </Modal>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { get, mutate } from '../api.js'
import { store } from '../store.js'
import { fmtDateTime } from '../utils.js'
import Modal from '../components/Modal.vue'
import ErrorState from '../components/ErrorState.vue'

const clients = ref([])
const stale = ref(false)
const cachedAt = ref(null)
const error = ref('')
const errorCode = ref('ERROR')
const showCreate = ref(false)
const saving = ref(false)
const formError = ref('')
const form = ref({ name: '', short_code: '', contact_name: '', contact_phone: '', contact_email: '' })

async function load() {
  try {
    const r = await get('/clients', { cacheKey: 'clients' })
    clients.value = r.data
    stale.value = r.stale
    cachedAt.value = r.cachedAt
  } catch (e) {
    error.value = e.message
    errorCode.value = e.code
  }
}

async function createClient() {
  formError.value = ''
  if (!form.value.name.trim() || !form.value.short_code.trim()) {
    formError.value = '请填写客户全称与缩写'
    return
  }
  saving.value = true
  try {
    await mutate('POST', '/clients', form.value)
    showCreate.value = false
    form.value = { name: '', short_code: '', contact_name: '', contact_phone: '', contact_email: '' }
    store.showToast('客户建档成功', 'success')
    await load()
  } catch (e) {
    formError.value = e.message
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
