import { useEffect, useRef, useState, type FormEvent } from 'react'
import { formatEther } from 'ethers'
import { parseEthAmount } from '../domain/amount'
import type { PrivateSendQuote, PrivateSendReceipt, PrivateSendSubmission } from '../railgun/send'

export type SendPanelProps = {
  onQuote: (recipientAddress: string, amountWei: bigint) => Promise<PrivateSendQuote>
  onSubmit: (quote: PrivateSendQuote, onProofProgress: (progress: number, status: string) => void) => Promise<PrivateSendSubmission>
  onConfirm: (transactionHash: string) => Promise<PrivateSendReceipt>
}

type Stage = 'draft' | 'quoting' | 'review' | 'preparing' | 'pending' | 'confirmed' | 'reverted' | 'unknown' | 'error'

function messageFrom(cause: unknown) {
  return cause instanceof Error ? cause.message : 'The send could not be completed.'
}

function validHash(hash: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(hash)
}

function checkedQuote(amountWei: bigint, recipientAddress: string, quote: PrivateSendQuote) {
  if (!quote.id.trim() || !quote.walletId || quote.amountWei !== amountWei ||
      quote.recipientAddress !== recipientAddress || amountWei <= 0n ||
      quote.spendableWethWei < amountWei || quote.maxNetworkFeeWei < 0n ||
      quote.publicGasBalanceWei < quote.maxNetworkFeeWei || !quote.publicGasPayer ||
      !Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= Date.now()) {
    throw new Error('The send quote is incomplete, expired, or does not match this request. Review again.')
  }
  return quote
}

function checkedReceipt(hash: string, result: PrivateSendReceipt) {
  if (!validHash(result.transactionHash) || result.transactionHash.toLowerCase() !== hash.toLowerCase() ||
      (result.status !== 'unknown' && (!Number.isSafeInteger(result.blockNumber) || result.blockNumber <= 0))) {
    throw new Error('The transaction result does not match this private send.')
  }
  return result
}

export function SendPanel({ onQuote, onSubmit, onConfirm }: SendPanelProps) {
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [stage, setStage] = useState<Stage>('draft')
  const [quote, setQuote] = useState<PrivateSendQuote | null>(null)
  const [proofProgress, setProofProgress] = useState<number | null>(null)
  const [transactionHash, setTransactionHash] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<PrivateSendReceipt | null>(null)
  const [error, setError] = useState('')
  const requestId = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; requestId.current += 1 }
  }, [])

  function edit(nextRecipient = recipient, nextAmount = amount) {
    requestId.current += 1
    setRecipient(nextRecipient)
    setAmount(nextAmount)
    setQuote(null)
    setProofProgress(null)
    setTransactionHash(null)
    setReceipt(null)
    setError('')
    setStage('draft')
  }

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (stage !== 'draft') return
    const currentId = ++requestId.current
    setError('')
    try {
      const amountWei = parseEthAmount(amount)
      const address = recipient.trim()
      if (!address) throw new Error('Enter a RAILGUN recipient address')
      setStage('quoting')
      const result = checkedQuote(amountWei, address, await onQuote(address, amountWei))
      if (!mounted.current || requestId.current !== currentId) return
      setQuote(result)
      setStage('review')
    } catch (cause) {
      if (!mounted.current || requestId.current !== currentId) return
      setError(messageFrom(cause))
      setStage('draft')
    }
  }

  async function checkConfirmation(hash: string, currentId: number) {
    try {
      const result = checkedReceipt(hash, await onConfirm(hash))
      if (!mounted.current || requestId.current !== currentId) return
      setReceipt(result)
      setError(result.status === 'unknown' ? result.message : '')
      setStage(result.status)
    } catch (cause) {
      if (!mounted.current || requestId.current !== currentId) return
      setError(messageFrom(cause))
      setStage('unknown')
    }
  }

  async function submit() {
    if (stage !== 'review' || !quote) return
    const currentId = ++requestId.current
    setProofProgress(null)
    setError('')
    setStage('preparing')
    try {
      const submission = await onSubmit(quote, (progress, _status) => {
        if (!mounted.current || requestId.current !== currentId ||
            !Number.isFinite(progress) || progress < 0 || progress > 100) return
        setProofProgress(progress)
      })
      if (!mounted.current || requestId.current !== currentId) return
      if (submission.status !== 'submitted' || !validHash(submission.transactionHash)) {
        throw new Error('The wallet did not return a valid transaction hash.')
      }
      setTransactionHash(submission.transactionHash)
      setStage('pending')
      await checkConfirmation(submission.transactionHash, currentId)
    } catch (cause) {
      if (!mounted.current || requestId.current !== currentId) return
      setError(messageFrom(cause))
      setStage('error')
    }
  }

  function retryConfirmation() {
    if (stage !== 'unknown' || !transactionHash) return
    const currentId = ++requestId.current
    setError('')
    setStage('pending')
    void checkConfirmation(transactionHash, currentId)
  }

  const editingLocked = stage === 'preparing' || stage === 'pending' || stage === 'unknown'

  return <section className="send-panel" aria-labelledby="send-heading">
    <p className="eyebrow">PRIVATE TRANSFER</p>
    <h2 id="send-heading">Send WETH privately</h2>
    <p className="send-explainer">Send from your RAILGUN balance to another 0zk wallet. Your connected public wallet pays Sepolia gas and will be visible as the transaction sender onchain.</p>

    {stage === 'confirmed' && receipt?.status === 'confirmed' ? <div className="send-result" role="status">
      <strong>Private send confirmed</strong>
      <p>Included in Sepolia block {receipt.blockNumber}. The recipient may need to finish a RAILGUN balance sync before seeing the funds.</p>
      <a href={`https://sepolia.etherscan.io/tx/${receipt.transactionHash}`} target="_blank" rel="noopener noreferrer">View confirmed transaction ↗</a>
      <button type="button" onClick={() => edit('', '')}>Send another amount</button>
    </div> : <>
      <form className="send-form" onSubmit={review}>
        <label htmlFor="send-recipient">RAILGUN recipient</label>
        <input id="send-recipient" type="text" autoComplete="off" spellCheck={false} placeholder="0zk…" value={recipient} disabled={editingLocked} onChange={(event) => edit(event.target.value, amount)} required />
        <label htmlFor="send-amount">Amount</label>
        <div className="send-amount-row"><input id="send-amount" type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} disabled={editingLocked} onChange={(event) => edit(recipient, event.target.value)} required /><span>WETH</span></div>
        {stage === 'draft' && <button className="primary" type="submit">Review send</button>}
        {stage === 'quoting' && <p className="send-progress" role="status">Checking spendable WETH and Sepolia gas…</p>}
      </form>

      {quote && stage !== 'draft' && stage !== 'quoting' && <div className="send-review" aria-labelledby="send-review-heading">
        <div className="send-review-heading"><h3 id="send-review-heading">Review private send</h3><span>Sepolia</span></div>
        <dl>
          <div><dt>To RAILGUN address</dt><dd className="send-address">{quote.recipientAddress}</dd></div>
          <div><dt>Send amount</dt><dd>{formatEther(quote.amountWei)} WETH</dd></div>
          <div><dt>Spendable private balance</dt><dd>{formatEther(quote.spendableWethWei)} WETH</dd></div>
          <div><dt>Public gas payer</dt><dd className="send-address">{quote.publicGasPayer}</dd></div>
          <div><dt>Maximum network fee</dt><dd>{formatEther(quote.maxNetworkFeeWei)} ETH</dd></div>
          <div><dt>Public ETH for gas</dt><dd>{formatEther(quote.publicGasBalanceWei)} ETH</dd></div>
        </dl>
        <p>The transfer contents are encrypted, but this public gas payer can be linked to the transaction. This flow does not use a broadcaster.</p>
        <p>Review valid until {new Date(quote.expiresAt).toLocaleTimeString()}.</p>
        {stage === 'review' && <div className="send-actions"><button type="button" onClick={() => edit(recipient, amount)}>Edit</button><button className="primary" type="button" onClick={() => void submit()}>Prove and send</button></div>}
        {stage === 'preparing' && <div className="send-progress" role="status"><p>Preparing RAILGUN proof and transaction. Your wallet approval follows.</p>{proofProgress !== null && <><progress value={proofProgress} max="100" aria-label="RAILGUN proof progress" /><span>SDK proof progress: {Math.floor(proofProgress)}%</span></>}</div>}
        {stage === 'pending' && <p className="send-progress" role="status">Transaction submitted. Waiting for the Sepolia receipt…</p>}
        {transactionHash && <a className="send-explorer" href={`https://sepolia.etherscan.io/tx/${transactionHash}`} target="_blank" rel="noopener noreferrer">View submitted transaction ↗</a>}
      </div>}

      {stage === 'error' && <div className="send-error" role="alert"><strong>Send not confirmed</strong><p>{error}</p><p>Check your wallet activity before starting a new send. A wallet error may not tell us whether a transaction was broadcast.</p><button type="button" onClick={() => edit(recipient, amount)}>Start a new review</button></div>}
      {stage === 'reverted' && receipt?.status === 'reverted' && <div className="send-error" role="alert"><strong>Transaction reverted</strong><p>Sepolia included it in block {receipt.blockNumber}, but the private send did not complete.</p><button type="button" onClick={() => edit(recipient, amount)}>Start a new review</button></div>}
      {stage === 'unknown' && <div className="send-error" role="alert"><strong>Confirmation unknown</strong><p>{error || 'The transaction outcome could not be verified.'}</p><p>Check the linked transaction before doing anything else. Do not assume it failed.</p><button type="button" onClick={retryConfirmation}>Check confirmation again</button></div>}
      {stage === 'draft' && error && <p className="send-error" role="alert">{error}</p>}
    </>}
  </section>
}
