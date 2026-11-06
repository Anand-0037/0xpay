import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  base: './',
  plugins: [react(), nodePolyfills({ globals: { Buffer: true, global: true, process: true } })],
  define: { global: 'globalThis' },
})
