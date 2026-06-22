<template>
  <main class="page">
    <div class="card">
      <h1>404</h1>
      <p class="muted">That page does not exist.</p>
      <RouterLink :to="{ name: 'drive' }">Back to drive</RouterLink>
    </div>
  </main>
</template>

<style scoped>
.page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}
.card {
  text-align: center;
}
.muted {
  color: var(--df-color-fg-muted);
}
</style>
