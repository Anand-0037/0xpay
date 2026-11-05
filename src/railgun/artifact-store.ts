import { Buffer } from 'buffer'

type StoredArtifact = { kind: 'text'; value: string } | { kind: 'bytes'; value: ArrayBuffer }
let databasePromise: Promise<IDBDatabase> | undefined

function database(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('0xpay-proof-artifacts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('files')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Artifact storage unavailable'))
  })
  return databasePromise
}

async function readFile(path: string): Promise<string | Buffer | null> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = db.transaction('files', 'readonly').objectStore('files').get(path)
    request.onsuccess = () => {
      const item = request.result as StoredArtifact | undefined
      resolve(item ? item.kind === 'text' ? item.value : Buffer.from(item.value) : null)
    }
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
    transaction.onerror = () => reject(transaction.error ?? new Error('Artifact write failed'))
  })
}

async function fileExists(path: string): Promise<boolean> {
  const db = await database()
  return new Promise((resolve, reject) => {
    const request = db.transaction('files', 'readonly').objectStore('files').getKey(path)
    request.onsuccess = () => resolve(request.result !== undefined)
    request.onerror = () => reject(request.error ?? new Error('Artifact lookup failed'))
  })
}

export async function createBrowserArtifactStore() {
  const { ArtifactStore } = await import('@railgun-community/wallet')
  return new ArtifactStore(readFile, writeFile, fileExists)
}
