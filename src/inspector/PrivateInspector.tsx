import { useRef, useState, type FormEvent } from 'react'
import { formatEther } from 'viem'
import { inspectQuery, parseLookup, type Inspection, type RpcRead } from './inspect.ts'
import './PrivateInspector.css'

type Props = { read: RpcRead; routeReady: boolean }

/** Remounting on route loss discards results and late responses from the old route. */
export function PrivateInspector(props: Props) {
  return <InspectorSession key={props.routeReady ? 'ready' : 'offline'} {...props} />
}

function InspectorSession({ read, routeReady }: Props) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<Inspection | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const requestId = useRef(0)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setResult(null)
    let value: string
    try { value = parseLookup(query).value }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return }
    if (!routeReady) { setError('Reconnect the private route before searching.'); return }
    const request = ++requestId.current
    setLoading(true)
    try {
      const answer = await inspectQuery(value, read)
      if (request === requestId.current) setResult(answer)
    } catch (cause) {
      if (request === requestId.current) setError(cause instanceof Error ? cause.message : 'The private lookup failed.')
    } finally {
      if (request === requestId.current) setLoading(false)
    }
  }

  return <section className="px-inspector" aria-labelledby="inspector-title">
    <p className="px-kicker">PRIVATE RPC LOOKUP · DEVNET</p>
    <h1 id="inspector-title">Inspect a payment or address.</h1>
    <p>Look up public devnet data through the selected Anon-RPC worker. No wallet connection is needed. The RPC still sees the address or hash you query.</p>
    <form onSubmit={event => void submit(event)}>
      <label htmlFor="private-lookup">Address or transaction hash</label>
      <div className="px-inspector-row">
        <input id="private-lookup" value={query} onChange={event => { requestId.current++; setQuery(event.target.value); setResult(null); setError(''); setLoading(false) }} placeholder="0x…" autoComplete="off" spellCheck={false} />
        <button type="submit" disabled={loading || !routeReady}>Look up</button>
      </div>
    </form>
    <div className="px-inspector-status" role="status" aria-live="polite">
      {loading && 'Reading through the private route…'}
      {!routeReady && 'Private connection unavailable'}
      {error && <p className="px-inspector-error">{error}</p>}
      {result?.kind === 'account' && <div className="px-inspector-result">
        <h2>Account</h2>
        <dl><div><dt>Address</dt><dd>{result.address}</dd></div><div><dt>Public ETH balance</dt><dd>{formatEther(result.balanceWei)} ETH</dd></div><div><dt>Transaction count</dt><dd>{result.nonce.toString()}</dd></div><div><dt>Read at block</dt><dd>{result.observedBlock.toString()}</dd></div></dl>
      </div>}
      {result?.kind === 'transaction' && <div className="px-inspector-result">
        <h2>Transaction</h2>
        <dl><div><dt>Hash</dt><dd>{result.hash}</dd></div><div><dt>Status</dt><dd>{result.outcome === 'included' ? 'Included successfully' : result.outcome === 'failed' ? 'Included but failed' : result.outcome === 'pending' ? 'Pending or not yet receipted' : 'Not found on this devnet'}</dd></div>{result.includedBlock !== null && <div><dt>Included in block</dt><dd>{result.includedBlock.toString()}</dd></div>}<div><dt>Read at block</dt><dd>{result.observedBlock.toString()}</dd></div></dl>
        {result.nativeTransfers.map((transfer, index) => <div key={index} className="px-inspector-transfer"><h3>Native ETH transfer in receipt</h3><dl><div><dt>From</dt><dd>{transfer.from}</dd></div><div><dt>To</dt><dd>{transfer.to}</dd></div><div><dt>Amount</dt><dd>{formatEther(transfer.amountWei)} ETH</dd></div></dl></div>)}<p>Inclusion is not finality. This devnet can reset.</p>
      </div>}
    </div>
    <p className="px-inspector-footnote">This search stays in this page. Opening a separate block explorer sends the lookup outside this private route.</p>
  </section>
}
