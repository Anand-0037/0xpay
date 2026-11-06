/** Invalidates any pending unlock before the lock's async SDK cleanup begins. */
export class SessionGate {
  private generation = 0
  private unlocking = false
  private locking = false

  beginUnlock() {
    if (this.unlocking || this.locking) throw new Error('Wallet action is already running')
    this.unlocking = true
    return ++this.generation
  }

  isCurrent(generation: number) { return generation === this.generation }

  assertCurrent(generation: number) {
    if (!this.isCurrent(generation)) throw new Error('Wallet was locked during unlock')
  }

  finishUnlock() { this.unlocking = false }

  async lock(cleanup: () => Promise<void> | void) {
    if (this.locking) throw new Error('Wallet lock is already running')
    this.generation += 1
    this.locking = true
    try { await cleanup() }
    finally { this.locking = false }
  }
}
