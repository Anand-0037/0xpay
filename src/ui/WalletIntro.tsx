export function WalletIntro() {
  return <div className="wallet-intro">
    <p className="eyebrow">0XPAY · SEPOLIA</p>
    <h1>Private payments.<br /><span>A private connection.</span></h1>
    <p className="wallet-intro-lead">Shield Sepolia ETH, pay a private address, and route blockchain requests through Anon-RPC by default.</p>
    <ol className="wallet-journey" aria-label="Getting started">
      <li><span aria-hidden="true">01</span><div><strong>Create & back up</strong><p>Keep your recovery words somewhere safe.</p></div></li>
      <li><span aria-hidden="true">02</span><div><strong>Add Sepolia ETH</strong><p>Use test ETH for your balance and network fees.</p></div></li>
      <li><span aria-hidden="true">03</span><div><strong>Shield & send</strong><p>Move funds into your private balance.</p></div></li>
    </ol>
  </div>
}
