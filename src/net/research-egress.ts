import { Mnemonic, wordlists } from 'ethers'

/** Shared accidental-disclosure guard; it cannot recognize every kind of personal data. */
export function containsSensitiveResearchText(value: string): boolean {
  if (/0x[0-9a-f]{40}(?![0-9a-f])|\b(?:0x)?[0-9a-f]{64}\b|\b0zk[0-9a-z]+|\bsk-[a-z0-9_-]{8,}|\bbearer\s+\S+|\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+|\b(?:my|our|your)\s+(?:wallet|holdings|account|portfolio|balance)|\b(?:private\s*key|seed\s*phrase|recovery\s*phrase)\s*[:=]/i.test(value)) return true
  const words = value.toLowerCase().match(/[a-z]+/g) ?? []
  const known = words.map(word => wordlists.en.getWordIndex(word) >= 0)
  for (let start = 0; start < words.length; start++) {
    if (!known[start]) continue
    for (const size of [12, 15, 18, 21, 24]) {
      if (start + size > words.length) break
      if (known.slice(start, start + size).every(Boolean) && Mnemonic.isValidMnemonic(words.slice(start, start + size).join(' '))) return true
    }
  }
  return false
}

/** Prevent accidental wallet/session dumps to the local research service. */
export function isPublicResearchBody(body: unknown): boolean {
  if (typeof body !== 'string' || body.length > 128 * 1024 || new TextEncoder().encode(body).length > 128 * 1024) return false
  try {
    const value: unknown = JSON.parse(body)
    if (!plain(value) || !keys(value, ['market', 'sources']) || !plain(value.market) ||
      !keys(value.market, ['marketId', 'question', 'outcomes', 'selectedOutcome']) ||
      !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 6) return false
    const { marketId, question, outcomes, selectedOutcome } = value.market
    if (!text(marketId, 128) || !/^[a-z0-9._:-]+$/i.test(marketId) || !text(question, 1500) ||
      !Array.isArray(outcomes) || outcomes.length < 2 || outcomes.length > 8 ||
      !outcomes.every(outcome => text(outcome, 128)) || new Set(outcomes).size !== outcomes.length ||
      !text(selectedOutcome, 128) || !outcomes.includes(selectedOutcome)) return false
    const ids = new Set<string>()
    let total = 0
    return value.sources.every(source => {
      if (!plain(source) || !keys(source, ['id', 'url', 'retrievedAt', 'text']) ||
        !text(source.id, 4) || !/^S[1-9]\d{0,2}$/.test(source.id) || ids.has(source.id) ||
        !text(source.url, 2048) || !text(source.text, 6000) || !Number.isSafeInteger(source.retrievedAt) ||
        typeof source.retrievedAt !== 'number' || source.retrievedAt <= 0 || source.retrievedAt > Date.now() + 30_000) return false
      const url = new URL(source.url)
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !url.hostname.includes('.') ||
        url.hostname.includes(':') || /^\d+(?:\.\d+){3}$/.test(url.hostname) ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname) ||
        containsSensitiveResearchText(decodeURIComponent(url.href))) return false
      ids.add(source.id); total += source.text.length
      return total <= 18_000
    })
  } catch { return false }
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max &&
    !containsSensitiveResearchText(value)
}
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, expected: string[]) {
  const found = Object.keys(value)
  return found.length === expected.length && found.every(key => expected.includes(key))
}
