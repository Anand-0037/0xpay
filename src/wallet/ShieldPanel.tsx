import { useEffect, useRef, useState, type FormEvent } from 'react'
import { formatEther } from 'ethers'
import { parseEthAmount } from '../domain/amount'
import type { ShieldQuote, ShieldReceipt, ShieldSubmission } from '../railgun/shield'

export type ShieldPanelProps = {
  onQuote: (amountWei: bigint) => Promise<ShieldQuote>
  onSubmit: (quote: ShieldQuote) => Promise<ShieldSubmission>
  onConfirm: (transactionHash: string) => Promise<ShieldReceipt>
}

type Stage = 'draft' | 'quoting' | 'review' | 'submitting' | 'pending' | 'confirmed' | 'reverted' | 'unknown' | 'error'

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

function checkedQuote(requestedWei: bigint, quote: ShieldQuote): ShieldQuote {
  if (!quote.id.trim() || quote.amountWei !== requestedWei || quote.amountWei <= 0n ||
      quote.estimatedProtocolFeeWei < 0n || quote.maxNetworkFeeWei < 0n ||
      quote.estimatedProtocolFeeWei > quote.amountWei || quote.estimatedPrivateWethWei < 0n ||
      quote.estimatedPrivateWethWei > quote.amountWei ||
      quote.publicBalanceWei < 0n || !quote.sourceAddress || !quote.recipientAddress ||
      !Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= Date.now()) {
    throw new Error('The shield quote is incomplete or no longer matches this amount. Review again.')
  }
  if (quote.amountWei + quote.maxNetworkFeeWei > quote.publicBalanceWei) {
    throw new Error('Not enough Sepolia ETH for the shield amount and maximum network fee.')
  }
  return quote
}

function validHash(hash: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(hash)
}

function checkedConfirmation(hash: string, result: ShieldReceipt): ShieldReceipt {
  if (!validHash(result.transactionHash) || result.transactionHash.toLowerCase() !== hash.toLowerCase() ||
      (result.status !== 'unknown' && (!Number.isSafeInteger(result.blockNumber) || result.blockNumber <= 0))) {
    throw new Error('The transaction result does not match the submitted hash.')
  }
  return result
}

export function ShieldPanel({ onQuote, onSubmit, onConfirm }: ShieldPanelProps) {
  const [amount, setAmount] = useState('')
  const [stage, setStage] = useState<Stage>('draft')
  const [quote, setQuote] = useState<ShieldQuote | null>(null)
  const [transactionHash, setTransactionHash] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<ShieldReceipt | null>(null)
  const [error, setError] = useState('')
  const requestId = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; requestId.current += 1 }
  }, [])

  function editAmount(value: string) {
    requestId.current += 1
    setAmount(value)
    setQuote(null)
    setTransactionHash(null)
    setConfirmation(null)
    setError('')
    setStage('draft')
  }

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (stage === 'quoting' || stage === 'submitting' || stage === 'pending') return
    const currentId = ++requestId.current
    setQuote(null)
    setError('')
    try {
      const amountWei = parseEthAmount(amount)
      setStage('quoting')
      const result = checkedQuote(amountWei, await onQuote(amountWei))
      if (!mounted.current || requestId.current !== currentId) return
      setQuote(result)
      setStage('review')
    } catch (cause) {
      if (!mounted.current || requestId.current !== currentId) return
      setError(messageFrom(cause))
      setStage('draft')
    }
  }

  async function submit() {
    if (stage !== 'review' || !quote) return
    const currentId = ++requestId.current
    const reviewedQuote = quote
    setError('')
    setStage('submitting')
    try {
      const result = await onSubmit(reviewedQuote)
      if (!mounted.current || requestId.current !== currentId) return
      if (result.status !== 'submitted' || !validHash(result.transactionHash)) {
        throw new Error('The wallet did not return a valid transaction hash.')
      }
      setTransactionHash(result.transactionHash)
      setStage('pending')
      await checkConfirmation(result.transactionHash, currentId)
    } catch (cause) {
      if (!mounted.current || requestId.current !== currentId) return
      setError(messageFrom(cause))
      setStage('error')
    }
  }

  async function checkConfirmation(hash: string, currentId: number) {
    try {
      const finalResult = checkedConfirmation(hash, await onConfirm(hash))
      if (!mounted.current || requestId.current !== currentId) return
      setConfirmation(finalResult)
      setError(finalResult.status === 'unknown' ? finalResult.message : '')
      setStage(finalResult.status)
    } catch (cause) {
      if (!mounted.current || requestId.current !== currentId) return
      setError(messageFrom(cause))
      setStage('unknown')
    }
  }

  function retryConfirmation() {
    if (stage !== 'unknown' || !transactionHash) return
    const currentId = ++requestId.current
    setError('')
    setStage('pending')
    void checkConfirmation(transactionHash, currentId)
  }

  const requiredWei = quote ? quote.amountWei + quote.maxNetworkFeeWei : 0n

  return <section className="shield-panel" aria-labelledby="shield-heading">
    <p className="eyebrow">MOVE INTO PRIVATE BALANCE</p>
    <h2 id="shield-heading">Shield Sepolia ETH</h2>
    <p className="shield-explainer">Your public wallet sends ETH through RAILGUN Relay Adapt. It wraps to WETH and enters your private balance. The shield transaction and its amount are public.</p>

    {stage === 'confirmed' && confirmation?.status === 'confirmed' ? <div className="shield-result" role="status">
      <strong>Shield transaction confirmed</strong>
      <p>Included in Sepolia block {confirmation.blockNumber}. Your private WETH balance may take more time to sync.</p>
      <a href={`https://sepolia.etherscan.io/tx/${confirmation.transactionHash}`} target="_blank" rel="noopener noreferrer">View confirmed transaction ↗</a>
      <button type="button" onClick={() => editAmount('')}>Shield another amount</button>
    </div> : <>
      <form className="shield-form" onSubmit={review}>
        <label htmlFor="shield-eth-amount">Amount to shield</label>
        <div className="shield-amount-row"><input id="shield-eth-amount" type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(event) => editAmount(event.target.value)} disabled={stage === 'submitting' || stage === 'pending' || stage === 'unknown'} aria-describedby="shield-amount-help" /><span>ETH</span></div>
        <small id="shield-amount-help">Sepolia test ETH · up to 18 decimal places</small>
        <small>Reviewing asks your browser wallet to sign a RAILGUN setup message. It does not send a transaction.</small>
        {stage === 'draft' && <button className="primary" type="submit">Review shield</button>}
        {stage === 'quoting' && <p className="shield-progress" role="status">Getting a live quote…</p>}
      </form>

      {quote && (stage === 'review' || stage === 'submitting' || stage === 'pending' || stage === 'error' || stage === 'reverted' || stage === 'unknown') && <div className="shield-review" aria-labelledby="shield-review-heading">
        <div className="shield-review-heading"><h3 id="shield-review-heading">Review shield</h3><span>Sepolia</span></div>
        <dl>
          <div><dt>From public wallet</dt><dd className="shield-address">{quote.sourceAddress}</dd></div>
          <div><dt>To private wallet</dt><dd className="shield-address">{quote.recipientAddress}</dd></div>
          <div><dt>Shield amount</dt><dd>{formatEther(quote.amountWei)} ETH</dd></div>
          <div><dt>Estimated RAILGUN fee</dt><dd>{formatEther(quote.estimatedProtocolFeeWei)} WETH</dd></div>
          <div><dt>Estimated private balance</dt><dd>{formatEther(quote.estimatedPrivateWethWei)} WETH</dd></div>
          <div><dt>Maximum network fee</dt><dd>{formatEther(quote.maxNetworkFeeWei)} ETH</dd></div>
          <div className="shield-total"><dt>ETH needed, including maximum fee</dt><dd>{formatEther(requiredWei)} ETH</dd></div>
          <div><dt>Available in public wallet</dt><dd>{formatEther(quote.publicBalanceWei)} ETH</dd></div>
        </dl>
        <p>Fee and private balance are estimates. Your wallet will ask you to approve the public transaction.</p>
        <p>Review valid until {new Date(quote.expiresAt).toLocaleTimeString()}.</p>
        {stage === 'review' && <div className="shield-actions"><button type="button" onClick={() => { setQuote(null); setStage('draft') }}>Edit amount</button><button type="button" className="primary" onClick={() => void submit()}>Confirm in wallet</button></div>}
        {stage === 'submitting' && <p className="shield-progress" role="status">Waiting for wallet approval…</p>}
        {stage === 'pending' && <p className="shield-progress" role="status">Transaction submitted. Waiting for the Sepolia receipt…</p>}
        {transactionHash && <a className="shield-explorer" href={`https://sepolia.etherscan.io/tx/${transactionHash}`} target="_blank" rel="noopener noreferrer">View submitted transaction ↗</a>}
      </div>}

      {stage === 'error' && <div className="shield-error" role="alert"><strong>Shield not confirmed</strong><p>{error}</p><p>Check your wallet activity before starting another quote. A rejected request and an unconfirmed broadcast can look alike here.</p><button type="button" onClick={() => { setQuote(null); setError(''); setStage('draft') }}>Start a new review</button></div>}
      {stage === 'reverted' && confirmation?.status === 'reverted' && <div className="shield-error" role="alert"><strong>Transaction reverted</strong><p>Sepolia included the transaction in block {confirmation.blockNumber}, but it did not shield funds. Check the transaction before trying again.</p><button type="button" onClick={() => editAmount(amount)}>Start a new review</button></div>}
      {stage === 'unknown' && <div className="shield-error" role="alert"><strong>Confirmation unknown</strong><p>{error || 'The transaction outcome could not be verified.'}</p><p>Check the linked transaction. Do not assume the shield failed.</p><button type="button" onClick={retryConfirmation}>Check confirmation again</button></div>}
      {stage === 'draft' && error && <p className="shield-error" role="alert">{error}</p>}
    </>}
  </section>
}
