import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { browserArtifactFiles } from '../src/railgun/artifact-store.ts'

test('proof storage recovers after open failure and rejects aborted writes', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  const factory = new IDBFactory()
  const put = IDBObjectStore.prototype.put
  try {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
      open() { throw new Error('Temporary storage failure') },
    } })
    await assert.rejects(browserArtifactFiles.fileExists('proof'), /Temporary storage failure/)
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory })
    assert.equal(await browserArtifactFiles.fileExists('proof'), false)
    await browserArtifactFiles.writeFile('', 'proof', new Uint8Array([1, 2, 3]))
    assert.deepEqual(await browserArtifactFiles.readFile('proof'), Buffer.from([1, 2, 3]))
    await browserArtifactFiles.writeFile('', 'manifest', 'verified text')
    assert.equal(await browserArtifactFiles.readFile('manifest'), 'verified text')

    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const request = put.apply(this, args)
      request.addEventListener('success', () => this.transaction.abort())
      return request
    }
    await assert.rejects(browserArtifactFiles.writeFile('', 'aborted', 'not committed'), /abort/i)
    IDBObjectStore.prototype.put = put
    assert.equal(await browserArtifactFiles.fileExists('aborted'), false)
    await browserArtifactFiles.writeFile('', 'retry', 'saved')
    assert.equal(await browserArtifactFiles.readFile('retry'), 'saved')
  } finally {
    IDBObjectStore.prototype.put = put
    if (original) Object.defineProperty(globalThis, 'indexedDB', original)
    else Reflect.deleteProperty(globalThis, 'indexedDB')
  }
})
