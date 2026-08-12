import { playwright } from '@vitest/browser-playwright';
import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.mts';

export default defineConfig(({ command, mode }) => {
  const baseConfig = viteConfig({ command, mode, isSsrBuild: false, isPreview: false });
  return mergeConfig(
    baseConfig,
    defineConfig({
      test: {
        include: ['src/**/*.browser.test.{ts,tsx}'],
        exclude: [],
        typecheck: {
          enabled: true,
          include: ['src/**/*.browser.test.{ts,tsx}'],
        },
        browser: {
          enabled: true,
          provider: playwright(),
          instances: [{ browser: 'chromium' }],
        },
      },
      server: {
        host: '127.0.0.1',
      },
      optimizeDeps: {
        include: ['react/compiler-runtime'],
      },
    })
  );
});
