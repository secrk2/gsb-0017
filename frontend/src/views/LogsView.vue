<template>
  <div>
    <h2 style="margin-top: 0">审计留痕</h2>
    <div class="row">
      <button class="btn sm" :style="tab === 'unmask' ? activeStyle : ''" @click="tab = 'unmask'">脱敏查看留痕</button>
      <button class="btn sm" :style="tab === 'events' ? activeStyle : ''" @click="tab = 'events'">案件流转事件</button>
    </div>

    <div class="card mt16" style="padding: 6px 0">
      <table v-if="tab === 'unmask'" class="rtable static">
        <thead>
          <tr><th>时间</th><th>查看人</th><th>客户</th><th>关联案件</th><th>理由</th><th>IP</th></tr>
        </thead>
        <tbody>
          <tr v-for="l in unmaskLogs" :key="l.id">
            <td data-label="时间">{{ fmtDateTime(l.created_at) }}</td>
            <td data-label="查看人">{{ l.user_name }}</td>
            <td data-label="客户">{{ l.short_code }}·{{ l.client_code }}</td>
            <td data-label="关联案件">{{ l.case_id ? `#${l.case_id}` : '—' }}</td>
            <td data-label="理由">{{ l.reason }}</td>
            <td data-label="IP"><span class="small muted">{{ l.ip }}</span></td>
          </tr>
          <tr v-if="!unmaskLogs.length"><td class="muted no-label" colspan="6" style="text-align:center">暂无查看记录</td></tr>
        </tbody>
      </table>

      <table v-else class="rtable static">
        <thead>
          <tr><th>时间</th><th>案件</th><th>动作</th><th>状态变化</th><th>操作人</th><th>备注</th></tr>
        </thead>
        <tbody>
          <tr v-for="e in events" :key="e.id">
            <td data-label="时间">{{ fmtDateTime(e.created_at) }}</td>
            <td data-label="案件">{{ e.case_no }} · {{ e.case_title }}</td>
            <td data-label="动作">{{ e.action }}</td>
            <td data-label="状态变化">
              <template v-if="e.from_status">{{ e.from_status }} → {{ e.to_status }}</template>
              <template v-else>{{ e.to_status }}</template>
            </td>
            <td data-label="操作人">{{ e.actor_name }}</td>
            <td data-label="备注">{{ e.reason || '—' }}</td>
          </tr>
          <tr v-if="!events.length"><td class="muted no-label" colspan="6" style="text-align:center">暂无流转事件</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { get } from '../api.js'
import { fmtDateTime } from '../utils.js'

const tab = ref('unmask')
const unmaskLogs = ref([])
const events = ref([])
const activeStyle = 'background: var(--brand); color: #fff; border-color: var(--brand)'

onMounted(async () => {
  try {
    unmaskLogs.value = (await get('/logs/unmask', { cacheKey: 'logs:unmask' })).data
    events.value = (await get('/logs/events', { cacheKey: 'logs:events' })).data
  } catch (e) {
    // 权限不足时路由守卫已拦截；这里兜底
  }
})
</script>
