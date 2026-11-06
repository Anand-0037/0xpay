export function phraseWords(text: string): string[] {
  return text.normalize('NFKD').trim().toLowerCase().split(/\s+/).filter(Boolean)
}
export function pastePhrase(current: readonly string[], start: number, text: string) {
  const incoming = phraseWords(text)
  if (!Number.isInteger(start) || start < 0 || start >= current.length || incoming.length > current.length - start) throw new Error('Recovery words do not fit. Choose 24 words for a 24-word phrase.')
  const next = [...current]
  incoming.forEach((word, index) => { next[start + index] = word })
  return { words: next, focus: Math.min(start + incoming.length, current.length - 1) }
}
