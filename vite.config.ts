import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { createRequire } from 'node:module'

// RAILGUN's CommonJS packages require ethers. Force app imports to that same
// module instance so the FetchRequest hook cannot miss SDK-created providers.
const sdkEthers = createRequire(import.meta.url).resolve('ethers')

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), nodePolyfills({ globals: { Buffer: true, global: true, process: true } })],
  define: { global: 'globalThis' },
  resolve: { alias: [{ find: /^ethers$/, replacement: sdkEthers }] },
})
