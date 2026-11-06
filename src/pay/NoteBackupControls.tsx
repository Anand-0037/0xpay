import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { PayApi } from './types'

/** Passwords and files stay in this mounted dialog; only encrypted JSON is downloaded. */
export default function NoteBackupControls({ api, paymentBusy, onRestored }: { api: PayApi; paymentBusy: boolean; onRestored: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const lifecycle = useRef({ version: 0 })
  const [mode, setMode] = useState<'export' | 'restore'>('export')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const primary = { background: 'var(--px-accent)', color: 'var(--px-accent-ink)', border: '1px solid var(--px-accent)', fontSize: '14px' }
  const secondary = { background: 'var(--px-surface-2)', color: 'var(--px-ink)', border: '1px solid var(--px-line)', fontSize: '14px' }
  useEffect(() => {
    const element = dialog.current
    const state = lifecycle.current
    const ticket = ++state.version
    queueMicrotask(() => {
      if (state.version !== ticket) return
      setPassword(''); setConfirmation(''); setFile(null); setMessage(''); setError(''); setWorking(false)
    })
    return () => { state.version++; element?.close() }
  }, [api])
  if (!api.exportNoteBackup && !api.restoreNoteBackup) return null
  const clear = () => { setPassword(''); setConfirmation(''); setFile(null); setMessage(''); setError('') }
  const open = () => { if (!paymentBusy) { lifecycle.current.version++; clear(); setWorking(false); dialog.current?.showModal() } }
  const close = () => { if (!working) { lifecycle.current.version++; dialog.current?.close(); clear() } }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (working || paymentBusy) return
    const ticket = ++lifecycle.current.version
    setError(''); setMessage(''); setWorking(true)
    try {
      if (mode === 'export') {
        if (!api.exportNoteBackup) throw new Error('Note export is unavailable')
        if (password !== confirmation) throw new Error('Backup passwords do not match')
        const backup = await api.exportNoteBackup(password)
        if (lifecycle.current.version !== ticket) return
        const url = URL.createObjectURL(new Blob([backup.contents], { type: 'application/json' }))
        const anchor = document.createElement('a')
        anchor.href = url; anchor.download = `0xpay-private-notes-${new Date().toISOString().slice(0, 10)}.json`
        document.body.append(anchor); anchor.click(); anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        setMessage(`Encrypted backup prepared: ${backup.noteCount} ${backup.noteCount === 1 ? 'note' : 'notes'}. Save the downloaded file and keep its password safe.`)
      } else {
        if (!api.restoreNoteBackup || !file) throw new Error('Choose your encrypted note backup')
        if (file.size > 3 * 1024 * 1024) throw new Error('Note backup file is too large')
        const contents = await file.text()
        if (lifecycle.current.version !== ticket) return
        const result = await api.restoreNoteBackup(contents, password)
        if (lifecycle.current.version !== ticket) return
        setMessage(`Merged ${result.added} new ${result.added === 1 ? 'note' : 'notes'}; ${result.existing} already present. Unconfirmed notes stay unavailable until checked onchain.`)
        onRestored()
      }
      setPassword(''); setConfirmation('')
    } catch (caught) {
      if (lifecycle.current.version === ticket) setError(caught instanceof Error ? caught.message : 'Could not process this note backup')
    } finally { if (lifecycle.current.version === ticket) setWorking(false) }
  }
  return <>
    <button type="button" disabled={paymentBusy} onClick={open}>Back up / restore notes</button>
    <dialog ref={dialog} aria-labelledby="note-backup-title" onCancel={event => { if (working) event.preventDefault(); else clear() }} style={{ width: 'min(92vw, 560px)', maxHeight: '90vh', overflow: 'auto', padding: '28px', borderRadius: '18px', border: '1px solid var(--px-line)', background: 'var(--px-surface)', color: 'var(--px-ink)' }}>
      <h2 id="note-backup-title" style={{ margin: '0 0 12px', fontSize: '25px' }}>Private-note backup</h2>
      <p style={{ fontSize: '14px', lineHeight: 1.6, color: 'var(--px-muted)' }}>Recovery words restore your wallet address, not its private notes. Save an encrypted note backup separately. Restore it after unlocking the original wallet.</p>
      <div style={{ display: 'flex', gap: '10px', margin: '20px 0' }}>
        <button type="button" disabled={working || !api.exportNoteBackup} className="px-button" style={mode === 'export' ? primary : secondary} aria-pressed={mode === 'export'} onClick={() => { if (mode !== 'export') { setMode('export'); clear() } }}>Back up</button>
        <button type="button" disabled={working || !api.restoreNoteBackup} className="px-button" style={mode === 'restore' ? primary : secondary} aria-pressed={mode === 'restore'} onClick={() => { if (mode !== 'restore') { setMode('restore'); clear() } }}>Restore</button>
      </div>
      <form onSubmit={event => void submit(event)} style={{ display: 'grid', gap: '12px', fontSize: '14px' }}>
        {mode === 'restore' && <><label htmlFor="note-backup-file">Encrypted note backup</label><input id="note-backup-file" disabled={working} type="file" accept="application/json,.json" required onChange={event => setFile(event.target.files?.[0] ?? null)} /></>}
        <label htmlFor="note-backup-password">{mode === 'export' ? 'Choose a backup password' : 'Backup password'}</label>
        <input id="note-backup-password" className="px-input" style={{ fontSize: '14px' }} type="password" autoComplete={mode === 'export' ? 'new-password' : 'current-password'} disabled={working} minLength={12} maxLength={1024} required value={password} onChange={event => setPassword(event.target.value)} />
        {mode === 'export' && <><label htmlFor="note-backup-confirmation">Confirm backup password</label><input id="note-backup-confirmation" className="px-input" style={{ fontSize: '14px' }} type="password" autoComplete="new-password" disabled={working} minLength={12} maxLength={1024} required value={confirmation} onChange={event => setConfirmation(event.target.value)} /></>}
        <small style={{ color: 'var(--px-muted)', lineHeight: 1.6 }}>At least 12 characters. The file is encrypted locally and is not uploaded. Make a new backup after adding notes or sending a payment.</small>
        {error && <p role="alert" style={{ color: '#e58e81', overflowWrap: 'anywhere' }}>{error}</p>}
        {message && <p role="status" style={{ lineHeight: 1.6 }}>{message}</p>}
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '8px' }}>
          <button className="px-button" style={primary} type="submit" disabled={working || paymentBusy}>{working ? 'Processing backup…' : mode === 'export' ? 'Download encrypted backup' : 'Restore notes'}</button>
          <button className="px-button" style={secondary} type="button" disabled={working} onClick={close}>Close</button>
        </div>
      </form>
    </dialog>
  </>
}
