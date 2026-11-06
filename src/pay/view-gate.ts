/** Keeps a mounted wallet's asynchronous work bound to its current API/session. */
export type OperationTicket = { epoch: number; token: symbol }
export type ReadTicket = { epoch: number; sequence: number }
export class WalletViewGate {
  private epoch = 0
  private sequence = 0
  private active: symbol | null = null
  get busy() { return this.active !== null }
  beginOperation(): OperationTicket | null {
    if (this.busy) return null
    const token = Symbol('wallet operation')
    this.active = token
    return { epoch: this.epoch, token }
  }
  isCurrent(ticket: OperationTicket) { return ticket.epoch === this.epoch && ticket.token === this.active }
  finish(ticket: OperationTicket) {
    if (!this.isCurrent(ticket)) return false
    this.active = null
    return true
  }
  beginRead(): ReadTicket { return { epoch: this.epoch, sequence: ++this.sequence } }
  isReadCurrent(ticket: ReadTicket) { return ticket.epoch === this.epoch && ticket.sequence === this.sequence }
  invalidate() { this.epoch++; this.sequence++; this.active = null }
}
