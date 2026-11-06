import { useEffect, useState } from 'react'
import { JsonRpcProvider, formatEther } from 'ethers'
import { APP_RPC_URL } from '../rpc'
import { ShieldPanel } from './ShieldPanel'
import { SendPanel } from './SendPanel'
import { PrivateBalance } from './PrivateBalance'
import { ActivityPanel } from './ActivityPanel'
import {
  browserWalletAvailable, connectInjectedWallet, forgetInjectedWallet, watchInjectedWallet,
  type InjectedAccount,
} from './injected'
import {
  createLocalWallet, hasStoredVault, importLocalWallet, lockLocalWallet, unlockLocalWallet,
  type WalletSession,
} from './lifecycle'

type Props = {
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

export function WalletPanel({ blockNumber, engineReady, shieldFeeBasisPoints, connectionFailed, onRetry, session, onSession }: Props) {
  const [view, setView] = useState<'connect' | 'private'>('connect')
  const [mode, setMode] = useState<'create' | 'import' | 'unlock'>(() => hasStoredVault() ? 'unlock' : 'create')
  const [password, setPassword] = useState('')
  const [phrase, setPhrase] = useState('')
  const [recoveryPhrase, setRecoveryPhrase] = useState('')
  const [showRecovery, setShowRecovery] = useState(false)
  const [challenge, setChallenge] = useState<number[]>([])
  const [answers, setAnswers] = useState<string[]>(['', '', ''])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fundingBalance, setFundingBalance] = useState<FundingBalance>(null)
  const [balanceRefresh, setBalanceRefresh] = useState(0)
  const [privateBalanceRefresh, setPrivateBalanceRefresh] = useState(0)
  const [, setActivityRefresh] = useState(0)
  const [injected, setInjected] = useState<InjectedAccount | null>(null)
  const [connectingInjected, setConnectingInjected] = useState(false)
  const [injectedError, setInjectedError] = useState('')

  useEffect(() => {
    if (!injected) return
    return watchInjectedWallet(() => {
      void import('../railgun/shield').then(({ discardShieldQuote }) => discardShieldQuote())
      void import('../railgun/send').then(({ discardPrivateSendQuote }) => discardPrivateSendQuote())
      setInjected(null)
      setFundingBalance(null)
      setInjectedError('Browser wallet changed. Connect it again to use that account.')
    })
  }, [injected])

  const publicAddress = injected?.address ?? session?.publicAddress
  const routeReady = blockNumber !== null && !connectionFailed
  const balanceForSource = fundingBalance?.address === publicAddress ? fundingBalance : null
  const balanceLabel = !routeReady ? 'Private route unavailable'
    : !balanceForSource ? 'Reading balance…'
      : balanceForSource.status === 'ready' ? `${formatEther(balanceForSource.wei)} ETH` : 'Balance read failed'
  useEffect(() => {
    if (!publicAddress || !routeReady) return
    const address = publicAddress
    const provider = new JsonRpcProvider(APP_RPC_URL, 11155111, { staticNetwork: true })
    let active = true
    async function readBalance() {
      try {
        const wei = await provider.getBalance(address)
        if (active) setFundingBalance({ address, status: 'ready', wei })
      } catch (cause) {
        if (active) setFundingBalance({
          address, status: 'error', message: cause instanceof Error ? cause.message : 'Balance read failed',
        })
      } finally {
        if (active) setTimeout(() => { if (active) void readBalance() }, 15_000)
      }
    }
    void readBalance()
    return () => {
      active = false
      provider.destroy()
    }
  }, [publicAddress, routeReady, balanceRefresh])

  async function connectBrowserWallet() {
    if (connectingInjected) return
    setConnectingInjected(true)
    setInjectedError('')
    try {
      const account = await connectInjectedWallet()
      setFundingBalance(null)
      setInjected(account)
    } catch (cause) {
      forgetInjectedWallet()
      setInjected(null)
      setFundingBalance(null)
      setInjectedError(cause instanceof Error ? cause.message : 'Could not connect browser wallet')
    } finally { setConnectingInjected(false) }
  }

  function selectLocalFunding() {
    void import('../railgun/shield').then(({ discardShieldQuote }) => discardShieldQuote())
    void import('../railgun/send').then(({ discardPrivateSendQuote }) => discardPrivateSendQuote())
    forgetInjectedWallet()
    setInjected(null)
    setFundingBalance(null)
    setInjectedError('')
  }

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
        onSession(await unlockLocalWallet(password))
      }
      setPassword('')
      setPhrase('')
    } catch (cause) {
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
      forgetInjectedWallet()
      setInjected(null)
      setFundingBalance(null)
      onSession(null)
      setRecoveryPhrase('')
      setShowRecovery(false)
      setAnswers(['', '', ''])
      setMode('unlock')
      setView('connect')
      setBusy(false)
    }
  }

  function confirmBackup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const words = recoveryPhrase.split(' ')
    if (challenge.some((position, index) => answers[index].trim().toLowerCase() !== words[position])) {
      setError('Those words did not match. Check your private backup and try again.')
      return
    }
    setRecoveryPhrase('')
    setShowRecovery(false)
    setAnswers(['', '', ''])
    setError('')
  }

  return <section className="wallet-panel" aria-labelledby="wallet-panel-heading">
    <div className="wallet-panel-heading"><div><p className="eyebrow">0XPAY WALLET</p><h2 id="wallet-panel-heading">{session ? 'Your Sepolia wallet' : view === 'connect' ? injected ? 'Browser wallet connected' : 'Connect your wallet' : mode === 'unlock' ? 'Unlock private balance' : 'Set up private balance'}</h2></div>{session && <button type="button" onClick={lock} disabled={busy}>Lock wallet</button>}</div>
    {session ? <>
      <div className="address-grid">
        <div><span>Private RAILGUN address</span><code>{session.railgunAddress}</code><button type="button" onClick={() => navigator.clipboard.writeText(session.railgunAddress)}>Copy private address</button></div>
        <div><span>{injected ? 'Browser wallet · Sepolia' : 'Local public funding address'}</span><code>{publicAddress}</code><button type="button" onClick={() => publicAddress && navigator.clipboard.writeText(publicAddress)}>Copy funding address</button><span>Sepolia ETH for gas</span><strong role={balanceForSource?.status === 'error' ? 'alert' : undefined}>{balanceLabel}</strong>{balanceForSource?.status === 'error' && routeReady && <small>{balanceForSource.message}</small>}<button type="button" disabled={!routeReady} onClick={() => { setFundingBalance(null); setBalanceRefresh((value) => value + 1) }}>Refresh balance</button>{injected ? <button type="button" onClick={selectLocalFunding}>Use local funding address</button> : <button type="button" onClick={connectBrowserWallet} disabled={connectingInjected || !browserWalletAvailable()}>{connectingInjected ? 'Connecting…' : 'Connect browser wallet'}</button>}{!injected && !browserWalletAvailable() && <small>No browser wallet detected</small>}{injectedError && <small role="alert">{injectedError}</small>}{injected && <small>Local public address: {session.publicAddress}</small>}</div>
      </div>
      <p>Use the public address for Sepolia ETH. Use the private address to receive shielded funds.</p>
      <PrivateBalance walletId={session.id} routeReady={routeReady && engineReady} refreshKey={privateBalanceRefresh} />
      {recoveryPhrase && <div className="recovery-box"><strong>Back up your recovery phrase</strong><p>Write these words down privately. They restore this wallet; anyone with them can move its funds. We hide them when you lock or reload.</p><button type="button" onClick={() => setShowRecovery((shown) => !shown)}>{showRecovery ? 'Hide recovery phrase' : 'Reveal recovery phrase'}</button>{showRecovery && <code className="recovery-words">{recoveryPhrase}</code>}<form onSubmit={confirmBackup} className="backup-check"><p>Confirm three words from your backup.</p>{challenge.map((position, index) => <label key={position}>Word {position + 1}<input type="text" value={answers[index]} onChange={(event) => setAnswers((current) => current.map((answer, i) => i === index ? event.target.value : answer))} autoComplete="off" spellCheck={false} required /></label>)}<button className="primary" type="submit">I saved my recovery phrase</button></form></div>}
      {injected && !recoveryPhrase && shieldFeeBasisPoints !== null && <ShieldPanel
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
      />}
      {injected && !recoveryPhrase && engineReady && <SendPanel
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
      {!recoveryPhrase && <ActivityPanel routeReady={routeReady} onRecheck={async (kind, transactionHash) => {
        const receipt = kind === 'shield'
          ? await (await import('../railgun/shield')).confirmEthShield(transactionHash)
          : await (await import('../railgun/send')).confirmPrivateWethSend(transactionHash)
        if (receipt.status === 'confirmed') setPrivateBalanceRefresh((value) => value + 1)
      }} />}
    </> : view === 'connect' ? <>
      <p>Connect a browser wallet on Sepolia for public funding. Your private balance uses a separate encrypted RAILGUN wallet.</p>
      {injected ? <>
        <div className="address-grid"><div><span>Connected public account</span><code>{injected.address}</code><span>Sepolia ETH for gas</span><strong role={balanceForSource?.status === 'error' ? 'alert' : undefined}>{balanceLabel}</strong>{balanceForSource?.status === 'error' && routeReady && <small>{balanceForSource.message}</small>}<button type="button" disabled={!routeReady} onClick={() => { setFundingBalance(null); setBalanceRefresh((value) => value + 1) }}>Refresh balance</button></div></div>
        <div className="wallet-tabs"><button className="primary" type="button" onClick={() => setView('private')}>{hasStoredVault() ? 'Unlock private balance' : 'Set up private balance'}</button><button type="button" onClick={selectLocalFunding}>Forget browser wallet</button></div>
      </> : <div className="wallet-tabs"><button className="primary" type="button" onClick={connectBrowserWallet} disabled={connectingInjected || !browserWalletAvailable()}>{connectingInjected ? 'Connecting…' : 'Connect browser wallet'}</button></div>}
      {!browserWalletAvailable() && <small>No browser wallet detected in this tab.</small>}
      {injectedError && <p className="wallet-error" role="alert">{injectedError}</p>}
      {!injected && <button type="button" onClick={() => setView('private')}>Use a local wallet instead</button>}
    </> : <>
      <button type="button" onClick={() => setView('connect')}>← Back to wallet connection</button>
      <p>{injected ? 'Your browser wallet will fund transactions. ' : ''}Create or unlock a separate RAILGUN wallet for the private balance. Its recovery phrase is encrypted in this browser with your password.</p>
      {!hasStoredVault() && <div className="wallet-tabs"><button type="button" aria-pressed={mode === 'create'} onClick={() => setMode('create')}>Create private wallet</button><button type="button" aria-pressed={mode === 'import'} onClick={() => setMode('import')}>Import private wallet</button></div>}
      <form onSubmit={submit} className="wallet-form">
        {mode === 'import' && <label>Recovery phrase<textarea value={phrase} onChange={(event) => setPhrase(event.target.value)} autoComplete="off" spellCheck={false} required placeholder="Enter your 12 or 24 words" /></label>}
        <label>Local password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'unlock' ? 'current-password' : 'new-password'} minLength={12} required placeholder="At least 12 characters" /></label>
        <button className="primary" type="submit" disabled={!engineReady || busy}>{busy ? 'Working…' : mode === 'create' ? 'Create wallet' : mode === 'import' ? 'Import wallet' : 'Unlock wallet'}</button>
      </form>
      {connectionFailed ? <div className="wallet-error" role="alert">Private connection failed. <button type="button" onClick={onRetry}>Retry connection</button></div> : !engineReady && <small>Preparing private connection…</small>}
    </>}
    {error && <p className="wallet-error" role="alert">{error}</p>}
  </section>
}
