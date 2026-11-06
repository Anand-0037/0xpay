import { Buffer } from 'buffer'

type StoredArtifact = { kind: 'text'; value: string } | { kind: 'bytes'; value: ArrayBuffer }
let databasePromise: Promise<IDBDatabase> | undefined

function database(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('0xpay-proof-artifacts', 1)
    let blocked = false
    request.onupgradeneeded = () => request.result.createObjectStore('files')
    request.onblocked = () => {
      blocked = true
      reject(new Error('Proof storage is blocked by another tab. Close that tab and retry.'))
    }
    request.onsuccess = () => {
      const db = request.result
      if (blocked) { db.close(); return }
      const invalidate = () => {
        if (databasePromise === opening) databasePromise = undefined
      }
      db.onversionchange = () => { db.close(); invalidate() }
      db.onclose = invalidate
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('Artifact storage unavailable'))
  })
  databasePromise = opening
  void opening.catch(() => { if (databasePromise === opening) databasePromise = undefined })
  return opening
}

async function readFile(path: string): Promise<string | Buffer | null> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('files', 'readonly')
    const request = transaction.objectStore('files').get(path)
    let item: StoredArtifact | undefined
    request.onsuccess = () => {
      item = request.result as StoredArtifact | undefined
    }
    transaction.oncomplete = () => resolve(item ? item.kind === 'text' ? item.value : Buffer.from(item.value) : null)
    transaction.onabort = () => reject(transaction.error ?? new Error('Artifact read aborted'))
    request.onerror = () => reject(request.error ?? new Error('Artifact read failed'))
  })
}

async function writeFile(_directory: string, path: string, value: string | Uint8Array): Promise<void> {
  const db = await database()
  const item: StoredArtifact = typeof value === 'string'
    ? { kind: 'text', value }
    : { kind: 'bytes', value: new Uint8Array(value).buffer }
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('files', 'readwrite')
    transaction.objectStore('files').put(item, path)
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('Artifact write aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('Artifact write failed'))
  })
}

async function fileExists(path: string): Promise<boolean> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('files', 'readonly')
    const request = transaction.objectStore('files').getKey(path)
    let exists = false
    request.onsuccess = () => { exists = request.result !== undefined }
    transaction.oncomplete = () => resolve(exists)
    transaction.onabort = () => reject(transaction.error ?? new Error('Artifact lookup aborted'))
    request.onerror = () => reject(request.error ?? new Error('Artifact lookup failed'))
  })
}

export const browserArtifactFiles = { readFile, writeFile, fileExists }

export async function createBrowserArtifactStore() {
  const { ArtifactStore } = await import('@railgun-community/wallet')
  return new ArtifactStore(readFile, writeFile, fileExists)
}
