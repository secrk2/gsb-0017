<template>
  <div>
    <div v-if="stale" class="offline-banner" style="position: static; border-radius: 8px; margin-bottom: 12px">
      <strong>缓存数据</strong>更新于 {{ fmtDateTime(cachedAt) }}，可能已过期；恢复网络后自动刷新。
    </div>

    <ErrorState v-if="error" :code="errorCode" :message="error" />
    <template v-else-if="dash">
      <div class="spread">
        <h2 style="margin: 0; font-size: 18px">案件作战台</h2>
        <button class="btn primary sm" :disabled="exporting" @click="exportCsv">
          {{ exporting ? '导出中…' : '⬇ 导出完成度 CSV' }}
        </button>
      </div>

      <!-- KPI -->
      <div class="kpi-grid mt16">
        <div class="card kpi"><div class="label">在办案件</div><div class="num">{{ dash.kpi.active_cases }}</div></div>
        <div class="card kpi warn"><div class="label">待处理官文（30日内/已逾期）</div><div class="num">{{ dash.kpi.pending_deadlines }}</div></div>
        <div class="card kpi warn"><div class="label">7 日内到期</div><div class="num">{{ dash.kpi.due_in_7d }}</div></div>
        <div class="card kpi bad">
          <div class="label"><span class="dot"></span> 缴费逾期</div>
          <div class="num">{{ dash.kpi.overdue_fees }}</div>
          <div class="small muted">合计 {{ fmtMoney(dash.kpi.overdue_fee_amount) }}</div>
        </div>
      </div>

      <!-- 完成度总览：两口径写明，与案件详情、CSV 导出同一算法 -->
      <div class="card mt16">
        <div class="spread">
          <h3 style="margin: 0">案件完成度总览</h3>
          <div class="row">
            <div class="seg">
              <button :class="basis === 'stage' ? 'on' : ''" @click="basis = 'stage'">关键阶段</button>
              <button :class="basis === 'doc' ? 'on' : ''" @click="basis = 'doc'">官文归档</button>
            </div>
            <span class="chip" :class="basis === 'stage' ? 'blue' : 'purple'">
              全所均值 {{ basis === 'stage' ? dash.completion.stage_avg : dash.completion.doc_avg }}%
            </span>
          </div>
        </div>
        <p class="small muted mt8" style="margin-bottom: 10px">
          口径：<strong>{{ basis === 'stage' ? dash.completion.stage_label : dash.completion.doc_label }}</strong>
          。半截官文案件两口径可能相反，故此处明示当前数字按哪种口径统计；导出的 CSV 两列都给。
          基准日：代理所今日 {{ dash.server_today }}（{{ dash.firm_tz }}）。
        </p>
        <table class="rtable static">
          <thead>
            <tr><th>案件</th><th>客户</th><th>状态</th>
            <th v-if="basis === 'stage'">关键阶段</th>
            <th v-else>官文归档</th>
            <th style="width: 180px">完成度</th>
          </tr>
          </thead>
          <tbody>
            <tr v-for="c in dash.completion.cases" :key="c.case_id" style="cursor: pointer" @click="$router.push(`/cases/${c.case_id}`)">
              <td data-label="案件">{{ c.case_no }} · {{ c.case_title }}</td>
              <td data-label="客户">{{ c.client_name }}</td>
              <td data-label="状态"><StatusBadge :status="c.status" /></td>
              <td data-label="明细">{{ basis === 'stage' ? `${c.stage.done}/${c.stage.total}` : `${c.doc.done}/${c.doc.total}` }}</td>
              <td data-label="完成度">
                <div class="mini-bar"><div class="mini-fill" :style="{ width: (basis === 'stage' ? c.stage.percent : c.doc.percent) + '%' }"></div></div>
                <span class="small">{{ basis === 'stage' ? c.stage.percent : c.doc.percent }}%</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="grid grid-main-side mt16">
        <!-- 各客户待处理漏斗 -->
        <div class="card">
          <h3>各客户待处理漏斗</h3>
          <FunnelBoard :funnels="dash.funnels" />
        </div>

        <!-- 缴费逾期红点 -->
        <div class="card">
          <h3><span class="dot"></span> 缴费逾期</h3>
          <div v-if="dash.overdue_fees.length">
            <div v-for="f in dash.overdue_fees" :key="f.id" class="funnel-row" style="cursor: pointer" @click="$router.push(`/cases/${f.case_id}`)">
              <div class="spread">
                <strong>{{ f.kind }}</strong>
                <span class="chip bad">逾期{{ f.overdue_days }}天</span>
              </div>
              <div class="small muted mt8">{{ f.case_no }} · {{ f.case_title }}</div>
              <div class="small mt8">{{ f.client_name }} · 应缴 {{ fmtMoney(f.amount) }} · 截止 {{ fmtDate(f.due_date) }}</div>
            </div>
          </div>
          <p v-else class="muted">暂无逾期费用 👍</p>
        </div>
      </div>

      <!-- 官文期限临近 -->
      <h3 class="section-title">官文期限临近（30 天内 / 已逾期）</h3>
      <div class="card" style="padding: 6px 0">
        <table class="rtable">
          <thead>
            <tr><th>期限</th><th>口径</th><th>到期日</th><th>倒计时</th><th>案件</th><th>客户</th></tr>
          </thead>
          <tbody>
            <tr v-for="d in dash.deadlines" :key="d.id" @click="$router.push(`/cases/${d.case_id}`)">
              <td data-label="期限">{{ d.dtype }}<div v-if="d.note" class="small muted">{{ d.note }}</div></td>
              <td data-label="口径">
                <span class="small">{{ ANCHOR_TEXT[d.anchor_basis] }} · {{ BASIS_TEXT[d.day_basis] }}<span v-if="d.rolled"> · 已顺延</span></span>
              </td>
              <td data-label="到期日">{{ fmtDate(d.due_date) }}</td>
              <td data-label="倒计时"><span class="chip" :class="dday(d.due_date, dash.server_today).cls">{{ dday(d.due_date, dash.server_today).text }}</span></td>
              <td data-label="案件">{{ d.case_no }} · {{ d.case_title }}</td>
              <td data-label="客户">{{ d.client_name }}</td>
            </tr>
            <tr v-if="!dash.deadlines.length"><td class="muted no-label" colspan="6" style="text-align:center">暂无临近官文期限</td></tr>
          </tbody>
        </table>
        <p class="small muted" style="padding: 8px 14px; margin: 0">倒计时按代理所今日 {{ dash.server_today }}（{{ dash.firm_tz }}）计算；期限全按 UTC 存储、按此时区展示。</p>
      </div>
    </template>
    <p v-else class="muted">加载中…</p>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { get, downloadText } from '../api.js'
import { store } from '../store.js'
import { fmtDate, fmtDateTime, fmtMoney, dday, ANCHOR_TEXT, BASIS_TEXT } from '../utils.js'
import FunnelBoard from '../components/FunnelBoard.vue'
import ErrorState from '../components/ErrorState.vue'
import StatusBadge from '../components/StatusBadge.vue'

const dash = ref(null)
const stale = ref(false)
const cachedAt = ref(null)
const error = ref('')
const errorCode = ref('ERROR')
const basis = ref('stage')
const exporting = ref(false)

async function load() {
  try {
    const r = await get('/dashboard', { cacheKey: 'dashboard' })
    dash.value = r.data
    stale.value = r.stale
    cachedAt.value = r.cachedAt
  } catch (e) {
    error.value = e.code === 'NETWORK' ? '当前离线且暂无缓存数据，请联网后刷新' : e.message
    errorCode.value = e.code
  }
}

async function exportCsv() {
  exporting.value = true
  try {
    await downloadText('/dashboard/export.csv', `案件完成度-${dash.value.server_today}.csv`)
    store.showToast('CSV 已导出（含两口径完成度列）', 'success')
  } catch (e) {
    store.showToast(e.message, 'error')
  } finally {
    exporting.value = false
  }
}

onMounted(() => {
  load()
  window.addEventListener('pc:synced', load)
})
onUnmounted(() => window.removeEventListener('pc:synced', load))
</script>
