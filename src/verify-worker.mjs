import { verifyZip } from './verify.mjs'
import checksums from '../generated/checksums.json'

self.onmessage = async ({ data }) => {
  try {
    const value = await verifyZip(data.file, {
      expectedPayloadBytes: data.expectedPayloadBytes,
      checksums,
      onProgress: (value) => self.postMessage({ type: 'progress', value })
    })
    self.postMessage({ type: 'done', value })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
