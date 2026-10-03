import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Physics is pure TS and runs in node; UI/DOM tests opt in with
    // `// @vitest-environment happy-dom` at the top of the file.
    environment: 'node',
    // Several physics checks run full solves/streamline traces; shared CI runners are 2-3x
    // slower than a dev laptop, so allow headroom (these are correctness, not timing, tests).
    testTimeout: 30_000,
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
    },
  },
});
