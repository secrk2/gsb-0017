<template>
  <ErrorState code="FORBIDDEN" message="您没有权限访问该资源。如涉及其他客户的案件，系统已按数据隔离规则拦截。" />
</template>

<script setup>
import ErrorState from '../components/ErrorState.vue'
</script>
