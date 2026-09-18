<template>
  <div>
    <div class="spread">
      <h2 style="margin: 0">案件</h2>
      <label v-if="store.user?.role === 'agent'" class="row small" style="cursor: pointer">
        <input type="checkbox" v-model="mineOnly" style="width: auto" /> 仅看我名下
      </label>
    </div>

    <div class="row mt8">
      <button
        v-for="s in statusFilters"
        :key="s"
        class="btn sm"
        :style="activeStatus === s ? 'background: var(--brand); color: #fff; border-color: var(--brand)' : ''"
        @click="activeStatus = s"
      >{{ s }}</button>
    </div>

    <div v-if="stale" class="offline-banner" style="position: static; border-radius: 8px; margin: 12px 0">
      <strong>缓存数据</strong>更新于 {{ fmtDateTime(cachedAt) }}，可能已过期。
    </div>

    <!-- 离线待同步 -->
    <div v-if="queuedCreates.length" class="card mt16" style="border-color: #f0d48a">
      <h3 style="color: var(--warn)">待同步（{{ queuedCreates.length }}）</h3>
      <div v-for="q in queuedCreates" :key="q.key" class="row" style="padding: 6px 0; border-top: 1px solid var(--line)">
        <span class="chip warn">待同步</span>
        <span>{{ q.label }}</span>
        <span class="small muted">恢复网络后自动提交，重复提交会被幂等去重</span>
      </div>
    </div>

    <ErrorState v-if="error" :code="errorCode" :message="error" />
    <div v-else class="card" style="padding: 6px 0; margin-top: 16px">
      <table class="rtable">
        <thead>
          <tr><th>案件号</th><th>名称</th><th>客户</th><th>类型</th><th>状态</th><th>代理人</th><th>更新</th></tr>
        </thead>
        <tbody>
          <tr v-for="c in cases" :key="c.id" @click="$router.push(`/cases/${c.id}`)">
            <td data-label="案件号">{{ c.case_no }}</td>
            <td data-label="名称">{{ c.title }}</td>
            <td data-label="客户">{{ c.client_name }} <span v-if="c.client_masked" class="lock">🔒</span></td>
            <td data-label="类型">{{ c.ctype }}</td>
            <td data-label="状态"><StatusBadge :status="c.status" /></td>
            <td data-label="代理人">{{ c.agent_name || '待指派' }}</td>
            <td data-label="更新">{{ fmtDate(c.updated_at) }}</td>
          </tr>
          <tr v-if="!cases.length"><td class="muted no-label" colspan="7" style="text-align:center">没有符合条件的案件</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { get, refreshOutboxCount } from '../api.js'
import { store } from '../store.js'
import { fmtDate, fmtDateTime } from '../utils.js'
import StatusBadge from '../components/StatusBadge.vue'
import ErrorState from '../components/ErrorState.vue'

const statusFilters = ['全部', '委托中', '已立项', '申请', '受理', '初审', '实审中', '复审中', '授权', '驳回', '无效']
const activeStatus = ref('全部')
const mineOnly = ref(false)
const cases = ref([])
const queuedCreates = ref([])
const stale = ref(false)
const cachedAt = ref(null)
const error = ref('')
const errorCode = ref('ERROR')

async function load() {
  error.value = ''
  const params = new URLSearchParams()
  if (activeStatus.value !== '全部') params.set('status', activeStatus.value)
  if (mineOnly.value) params.set('mine', '1')
  const qs = params.toString()
  try {
    const r = await get(`/cases${qs ? '?' + qs : ''}`, { cacheKey: `cases:${qs}` })
    cases.value = r.data
    stale.value = r.stale
    cachedAt.value = r.cachedAt
  } catch (e) {
    error.value = e.code === 'NETWORK' ? '当前离线且暂无缓存数据' : e.message
    errorCode.value = e.code
  }
}

async function loadOutbox() {
  const ops = await refreshOutboxCount()
  queuedCreates.value = ops.filter((o) => o.op === 'case.create')
}

watch([activeStatus, mineOnly], load)

onMounted(() => {
  load()
  loadOutbox()
  window.addEventListener('pc:synced', load)
})
onUnmounted(() => window.removeEventListener('pc:synced', load))
</script>
