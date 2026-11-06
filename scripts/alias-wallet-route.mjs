import { mkdir, readFile, writeFile } from 'node:fs/promises'

const output = new URL('../dist/', import.meta.url)
const index = await readFile(new URL('index.html', output), 'utf8')
const nested = index.replaceAll('href="./', 'href="../').replaceAll('src="./', 'src="../')

if (nested === index) throw new Error('The wallet entry point has no relative assets to route')

const route = new URL('alt-mempool-wallet/', output)
await mkdir(route, { recursive: true })
await writeFile(new URL('index.html', route), nested)
