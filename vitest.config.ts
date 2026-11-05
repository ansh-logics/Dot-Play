import { defineConfig } from 'vitest/config'

// Unit tests for the app's pure logic (lyrics, queue, Phone Remote crypto, imports).
// The relay has its own end-to-end test (relay/test/e2e.mjs).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
