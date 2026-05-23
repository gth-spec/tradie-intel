import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: { reporter: ['text', 'html'] }
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname }
  }
});
