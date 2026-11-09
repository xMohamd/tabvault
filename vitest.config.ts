import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    include: ['tests/**/*.test.ts'],
    // Library modules keep per-context state (logger, detection cache, scheduler queue).
    isolate: true,
    // Popup tests render the real React UI; CI runners are slower than a dev machine.
    testTimeout: 15_000,
    hookTimeout: 20_000,
  },
});
