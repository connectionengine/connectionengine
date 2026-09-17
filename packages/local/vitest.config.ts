import { defineConfig } from 'vitest/config'

/**
 * Mirror core's vitest config so solid-js (if pulled transitively) resolves
 * its dev build with working reactivity under test.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^solid-js$/, replacement: 'solid-js/dist/dev.js' },
      { find: /^solid-js\/store$/, replacement: 'solid-js/store/dist/dev.js' }
    ]
  }
})
