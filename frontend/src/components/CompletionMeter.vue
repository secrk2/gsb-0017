<template>
  <div class="completion">
    <div class="completion-head spread">
      <div class="completion-title">
        案件完成度
        <span class="small muted">（口径写明，不混用）</span>
      </div>
      <div class="row">
        <button class="btn sm" :class="basis === 'stage' ? 'primary' : ''" @click="$emit('update:basis', 'stage')">关键阶段</button>
        <button class="btn sm" :class="basis === 'doc' ? 'primary' : ''" @click="$emit('update:basis', 'doc')">官文归档</button>
      </div>
    </div>
    <div class="completion-body">
      <div class="completion-bar">
        <div class="completion-fill" :style="{ width: metric.percent + '%' }"></div>
        <span class="completion-num">{{ metric.percent }}%</span>
      </div>
      <div class="row spread small mt8">
        <span class="muted">{{ basis === 'stage' ? '已到达法定阶段 / 该案件类型关键阶段总数' : '已归档官文 / 官文登记总数（含已撤回）' }}</span>
        <span><strong>{{ metric.done }}</strong> / {{ metric.total }}{{ basis === 'stage' ? ' 个阶段' : ' 份官文' }}</span>
      </div>
      <p class="small muted mt8" style="margin-bottom: 0">
        两口径可能相反：走完法定程序但官文只登记未归档（半截官文）时，关键阶段接近完成、官文归档仍偏低。
        作战台、本详情、CSV 导出三处数字来自同一计算口径。
      </p>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  completion: { type: Object, required: true },
  basis: { type: String, default: 'stage' },
})
defineEmits(['update:basis'])

const metric = computed(() => props.completion[props.basis] || { done: 0, total: 0, percent: 0 })
</script>
