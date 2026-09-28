import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      { find: /^solid-js$/, replacement: 'solid-js/dist/dev.js' },
      { find: /^solid-js\/store$/, replacement: 'solid-js/store/dist/dev.js' }
    ]
  }
})
