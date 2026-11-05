// Anon Wallet documents this public PPOI aggregator:
// https://docs.anon.inc/advanced/ppoi-proxy
// The method and parameter names match the installed Wallet SDK POINodeRequest.
export const POI_NODE_URL = 'https://ppoi.fdi.network'

export async function checkSepoliaPoi() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(POI_NODE_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'ppoi_validated_txid',
        params: { chainType: '0', chainID: '11155111', txidVersion: 'V2_PoseidonMerkle' },
      }),
    })
    if (!response.ok) throw new Error(`POI returned HTTP ${response.status}`)
    const data: unknown = await response.json()
    if (typeof data !== 'object' || data === null || !('id' in data) || data.id !== 1 ||
      !('result' in data) || typeof data.result !== 'object' || data.result === null ||
      !('validatedTxidIndex' in data.result) ||
      !Number.isSafeInteger(data.result.validatedTxidIndex) ||
      typeof data.result.validatedTxidIndex !== 'number' || data.result.validatedTxidIndex < 0 ||
      !('validatedTxidMerkleroot' in data.result) ||
      typeof data.result.validatedTxidMerkleroot !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(data.result.validatedTxidMerkleroot)) {
      throw new Error('POI did not return a Sepolia validated transaction index')
    }
    return data.result.validatedTxidIndex
  } finally { clearTimeout(timeout) }
}
