export function PaymentUseCases() {
  return <div className="payment-stories" aria-label="What you can do with 0xPay">
    <section className="payment-story" aria-labelledby="story-send">
      <div className="story-copy"><p className="eyebrow">01 · SEND</p><h2 id="story-send">A payment for them.<br />Fewer details for everyone else.</h2><p>For example, pay a collaborator at their private RAILGUN address. Shield test ETH into your private balance, choose an amount, and review the fees before you sign.</p><p className="story-aside">Both people need a RAILGUN wallet. This build uses Sepolia test funds.</p><a href="#wallet-panel-heading">Start with your wallet <span aria-hidden="true">↗</span></a></div>
      <div className="story-route" aria-label="Payment flow"><span>YOUR WALLET</span><strong>Shield.</strong><span className="story-connector" aria-hidden="true">↓</span><strong>Send privately.</strong><span className="story-connector" aria-hidden="true">↓</span><span>THEIR PRIVATE ADDRESS</span></div>
    </section>
    <section className="payment-story story-receive" aria-labelledby="story-receive">
      <div className="story-addresses"><div><span>FOR FUNDING &amp; GAS</span><strong>0x…</strong><p>Your public Ethereum address</p></div><div><span>FOR PRIVATE RECEIVING</span><strong>0zk…</strong><p>Your RAILGUN address</p></div></div>
      <div className="story-copy"><p className="eyebrow">02 · RECEIVE</p><h2 id="story-receive">An address for<br />your private balance.</h2><p>Unlock your wallet and open “Receive private funds” to copy your 0zk address. Share it with another RAILGUN wallet user to receive shielded funds.</p><p className="story-aside">Use your public 0x address for test ETH and gas. Keep your recovery words private: they restore both addresses.</p><a href="#wallet-panel-heading">Create or restore a wallet <span aria-hidden="true">↗</span></a></div>
    </section>
    <section className="payment-story story-privacy" aria-labelledby="story-privacy">
      <div className="story-copy"><p className="eyebrow">03 · UNDERSTAND</p><h2 id="story-privacy">Privacy in the payment.<br />Privacy in the connection.</h2><p>RAILGUN provides the shielded balance and private transfer. Anon-RPC routes wallet blockchain requests through the selected privacy network, reducing the direct link between your IP and those requests at the RPC provider.</p><p className="story-aside">Funding and the gas payer remain public. Proof-of-innocence checks and indexing use direct services. Open Connection to see the privacy coverage.</p><a href="https://ethereum.github.io/anon-rpc/wallets/" target="_blank" rel="noopener noreferrer">How Anon-RPC works <span aria-hidden="true">↗</span></a></div>
      <div className="story-layers"><div><span>RAILGUN</span><strong>Shielded payments</strong><p>Move value between private balances.</p></div><div><span>ANON-RPC</span><strong>Routed requests</strong><p>The wallet stops when its private route fails.</p></div><p>0xPay is the app: create, fund, shield, send and receive inside your wallet.</p></div>
    </section>
  </div>
}
