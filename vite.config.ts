import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

// RAILGUN's CommonJS packages require ethers. Force app imports to that same
// module instance so the FetchRequest hook cannot miss SDK-created providers.
const sdkEthers = createRequire(import.meta.url).resolve('ethers')
const projectRoot = fileURLToPath(new URL('.', import.meta.url))
// Public source fingerprint only: never read .env, browser data or private notes.
const sourceHash = createHash('sha256')
function hashSource(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) hashSource(path)
    else if (entry.isFile()) { sourceHash.update(relative(projectRoot, path).replaceAll('\\', '/')); sourceHash.update(readFileSync(path)) }
  }
}
hashSource(join(projectRoot, 'src'))
for (const name of ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts']) {
  sourceHash.update(name); sourceHash.update(readFileSync(join(projectRoot, name)))
}
let revision = 'unknown'
try {
  const options = { cwd: projectRoot, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] }
  revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], options).trim()
  if (execFileSync('git', ['status', '--porcelain'], options).trim()) revision += '+local'
} catch { /* A source archive can build without a Git checkout. */ }
const buildId = `${revision}.${sourceHash.digest('hex').slice(0, 12)}`

// https://vite.dev/config/
export default defineConfig({
  base: './',
  server: { proxy: { '/api': 'http://127.0.0.1:4203' } },
  preview: { proxy: { '/api': 'http://127.0.0.1:4203' } },
  plugins: [react(), nodePolyfills({ globals: { Buffer: true, global: true, process: true } })],
  define: { global: 'globalThis', 'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(buildId) },
  resolve: { alias: [{ find: /^ethers$/, replacement: sdkEthers }] },
})
