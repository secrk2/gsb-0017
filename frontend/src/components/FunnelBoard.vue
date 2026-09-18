<template>
  <div>
    <div v-for="f in funnels" :key="f.client_id" class="funnel-row">
      <div class="spread">
        <div class="row">
          <router-link :to="`/clients/${f.client_id}`"><strong>{{ f.client_name }}</strong></router-link>
          <span v-if="f.masked" class="lock" title="已脱敏，查看全称需留痕">🔒 已脱敏</span>
        </div>
        <div class="row">
          <span v-if="f.overdue_fees > 0" class="chip bad"><span class="dot"></span>{{ f.overdue_fees }} 笔费用逾期</span>
          <span v-if="f.pending_deadlines > 0" class="chip warn">{{ f.pending_deadlines }} 项官文待办</span>
          <span v-if="!f.overdue_fees && !f.pending_deadlines" class="chip ok">无待办</span>
        </div>
      </div>
      <div class="funnel">
        <div
          v-for="seg in segments"
          :key="seg"
          class="fseg"
          :class="[f.by_status[seg] ? `s-${seg}` : 'empty']"
          :style="{ flexGrow: f.by_status[seg] || 0.35 }"
          :title="`${seg}：${f.by_status[seg] || 0} 件`"
        >
          {{ seg }} {{ f.by_status[seg] || 0 }}
        </div>
      </div>
      <div class="small muted mt8">
        已结案：授权 {{ f.by_status['授权'] || 0 }} · 驳回 {{ f.by_status['驳回'] || 0 }} · 无效 {{ f.by_status['无效'] || 0 }}
      </div>
    </div>
    <p v-if="!funnels.length" class="muted">暂无客户数据</p>
  </div>
</template>

<script setup>
defineProps({ funnels: { type: Array, default: () => [] } })
// 七段在办（委托/立项/申请/受理/初审/实审/复审）；授权/驳回/无效为结案，在底部计数
const segments = ['委托中', '已立项', '申请', '受理', '初审', '实审中', '复审中']
</script>
