import Level from 'level-js'
import { AbstractIterator } from 'abstract-leveldown'
import type { Database } from '@railgun-community/engine'

type Callback = (error?: unknown, ...values: unknown[]) => void
type Operation = (...args: unknown[]) => unknown
type InternalLevel = InstanceType<typeof Level> & { db: IDBDatabase; store: (mode: IDBTransactionMode) => IDBObjectStore }

function invalidState(error: unknown) {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'InvalidStateError'
}

/** Reopen only after a transaction could not START. Never replay aborted writes. */
export function createBrowserDatabase(location: string) {
  const raw = new Level(location) as InternalLevel
  const methods = raw as unknown as Record<string, Operation>
  const beforeTransaction = new WeakSet<object>()
  const store = raw.store.bind(raw)
  raw.store = (mode) => {
    try { return store(mode) }
    catch (error) {
      if (invalidState(error)) beforeTransaction.add(error as object)
      throw error
    }
  }
  let reopening: Promise<void> | undefined
  function reopen(): Promise<void> {
    if (reopening) return reopening
    const run = new Promise<void>((resolve, reject) => {
      if (raw.status !== 'open') { reject(new Error('Wallet storage is closing. Reload this tab before retrying.')); return }
      let abandoned = false
      const request = indexedDB.open(`${raw.prefix}${raw.location}`, Number(raw.version))
      const timer = setTimeout(() => {
        abandoned = true
        reject(new Error('Wallet storage did not reopen. Close other 0xPay tabs and reload.'))
      }, 20_000)
      const fail = (error: unknown) => { abandoned = true; clearTimeout(timer); reject(error) }
      request.onupgradeneeded = () => {
        request.transaction?.abort()
        fail(new Error('Existing wallet storage is unavailable. Reload to recover it; no database was reset.'))
      }
      request.onblocked = () => fail(new Error('Wallet storage is blocked by another tab. Close that tab and reload.'))
      request.onerror = () => fail(request.error ?? new Error('Wallet storage could not reopen'))
      request.onsuccess = () => {
        clearTimeout(timer)
        const db = request.result
        if (abandoned || raw.status !== 'open') { db.close(); reject(new Error('Wallet storage closed during recovery')); return }
        if (!db.objectStoreNames.contains(raw.location)) { db.close(); reject(new Error('Existing wallet store is missing. Reload to recover it.')); return }
        raw.db = db
        db.onversionchange = () => db.close()
        resolve()
      }
    })
    reopening = run
    void run.finally(() => { if (reopening === run) reopening = undefined }).catch(() => {})
    return run
  }
  for (const name of ['_get', '_getMany', '_put', '_del', '_batch', '_clear']) {
    const original = methods[name].bind(raw)
    methods[name] = (...args: unknown[]) => {
      const callback = args.pop() as Callback
      let retried = false
      const attempt = () => {
        const done: Callback = (error, ...values) => {
          if (error && typeof error === 'object' && beforeTransaction.has(error) && !retried) {
            retried = true
            void reopen().then(attempt, callback)
          } else if (error && typeof error === 'object' && beforeTransaction.has(error)) {
            callback(new Error('Wallet storage closed again during recovery. Reload this tab before retrying.', { cause: error }))
          } else callback(error, ...values)
        }
        try { original(...args, done) }
        catch (error) {
          // The limited-clear helper opens its transaction directly, like iterators.
          if (name === '_clear' && invalidState(error)) beforeTransaction.add(error as object)
          done(error)
        }
      }
      attempt()
    }
  }
  const originalIterator = methods._iterator.bind(raw)
  methods._iterator = (options: unknown) => {
    try { return originalIterator(options) }
    catch (error) {
      if (!invalidState(error)) throw error
      // level-js starts its read-only cursor inside the iterator constructor.
      const pending = reopen().then(() => originalIterator(options) as ReturnType<typeof raw.iterator>)
        .catch((cause: unknown) => { throw new Error('Wallet storage could not resume a read cursor. Reload this tab before retrying.', { cause }) })
      void pending.catch(() => {})
      const iterator = new AbstractIterator(raw) as unknown as Record<string, Operation>
      iterator._next = (callback: unknown) => { void pending.then((actual) => actual.next(callback as never), callback as (error: unknown) => void) }
      iterator._end = (callback: unknown) => { void pending.then((actual) => actual.end(callback as never), callback as (error: unknown) => void) }
      return iterator
    }
  }
  // The SDK's IndexedDB fast path bypasses Level's callbacks and error handling.
  // Hide only the external raw handle so it uses its supported Level stream path.
  // Internal Level methods remain bound to raw and retain the real IDB handle.
  return new Proxy(raw, { get(target, property) {
    if (property === 'db') return undefined
    const value: unknown = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } }) as InstanceType<typeof Level>
}

/** The SDK's Level fallback omits stream-error handling in getNamespaceKeys. */
export function protectNamespaceReads(database: Database) {
  database.getNamespaceKeys = (namespace) => new Promise<string[]>((resolve, reject) => {
    const keys: string[] = []
    database.streamNamespace(namespace)
      .on('data', (key: string) => keys.push(key))
      .once('error', reject)
      .once('end', () => resolve(keys))
  })
}
