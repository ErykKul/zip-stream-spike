import { createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { predictLength } from 'client-zip'
import { useStreamingZipDownload } from '../vendor/frontend/src/sections/dataset/dataset-files/files-tree/useStreamingZipDownload'
import { createServiceWorkerSink, resolveZipSink, transferableStreamsSupported } from '../vendor/frontend/src/sections/dataset/dataset-files/files-tree/zipStreamSink'
import sourceMetadata from '../generated/metadata.json'
import checksums from '../generated/checksums.json'
import { describePayload, makePattern } from './payload.mjs'

export const metadata = sourceMetadata
export { describePayload }

let hookApi: ReturnType<typeof useStreamingZipDownload>
let mounted = false
let active: any = null

function Driver() {
  const api = useStreamingZipDownload()
  hookApi = api
  useEffect(() => {
    const run = active
    if (!run || api.state.status === 'idle') return
    report(run, api.state)
    if (['done', 'cancelled', 'error'].includes(api.state.status)) {
      run.cleanup()
      if (active === run) active = null
    }
  }, [api.state])
  return null
}

function mount() {
  if (mounted) return
  const container = document.createElement('div')
  container.hidden = true
  container.setAttribute('aria-hidden', 'true')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => root.render(createElement(Driver)))
  mounted = true
}

function report(run: any, state: any) {
  run.onState?.({
    ...state,
    filename: run.filename,
    transport: run.transport,
    diagnostic: run.diagnostic,
    generatedBytes: run.generatedBytes,
    rangeRequests: run.rangeRequests,
    expectedPayloadBytes: run.bytes,
    zipBytes: run.zipBytes,
    elapsedMs: performance.now() - run.startedAt
  })
}

function installSyntheticFetch(run: any, files: any[]) {
  const originalFetch = window.fetch
  const byUrl = new Map(files.map((file) => [file.downloadUrl, file]))
  const pattern = makePattern()
  const interceptedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    url.search = ''
    const file = byUrl.get(url.href)
    if (!file) return originalFetch.call(window, input, init)
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    signal?.throwIfAborted()
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const range = headers.get('Range')
    let from = 0
    let to = file.size - 1
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)
      if (!match || Number(match[1]) > Number(match[2]) || Number(match[2]) >= file.size) {
        return new Response(null, { status: 416, statusText: 'Range Not Satisfiable' })
      }
      from = Number(match[1])
      to = Number(match[2])
      run.rangeRequests++
    }
    let offset = from
    const body = new ReadableStream({
      pull(controller) {
        if (run.cancelled || signal?.aborted) {
          controller.error(new DOMException('Cancelled', 'AbortError'))
          return
        }
        if (offset > to) {
          controller.close()
          return
        }
        const length = Math.min(pattern.length - offset % pattern.length, to - offset + 1)
        const bytes = pattern.slice(offset % pattern.length, offset % pattern.length + length)
        offset += length
        run.generatedBytes += length
        controller.enqueue(bytes)
      }
    }, { highWaterMark: 0 })
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(to - from + 1),
        ...(range ? { 'Content-Range': `bytes ${from}-${to}/${file.size}` } : {})
      }
    })
  }
  window.fetch = interceptedFetch
  return () => { if (window.fetch === interceptedFetch) window.fetch = originalFetch }
}

export async function start({ bytes, onState, transferStreams }: {
  bytes: number
  onState: (state: any) => void
  transferStreams?: boolean
}) {
  if (active) throw new Error('A ZIP download is already running.')
  const entries = describePayload(bytes)
  mount()
  hookApi.close()
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const files = entries.map((entry, index) => ({
    ...entry,
    type: 'file' as const,
    id: index + 1,
    downloadUrl: new URL(`./__synthetic__/${id}/${index}`, location.href).href,
    checksum: { type: 'SHA-256', value: checksums[String(entry.size)] }
  }))
  const run = {
    bytes, onState, startedAt: performance.now(), generatedBytes: 0, rangeRequests: 0,
    filename: `dataverse-zip-test-${bytes / (1024 ** 2)}MiB-${id}.zip`,
    diagnostic: transferStreams !== undefined,
    transport: 'initializing', cancelled: false, cleanup: () => {},
    zipBytes: Number(predictLength(entries.map(({ path, size }) => ({ name: path, size }))))
  }
  active = run
  report(run, { status: 'preparing', totalBytes: bytes, bytesDone: 0, totalFiles: files.length,
    filesDone: 0, failedSoFar: [], verificationFailures: [], pass: 1 })
  try {
    const serviceWorkerUrl = new URL('./reusable-components/zip-download-sw.js', import.meta.url).href
    const sink = transferStreams === undefined
      ? await resolveZipSink({ serviceWorkerUrl })
      : await createServiceWorkerSink({ url: serviceWorkerUrl, transferStreams })
    if (run.cancelled) return
    if (!sink) throw new Error('The download service worker is unavailable.')
    run.transport = sink.streaming
      ? (transferStreams ?? transferableStreamsSupported()) ? 'transferable-stream' : 'message-channel'
      : 'buffered-blob'
    run.cleanup = installSyntheticFetch(run, files)
    hookApi.start({ files, zipName: run.filename, serviceWorkerUrl, sink })
  } catch (error) {
    run.cleanup()
    if (active === run) active = null
    report(run, { status: 'error', message: error instanceof Error ? error.message : String(error),
      totalBytes: bytes, bytesDone: run.generatedBytes, totalFiles: files.length, filesDone: 0,
      failedSoFar: [], verificationFailures: [], pass: 1 })
    throw error
  }
}

export function cancel() {
  if (!active) return
  const run = active
  run.cancelled = true
  hookApi.cancel()
  run.cleanup()
  report(run, { ...hookApi.state, status: 'cancelled' })
  active = null
}

export function verifySavedZip(file: File, { onProgress, signal, expectedPayloadBytes }: {
  onProgress?: (progress: any) => void
  signal?: AbortSignal
  expectedPayloadBytes?: number
} = {}): Promise<any> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./verify-worker.js', import.meta.url), { type: 'module' })
    const cleanup = () => { worker.terminate(); signal?.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(new DOMException('Verification cancelled', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
    worker.onerror = (event) => { cleanup(); reject(new Error(event.message || 'Verification worker failed')) }
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') { onProgress?.(data.value); return }
      cleanup()
      if (data.type === 'done') resolve(data.value)
      else reject(new Error(data.message))
    }
    worker.postMessage({ file, expectedPayloadBytes })
  })
}
