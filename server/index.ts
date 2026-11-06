import { resolve } from 'node:path'
import { createResearchServer } from './http.ts'

const port = Number(process.env.PORT ?? 4203)
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port')
const server = createResearchServer({
  config: { apiKey: process.env.OG_ROUTER_API_KEY, model: process.env.OG_MODEL },
  maxJobs: Number(process.env.OG_MAX_JOBS ?? 20),
  allowedOrigins: (process.env.APP_ORIGINS ?? 'http://127.0.0.1:4202,http://localhost:4202,http://localhost:5173').split(',').map(value => value.trim()).filter(Boolean),
  staticRoot: process.env.SERVE_STATIC === 'true' ? resolve('dist') : undefined,
})
server.requestTimeout = 250_000
server.headersTimeout = 15_000
server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  // No keys, prompts, watched addresses or source bodies are logged.
  process.stdout.write(`0xPay research service listening on port ${port}\n`)
})
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close())
