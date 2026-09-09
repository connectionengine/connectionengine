import { defineConfig } from 'vitest/config'

/**
 * Vitest's default 'node' export condition resolves solid-js to its server
 * build, which has stub reactivity. Alias to the dev build so reactor tests
 * can verify Solid signal propagation.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^solid-js$/, replacement: 'solid-js/dist/dev.js' },
      { find: /^solid-js\/store$/, replacement: 'solid-js/store/dist/dev.js' }
    ]
  }
})
