import { useId, useRef, useState } from 'react'

type Props = { value: string; onChange: (phrase: string) => void; disabled?: boolean }

export function RecoveryPhraseInput({ value, onChange, disabled = false }: Props) {
  const id = useId()
  const fields = useRef<HTMLFieldSetElement>(null)
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState('')
  // Spaces preserve empty numbered slots. The lifecycle validates the complete
  // BIP-39 phrase before restoring; no draft words are written to storage here.
  const entered = value === '' ? [] : value.split(' ')
  const count = entered.length > 12 ? 24 : 12
  const words = Array.from({ length: count }, (_, index) => entered[index] ?? '')

  function focusWord(index: number) {
    fields.current?.querySelector<HTMLInputElement>(`[data-word-index="${index}"]`)?.focus()
  }
  function editWord(index: number, next: string) {
    if (next.length > 32 || !/^[a-z]*$/i.test(next)) {
      setError('Enter one word in each field, or paste a complete 12- or 24-word phrase.')
      return
    }
    const updated = [...words]
    updated[index] = next.toLowerCase()
    onChange(updated.join(' '))
    setError('')
  }
  function selectCount(next: number) {
    if (next !== 12 && next !== 24) return
    if (next === 12 && words.slice(12).some(Boolean)) {
      setError('Clear words 13–24 before switching to 12 words. Your entries have been kept.')
      return
    }
    onChange(Array.from({ length: next }, (_, index) => words[index] ?? '').join(' '))
    setError('')
  }
  function paste(event: React.ClipboardEvent<HTMLInputElement>, index: number) {
    // Only an explicit user paste event reads clipboard data. Never request
    // clipboard permissions or include phrase contents in an error message.
    const clipboardText = event.clipboardData.getData('text')
    event.preventDefault()
    if (clipboardText.length > 1_024) {
      setError('Paste exactly 12 or 24 recovery words. Your existing entries have been kept.')
      return
    }
    const pasted = clipboardText.trim().toLowerCase().split(/\s+/)
    if (pasted.length === 1 && /^[a-z]+$/.test(pasted[0])) {
      editWord(index, pasted[0])
      focusWord(Math.min(index + 1, count - 1))
      return
    }
    if (![12, 24].includes(pasted.length) || pasted.some(word => word.length > 32 || !/^[a-z]+$/.test(word))) {
      setError('Paste exactly 12 or 24 recovery words. Your existing entries have been kept.')
      return
    }
    onChange(pasted.join(' '))
    setError('')
    focusWord(0)
  }

  return <fieldset className="recovery-input" ref={fields} disabled={disabled} aria-describedby={`${id}-privacy${error ? ` ${id}-error` : ''}`}>
    <legend>Recovery phrase</legend>
    <div className="recovery-input-toolbar"><label htmlFor={`${id}-count`}>Number of words<select id={`${id}-count`} value={count} onChange={event => selectCount(Number(event.target.value))}><option value={12}>12 words</option><option value={24}>24 words</option></select></label>
      <button type="button" aria-pressed={revealed} aria-controls={`${id}-words`} onClick={() => setRevealed(current => !current)}>{revealed ? 'Hide words' : 'Reveal words'}</button></div>
    <p id={`${id}-privacy`} className="recovery-input-privacy">Keep your screen private. Stop screen sharing before entering or revealing recovery words.</p>
    <div id={`${id}-words`} className="recovery-input-grid">{words.map((word, index) => <label key={index} htmlFor={`${id}-word-${index}`}><span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><input id={`${id}-word-${index}`} data-word-index={index} aria-label={`Word ${index + 1}`} type={revealed ? 'text' : 'password'} value={word} onChange={event => editWord(index, event.target.value)}
      onPaste={event => paste(event, index)} onKeyDown={event => {
        if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); focusWord(Math.min(index + 1, count - 1)) }
        else if (event.key === 'Backspace' && word === '' && index > 0) { event.preventDefault(); focusWord(index - 1) }
      }} maxLength={32} autoComplete="off" autoCapitalize="none" spellCheck={false} autoCorrect="off" data-lpignore="true" data-1p-ignore="true" required /></label>)}</div>
    <p className="recovery-input-help">Type one word per box. Space or Enter moves forward. You can paste a complete phrase into any box.</p>
    {error && <p id={`${id}-error`} className="recovery-input-error" role="alert">{error}</p>}
  </fieldset>
}
