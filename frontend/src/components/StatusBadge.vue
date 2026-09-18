<template>
  <span class="chip" :class="`st-${status}`">{{ status }}</span>
</template>

<script setup>
defineProps({ status: String })
</script>
