<template>
  <div v-if="!store.online || store.outboxCount > 0" class="offline-banner">
    <template v-if="!store.online">
      <strong>离线模式</strong>当前网络不可用：展示的是本地缓存数据（可能已过期），请勿据此对外承诺；变更会进入待同步队列，恢复网络后自动合并。
    </template>
    <template v-else-if="store.outboxCount > 0">
      <strong>{{ store.outboxCount }} 条变更待同步</strong>将在网络稳定后自动提交。
    </template>
  </div>
</template>

<script setup>
import { store } from '../store.js'
</script>
