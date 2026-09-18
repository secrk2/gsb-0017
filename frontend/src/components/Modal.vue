<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal" :class="{ wide }">
      <div class="spread">
        <h3>{{ title }}</h3>
        <button class="link-btn" style="color: var(--muted)" @click="$emit('close')">✕</button>
      </div>
      <slot />
    </div>
  </div>
</template>

<script setup>
defineProps({ title: String, wide: Boolean })
defineEmits(['close'])
</script>
