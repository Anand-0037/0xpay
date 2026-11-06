import { useCallback, useEffect, useState } from 'react'
import { JsonRpcProvider, formatEther } from 'ethers'
import { APP_RPC_URL } from '../rpc'
import { formatDisplayBalance } from '../domain/format-display'
import { ShieldPanel } from './ShieldPanel'
import { SendPanel } from './SendPanel'
import { PrivateBalance } from './PrivateBalance'
import { ActivityPanel } from './ActivityPanel'
import { WalletIntro } from '../ui/WalletIntro'
import {
  createLocalWallet, hasStoredVault, importLocalWallet, lockLocalWallet, unlockLocalWallet,
  recoveryPhraseForBackup, confirmWalletBackup, unlockedWalletId, unlockedSessionVersion,
  type WalletSession,
} from './lifecycle'

type Props = {
  routeVersion?: number
  blockNumber: number | null
  engineReady: boolean
  shieldFeeBasisPoints: bigint | null
  connectionFailed: boolean
  onRetry: () => void
  session: WalletSession | null
  onSession: (session: WalletSession | null) => void
}

type FundingBalance =
  | { address: string; status: 'ready'; wei: bigint }
  | { address: string; status: 'error'; message: string }
  | null

export function WalletPanel({ routeVersion = 0, blockNumber, engineReady, shieldFeeBasisPoints, connectionFailed, onRetry, session, onSession }: Props) {
  const [mode, setMode] = useState<'create' | 'import' | 'unlock'>(() => hasStoredVault() ? 'unlock' : 'create')
  const [password, setPassword] = useState('')
  const [phrase, setPhrase] = useState('')
  const [recoveryPhrase, setRecoveryPhrase] = useState('')
  const [showRecovery, setShowRecovery] = useState(false)
  const [challenge, setChallenge] = useState<number[]>([])
  const [answers, setAnswers] = useState<string[]>(['', '', ''])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copiedAddress, setCopiedAddress] = useState('')
  const [fundingBalance, setFundingBalance] = useState<FundingBalance>(null)
  const [balanceRefresh, setBalanceRefresh] = useState(0)
  const [privateBalanceRefresh, setPrivateBalanceRefresh] = useState(0)
  const [, setActivityRefresh] = useState(0)
  const [privateWeth, setPrivateWeth] = useState<{ walletId: string; amount: bigint; sessionVersion?: number; routeVersion: number } | null>(null)
  const sessionVersion = session?.generation
  const observeSpendable = useCallback((walletId: string, amount: bigint) => setPrivateWeth({ walletId, amount, sessionVersion, routeVersion }), [sessionVersion, routeVersion])

  useEffect(() => {
    if (!session) return
    const changed = (event: StorageEvent) => {
      if (event.key !== null && event.key !== '0xpay.vault.v1') return
      try { if (unlockedWalletId() === session.id) return } catch { /* identity changed */ }
      setRecoveryPhrase('')
      setAnswers(['', '', ''])
      setPassword('')
      setPhrase('')
      setShowRecovery(false)
      onSession(null)
      setMode(hasStoredVault() ? 'unlock' : 'create')
      setError('Wallet storage changed in another tab. Unlock the current wallet to continue.')
      void lockLocalWallet().catch(() => setError('Wallet storage changed. Close this tab before continuing.'))
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [session, onSession])

  const publicAddress = session?.publicAddress
  const copyPrefix = session ? `${session.id}:${session.generation}:` : ''
  const routeReady = blockNumber !== null && !connectionFailed
  const balanceForSource = fundingBalance?.address === publicAddress ? fundingBalance : null
  const hasGas = balanceForSource?.status === 'ready' && balanceForSource.wei > 0n
  const spendable = privateWeth?.walletId === session?.id && privateWeth?.sessionVersion === sessionVersion && privateWeth?.routeVersion === routeVersion ? privateWeth?.amount : undefined
  const balanceLabel = !routeReady ? 'Private route unavailable'
    : !balanceForSource ? 'Reading balance…'
      : balanceForSource.status === 'ready' ? `${formatDisplayBalance(balanceForSource.wei)} ETH` : 'Balance read failed'
  useEffect(() => {
    if (!publicAddress || !routeReady) return
    const address = publicAddress
    const provider = new JsonRpcProvider(APP_RPC_URL, 11155111, { staticNetwork: true })
    let active = true
    const polling: { timer?: ReturnType<typeof setTimeout> } = {}
    async function readBalance() {
      try {
        const wei = await provider.getBalance(address)
        if (active) setFundingBalance({ address, status: 'ready', wei })
      } catch (cause) {
        if (active) setFundingBalance({
          address, status: 'error', message: cause instanceof Error ? cause.message : 'Balance read failed',
        })
      } finally {
        if (active) polling.timer = setTimeout(() => { if (active) void readBalance() }, 15_000)
      }
    }
    void readBalance()
    return () => {
      active = false
      if (polling.timer) clearTimeout(polling.timer)
      provider.destroy()
    }
  }, [publicAddress, routeReady, balanceRefresh])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!engineReady || blockNumber === null || busy) return
    setBusy(true)
    setError('')
    try {
      if (mode === 'create') {
        const result = await createLocalWallet(password, blockNumber)
        setRecoveryPhrase(result.recoveryPhrase)
        const positions = Array.from({ length: result.recoveryPhrase.split(' ').length }, (_, index) => index)
        for (let index = positions.length - 1; index > 0; index--) {
          const random = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1)
          ;[positions[index], positions[random]] = [positions[random], positions[index]]
        }
        setChallenge(positions.slice(0, 3).sort((a, b) => a - b))
        onSession(result.session)
      } else if (mode === 'import') {
        onSession(await importLocalWallet(phrase, password))
      } else {
        const unlocked = await unlockLocalWallet(password)
        if (!unlocked.backupConfirmed) {
          try {
            setRecoveryPhrase(await recoveryPhraseForBackup(password))
            setChallenge([0, 4, 8])
            setAnswers(['', '', ''])
          } catch (cause) { await lockLocalWallet(); throw cause }
        }
        onSession(unlocked)
      }
      setPassword('')
      setPhrase('')
    } catch (cause) {
      if (hasStoredVault()) setMode('unlock')
      setError(cause instanceof Error ? cause.message : 'Wallet action failed')
    } finally {
      setBusy(false)
    }
  }

  async function lock() {
    setBusy(true)
    setError('')
    try {
      await lockLocalWallet()
      const { discardShieldQuote } = await import('../railgun/shield')
      discardShieldQuote()
      const { discardPrivateSendQuote } = await import('../railgun/send')
      discardPrivateSendQuote()
    } catch (cause) {
      setError(`Wallet cleanup failed. Close this tab before using the wallet again. ${cause instanceof Error ? cause.message : ''}`)
    } finally {
      setFundingBalance(null)
      onSession(null)
      setRecoveryPhrase('')
      setShowRecovery(false)
      setAnswers(['', '', ''])
      setMode('unlock')
      setBusy(false)
    }
  }

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address)
      setCopiedAddress(`${copyPrefix}${address}`)
    } catch { setError('Could not copy this address. Select the address and copy it manually.') }
  }

  function confirmBackup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const words = recoveryPhrase.split(' ')
    if (challenge.some((position, index) => answers[index].trim().toLowerCase() !== words[position])) {
      setError('Those words did not match. Check your private backup and try again.')
      return
    }
    if (!session) return
    try {
      confirmWalletBackup(session.id)
      onSession({ ...session, backupConfirmed: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save backup confirmation')
      return
    }
    setRecoveryPhrase('')
    setShowRecovery(false)
    setAnswers(['', '', ''])
    setError('')
  }

  return <section className={`wallet-panel${session ? ' wallet-active' : ' wallet-onboarding'}`} aria-labelledby="wallet-panel-heading">
    {!session && <WalletIntro />}
    <div className={session ? 'wallet-content' : 'wallet-setup-card'}>
    <div className="wallet-panel-heading"><div><p className="eyebrow">{session ? '0XPAY WALLET' : mode === 'unlock' ? 'SAVED ON THIS DEVICE' : 'GET STARTED'}</p><h2 id="wallet-panel-heading">{session ? 'Your wallet' : mode === 'unlock' ? 'Welcome back' : mode === 'import' ? 'Restore your wallet' : 'Create your wallet'}</h2></div>{session && <button type="button" onClick={lock} disabled={busy}>Lock wallet</button>}</div>
    {session ? <>
      {session.backupConfirmed && <PrivateBalance walletId={session.id} routeReady={routeReady && engineReady} refreshKey={privateBalanceRefresh} onSpendable={observeSpendable} />}
      {session.backupConfirmed && <details className="receive-details"><summary>Receive private funds <span>0zk address</span></summary><p>Share this address to receive shielded funds from another RAILGUN wallet.</p><code>{session.railgunAddress}</code><button type="button" onClick={() => void copyAddress(session.railgunAddress)}>{copiedAddress === `${copyPrefix}${session.railgunAddress}` ? 'Copied' : 'Copy private address'}</button></details>}
      {session.backupConfirmed && !recoveryPhrase && hasGas && spendable !== undefined && spendable > 0n && routeReady && engineReady && <SendPanel key={`send:${session.id}`}
        onQuote={async (recipientAddress, amountWei) => {
          const { quotePrivateWethSend } = await import('../railgun/send')
          return quotePrivateWethSend(amountWei, recipientAddress)
        }}
        onSubmit={async (quote, onProofProgress) => {
          const { submitPrivateWethSend } = await import('../railgun/send')
          const result = await submitPrivateWethSend(quote, onProofProgress)
          setActivityRefresh((value) => value + 1)
          return result
        }}
        onConfirm={async (transactionHash) => {
          const { confirmPrivateWethSend } = await import('../railgun/send')
          const receipt = await confirmPrivateWethSend(transactionHash)
          setActivityRefresh((value) => value + 1)
          if (receipt.status === 'confirmed') setPrivateBalanceRefresh((value) => value + 1)
          return receipt
        }}
      />}
      {session.backupConfirmed && <div className="wallet-overview">
        <details className="funding-details" open={!hasGas}><summary>Network fees &amp; funding <span>{hasGas ? balanceLabel : 'Add Sepolia ETH'}</span></summary><div className="funding-card">
          <div className="funding-card-top"><div><span className="eyebrow">PUBLIC FUNDING WALLET</span><h3>{balanceForSource?.status === 'ready' && !hasGas ? 'Add Sepolia test ETH' : 'Sepolia ETH'}</h3></div><button className="quiet-action" type="button" disabled={!routeReady} onClick={() => { setFundingBalance(null); setBalanceRefresh((value) => value + 1) }}>Refresh</button></div>
          <strong className="funding-amount" role={balanceForSource?.status === 'error' ? 'alert' : undefined}>{balanceLabel}</strong>{balanceForSource?.status === 'ready' && <details className="exact-balance"><summary>Exact balance</summary><code>{formatEther(balanceForSource.wei)} ETH</code></details>}
          {balanceForSource?.status === 'error' && routeReady && <small className="wallet-error">{balanceForSource.message}</small>}
          <p>Use this public address for the shield amount and network fees.</p>
          <code className="funding-address">{publicAddress}</code>
          <div className="funding-actions"><button type="button" onClick={() => publicAddress && void copyAddress(publicAddress)}>{copiedAddress === `${copyPrefix}${publicAddress}` ? 'Copied' : 'Copy address'}</button>{!hasGas && <a className="button-link primary" href="https://ethglobal.com/faucet" target="_blank" rel="noopener noreferrer">Get test ETH <span aria-hidden="true">↗</span></a>}</div>
        </div></details>
      </div>}
      {session.backupConfirmed && <p className="wallet-privacy-note">Keys stay on this device. Blockchain requests use Anon-RPC; funding and the gas payer remain public.</p>}
      {recoveryPhrase && <div className="recovery-box"><strong>Back up your recovery phrase</strong><p>Write these words down privately. They restore this wallet; anyone with them can move its funds. We hide them when you lock or reload.</p><button type="button" onClick={() => setShowRecovery((shown) => !shown)}>{showRecovery ? 'Hide recovery phrase' : 'Reveal recovery phrase'}</button>{showRecovery && <code className="recovery-words">{recoveryPhrase}</code>}<form onSubmit={confirmBackup} className="backup-check"><p>Confirm three words from your backup.</p>{challenge.map((position, index) => <label key={position}>Word {position + 1}<input type="text" value={answers[index]} onChange={(event) => setAnswers((current) => current.map((answer, i) => i === index ? event.target.value : answer))} autoComplete="off" spellCheck={false} required /></label>)}<button className="primary" type="submit">I saved my recovery phrase</button></form></div>}
      {session.backupConfirmed && !recoveryPhrase && hasGas && routeReady && engineReady && shieldFeeBasisPoints !== null && <details open={spendable === 0n}><summary>Add funds to private balance</summary><ShieldPanel key={`shield:${session.id}`}
        onQuote={async (amountWei) => {
          const { quoteEthShield } = await import('../railgun/shield')
          return quoteEthShield(amountWei, session.railgunAddress, shieldFeeBasisPoints)
        }}
        onSubmit={async (quote) => {
          const { submitEthShield } = await import('../railgun/shield')
          const result = await submitEthShield(quote)
          setActivityRefresh((value) => value + 1)
          return result
        }}
        onConfirm={async (transactionHash) => {
          const { confirmEthShield } = await import('../railgun/shield')
          const receipt = await confirmEthShield(transactionHash)
          setActivityRefresh((value) => value + 1)
          if (receipt.status === 'confirmed') setPrivateBalanceRefresh((value) => value + 1)
          return receipt
        }}
      /></details>}

      {!recoveryPhrase && <ActivityPanel routeReady={routeReady} fundingAddress={session.publicAddress} onRebroadcast={async (hash) => {
        const { rebroadcastFundingTransaction } = await import('./funding')
        await rebroadcastFundingTransaction(hash, session.id, unlockedSessionVersion())
      }} onRecheck={async (kind, transactionHash) => {
        const receipt = kind === 'shield'
          ? await (await import('../railgun/shield')).confirmEthShield(transactionHash)
          : await (await import('../railgun/send')).confirmPrivateWethSend(transactionHash)
        if (receipt.status === 'confirmed') setPrivateBalanceRefresh((value) => value + 1)
      }} />}
    </> : <>
      <p className="wallet-setup-copy">{mode === 'unlock' ? 'Unlock the wallet saved in this browser.' : mode === 'import' ? 'Restore with your recovery words and set a password for this device.' : 'Choose a password to encrypt your wallet on this device.'}</p>
      {!hasStoredVault() && <div className="wallet-tabs"><button type="button" aria-pressed={mode === 'create'} onClick={() => setMode('create')}>Create wallet</button><button type="button" aria-pressed={mode === 'import'} onClick={() => setMode('import')}>Import wallet</button></div>}
      <form onSubmit={submit} className="wallet-form">
        {mode === 'import' && <label>Recovery phrase<textarea value={phrase} onChange={(event) => setPhrase(event.target.value)} autoComplete="off" spellCheck={false} required placeholder="Enter your 12 or 24 words" /></label>}
        <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'unlock' ? 'current-password' : 'new-password'} minLength={12} required placeholder="At least 12 characters" /></label>
        <button className="primary" type="submit" disabled={!engineReady || !routeReady || busy}>{busy ? 'Opening wallet…' : mode === 'create' ? 'Create wallet' : mode === 'import' ? 'Restore wallet' : 'Unlock wallet'}</button>
      </form>
      {connectionFailed ? <div className="wallet-setup-connection wallet-error" role="alert">Private connection failed. <button type="button" onClick={onRetry}>Reconnect</button></div> : !engineReady && <small className="wallet-setup-connection" role="status">{routeReady ? 'Preparing your wallet…' : 'Connecting your private route…'}</small>}
      <p className="wallet-setup-footnote">Ethereum Sepolia · Test ETH only</p>
    </>}
    {error && <p className="wallet-error" role="alert">{error}</p>}
    </div>
  </section>
}
