<template>
  <div class="error-state">
    <div class="icon">{{ icon }}</div>
    <h2>{{ title }}</h2>
    <p>{{ message }}</p>
    <div class="row" style="justify-content: center">
      <button class="btn" @click="$router.back()">返回上一页</button>
      <router-link class="btn primary" to="/">回到作战台</router-link>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  code: { type: String, default: 'ERROR' },
  message: { type: String, default: '发生未知错误' },
})

const icon = computed(() => (props.code === 'FORBIDDEN' ? '🔒' : props.code === 'NOT_FOUND' ? '🔍' : '⚠️'))
const title = computed(
  () =>
    ({
      FORBIDDEN: '无权访问',
      NOT_FOUND: '内容不存在',
      NETWORK: '网络不可用',
    })[props.code] || '出错了'
)
</script>
