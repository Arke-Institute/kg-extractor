import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 120000, // 120 seconds for E2E tests (Gemini can be slow)
  },
});
