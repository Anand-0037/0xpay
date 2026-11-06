/** Only public, credential-free venue metadata. Not an anonymous transport. */
export function isPublicMarketRead(url: URL, method: string, body: unknown): boolean {
  if (method.toUpperCase() !== 'GET' || (body !== null && body !== undefined) || url.protocol !== 'https:' ||
    url.username || url.password || url.hash || url.port) return false
  const entries = [...url.searchParams.entries()]
  if (new Set(entries.map(([name]) => name)).size !== entries.length) return false
  if (url.hostname === 'gamma-api.polymarket.com' && url.pathname === '/markets') {
    const required: Record<string, string> = { active: 'true', closed: 'false', limit: '20', order: 'volume24hr', ascending: 'false', version: 'v1' }
    return entries.length === Object.keys(required).length && entries.every(([name, value]) => required[name] === value)
  }
  if (url.hostname === 'clob.polymarket.com' && url.pathname === '/book' && entries.length === 1 && entries[0][0] === 'token_id') {
    const value = entries[0][1]
    return /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) <= (1n << 256n) - 1n
  }
  return false
}
