import { useState } from 'react'
import { RecoveryPhraseInput } from './RecoveryPhraseInput.tsx'
import { confirmWalletBackup, createLocalWallet, hasStoredVault, importLocalWallet, lockLocalWallet, unlockLocalWallet, type WalletSession } from './lifecycle.ts'

export function WalletPanel({ session, onSession, blockNumber, children }: { session: WalletSession | null; onSession: (session: WalletSession | null) => void; blockNumber: number | null; children?: React.ReactNode }) {
  const [mode, setMode] = useState<'create' | 'import' | 'unlock'>(() => hasStoredVault() ? 'unlock' : 'create')
  const [password, setPassword] = useState('')
  const [phrase, setPhrase] = useState('')
  const [recovery, setRecovery] = useState('')
  const [pendingSession, setPendingSession] = useState<WalletSession | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (recovery) return <section className="wallet-panel wallet-recovery" aria-labelledby="recovery-title">
    <p className="eyebrow">ONE LAST STEP</p><h1 id="recovery-title">Save your recovery phrase.</h1>
    <p>Anyone with these words can access your public wallet. Save them somewhere private before continuing.</p>
    <code className="recovery-words">{recovery}</code>
    <button className="primary" onClick={() => {
      try {
        if (!pendingSession) throw new Error('Wallet session is unavailable; reload and unlock before continuing')
        confirmWalletBackup(pendingSession.id)
        onSession({ ...pendingSession, backupConfirmed: true })
        setPendingSession(null); setRecovery(''); setError('')
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    }}>I saved it</button>
    {error && <p className="wallet-error" role="alert">Could not save backup confirmation: {error}</p>}
  </section>

  if (session) return <><div className="wallet-status"><span>Public wallet · <code>{session.publicAddress}</code></span><button onClick={() => { void lockLocalWallet().then(() => onSession(null)) }}>Lock wallet</button></div>{children}</>

  return <section className="wallet-panel wallet-onboarding" aria-labelledby="setup-title">
    <div className="wallet-intro">
      <p className="eyebrow">0xPAY · PRIVATE PAYMENTS</p>
      <h1>Make a payment.<br /><span>Keep your path private.</span></h1>
      <p className="wallet-intro-lead">Create a local wallet, deposit fixed 0.1 ETH notes, then send to any address. A fresh 0 ETH key submits each private claim while the pool pays the gas.</p>
      <ol className="wallet-journey"><li><span>01</span><div><strong>Fund privately</strong><p>Your deposit is public; your note is stored encrypted here.</p></div></li><li><span>02</span><div><strong>Send in one flow</strong><p>Review what is private, what is public, and who pays gas.</p></div></li><li><span>03</span><div><strong>Follow the evidence</strong><p>The app shows real mempool responses and inclusion status.</p></div></li></ol>
    </div>
    <div className="wallet-setup-card">
      <p className="eyebrow">GET STARTED</p><h2 id="setup-title">{mode === 'unlock' ? 'Welcome back' : mode === 'import' ? 'Import your wallet' : 'Create your wallet'}</h2>
      <p className="wallet-setup-copy">{mode === 'unlock' ? 'Unlock your encrypted wallet on this device.' : mode === 'import' ? 'Use your recovery phrase to restore access.' : 'Your keys stay encrypted in this browser. Save your recovery phrase after creating the wallet.'}</p>
      {mode !== 'unlock' && <div className="wallet-tabs" role="group" aria-label="Wallet setup"><button type="button" aria-pressed={mode === 'create'} onClick={() => { setMode('create'); setError('') }}>Create new</button><button type="button" aria-pressed={mode === 'import'} onClick={() => { setMode('import'); setError('') }}>Import wallet</button></div>}
      <form className="wallet-form" onSubmit={async event => {
        event.preventDefault(); setBusy(true); setError('')
        try {
          if (mode === 'create') { const result = await createLocalWallet(password, blockNumber ?? 0); setPendingSession(result.session); setRecovery(result.recoveryPhrase) }
          else if (mode === 'import') onSession(await importLocalWallet(phrase, password))
          else onSession(await unlockLocalWallet(password))
          setPassword(''); setPhrase('')
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
      }}>
        {mode === 'import' && <RecoveryPhraseInput onChange={setPhrase} disabled={busy} />}
        <label>Password <small>At least 12 characters</small><input type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={12} required autoComplete={mode === 'unlock' ? 'current-password' : 'new-password'} /></label>
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Working…' : mode === 'unlock' ? 'Unlock wallet' : mode === 'import' ? 'Import wallet' : 'Create wallet'}</button>
      </form>
      {error && <p className="wallet-error" role="alert">{error}</p>}
      <small className="wallet-setup-connection">Private RPC is required for wallet reads and transactions. This is a devnet prototype.</small>
      <p className="wallet-setup-footnote">Devnet only · DEV trusted setup · Unaudited</p>
    </div>
  </section>
}
