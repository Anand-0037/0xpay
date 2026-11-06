import { useRef, useState } from 'react'
import { pastePhrase, phraseWords } from './phrase-input.ts'

export function RecoveryPhraseInput({ onChange, disabled = false }: { onChange: (phrase: string) => void; disabled?: boolean }) {
  const [count, setCount] = useState<12 | 24>(12)
  const [words, setWords] = useState<string[]>(() => Array<string>(24).fill(''))
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState('')
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  const commit = (next: string[], nextCount = count) => { setWords(next); onChange(next.slice(0, nextCount).join(' ')); setError('') }
  return <fieldset className="recovery-input" disabled={disabled}>
    <legend>Recovery phrase</legend>
    <div className="recovery-input-controls"><label>Phrase length <select value={count} onChange={event => {
      const next = Number(event.currentTarget.value) as 12 | 24
      if (next === 12 && words.slice(12).some(Boolean)) { setError('Clear words 13–24 before switching to 12 words.'); return }
      setCount(next); onChange(words.slice(0, next).join(' ')); setError('')
    }}><option value={12}>12 words</option><option value={24}>24 words</option></select></label><button type="button" onClick={() => setVisible(value => !value)} aria-pressed={visible}>{visible ? 'Hide words' : 'Show words'}</button></div>
    <div className="recovery-input-grid">{words.slice(0, count).map((word, index) => <label key={index}><span>{index + 1}</span><input
      ref={element => { inputs.current[index] = element }} aria-label={`Recovery word ${index + 1}`}
      type={visible ? 'text' : 'password'} value={word} required autoComplete="off" autoCapitalize="none" spellCheck={false}
      onChange={event => { const next = [...words]; next[index] = event.currentTarget.value.trim().toLowerCase(); commit(next) }}
      onPaste={event => {
        const text = event.clipboardData.getData('text'), pasted = phraseWords(text)
        event.preventDefault()
        try {
          const nextCount = index === 0 && pasted.length === 24 ? 24 : count
          const result = pastePhrase(words.slice(0, nextCount), index, text)
          const next = [...words]; result.words.forEach((value, position) => { next[position] = value })
          setCount(nextCount); commit(next, nextCount); queueMicrotask(() => inputs.current[result.focus]?.focus())
        } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not paste recovery words') }
      }}
      onKeyDown={event => {
        if ((event.key === ' ' || event.key === 'Enter') && word) { event.preventDefault(); inputs.current[Math.min(index + 1, count - 1)]?.focus() }
        if (event.key === 'Backspace' && !word && index > 0) { event.preventDefault(); inputs.current[index - 1]?.focus() }
      }}
    /></label>)}</div>
    <small>Words stay on this device. Paste a full phrase into the first box, or use Space to move to the next.</small>
    {error && <p className="wallet-error" role="alert">{error}</p>}
  </fieldset>
}
