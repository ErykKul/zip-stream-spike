import { createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { predictLength } from 'client-zip'
import { useStreamingZipDownload } from '../vendor/frontend/src/sections/dataset/dataset-files/files-tree/useStreamingZipDownload'
import { createServiceWorkerSink, transferableStreamsSupported } from '../vendor/frontend/src/sections/dataset/dataset-files/files-tree/zipStreamSink'
import sourceMetadata from '../generated/metadata.json'
import checksums from '../generated/checksums.json'
import { describePayload, makePattern } from './payload.mjs'
import { createScenario, scenarios } from './scenarios.mjs'

export const metadata = sourceMetadata
export { describePayload, scenarios }

let hookApi: ReturnType<typeof useStreamingZipDownload>
let mounted = false
let active: any = null

function Driver() {
  const api = useStreamingZipDownload()
  hookApi = api
  useEffect(() => {
    const run = active
    if (!run || api.state.status === 'idle') return
    if (['done', 'cancelled', 'error'].includes(api.state.status)) {
      run.scenario?.finish(api.state.status)
      run.cleanup()
      report(run, api.state)
      if (active === run) active = null
    } else report(run, api.state)
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
  run.lastHookState = state
  run.scenario?.hookState(state)
  run.onState?.({
    ...state,
    filename: run.filename,
    transport: run.transport,
    diagnostic: run.diagnostic,
    generatedBytes: run.generatedBytes,
    rangeRequests: run.rangeRequests,
    expectedPayloadBytes: run.bytes,
    zipBytes: run.zipBytes,
    sinkEvents: run.sinkEvents,
    sinkOptions: run.sinkOptions,
    workerBytes: run.workerBytes,
    elapsedMs: performance.now() - run.startedAt,
    ...(run.probeConsumer ? { probeConsumer: run.probeConsumer } : {}),
    ...(run.scenario ? { scenario: run.scenario.snapshot() } : {})
  })
}

function installSyntheticFetch(run: any, files: any[]) {
  const originalFetch = window.fetch
  const byUrl = new Map(files.map((file, fileIndex) => [file.downloadUrl, { ...file, fileIndex }]))
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
    const fault = run.scenario?.beforeRequest({ fileIndex: file.fileIndex, from, to, range })
    if (fault) return new Response(null, { status: fault.status, statusText: 'Simulated temporary source failure' })
    let offset = from
    const readerAbort = new AbortController()
    const readSignal = signal ? AbortSignal.any([signal, readerAbort.signal]) : readerAbort.signal
    const sourceAborted = () => run.scenario?.sourceAborted({
      fileIndex: file.fileIndex, offset,
      pendingWaitMs: run.scenario.snapshot().pendingWaitMs
    })
    signal?.addEventListener('abort', sourceAborted, { once: true })
    const detach = () => signal?.removeEventListener('abort', sourceAborted)
    const body = new ReadableStream({
      async pull(controller) {
        if (run.cancelled || signal?.aborted) {
          detach()
          controller.error(new DOMException('Cancelled', 'AbortError'))
          return
        }
        if (offset > to) {
          detach()
          controller.close()
          return
        }
        try {
          if (run.scenario) await run.scenario.beforeChunk({
            fileIndex: file.fileIndex, offset, signal: readSignal,
            isFinalChunk: file.fileIndex === files.length - 1 && offset + pattern.length >= file.size
          })
          if (run.cancelled) throw new DOMException('Cancelled', 'AbortError')
          readSignal.throwIfAborted()
          const length = Math.min(pattern.length - offset % pattern.length, to - offset + 1)
          const bytes = pattern.slice(offset % pattern.length, offset % pattern.length + length)
          offset += length
          run.generatedBytes += length
          controller.enqueue(bytes)
        } catch (error) {
          detach()
          controller.error(error)
        }
      },
      cancel(reason) {
        detach()
        run.scenario?.readerCancelled({ fileIndex: file.fileIndex, offset, reason: String(reason ?? '') })
        readerAbort.abort()
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

export async function start({ bytes, onState, transferStreams, scenario, cancellationProbe = false, exactLength = false, transferChunks = false, holdWorkerUntilComplete = false }: {
  bytes: number
  onState: (state: any) => void
  transferStreams?: boolean
  scenario?: keyof typeof scenarios
  cancellationProbe?: boolean
  exactLength?: boolean
  transferChunks?: boolean
  holdWorkerUntilComplete?: boolean
}) {
  if (active) throw new Error('A ZIP download is already running.')
  if (scenario && (!scenarios[scenario] || (scenario !== 'complete' && bytes !== scenarios[scenario].bytes))) {
    throw new Error('Diagnostic scenarios use a 64 MiB payload.')
  }
  if (scenario === 'complete' && (!Number.isSafeInteger(bytes) || bytes < 64 * 1024 ** 2 || bytes % (1024 ** 2))) {
    throw new Error('The complete diagnostic requires a payload of at least 64 MiB, in whole MiB.')
  }
  const entries = describePayload(bytes)
  mount()
  flushSync(() => hookApi.close())
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const files = entries.map((entry, index) => ({
    ...entry,
    type: 'file' as const,
    id: index + 1,
    downloadUrl: new URL(`./__synthetic__/${id}/${index}`, location.href).href,
    checksum: { type: 'SHA-256', value: checksums[String(entry.size)] }
  }))
  const run: any = {
    bytes, onState, startedAt: performance.now(), generatedBytes: 0, rangeRequests: 0,
    filename: `dataverse-zip-test-${bytes / (1024 ** 2)}MiB-${id}.zip`,
    diagnostic: transferStreams !== undefined || scenario !== undefined,
    transport: 'initializing', cancelled: false, cleanup: () => {},
    scenario: null, lastHookState: null, sinkEvents: [], workerBytes: 0,
    sinkOptions: { exactLength, transferChunks, holdWorkerUntilComplete },
    zipBytes: Number(predictLength(entries.map(({ path, size }) => ({ name: path, size }))))
  }
  active = run
  let restoreFetch = () => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const visibilityChanged = () => run.scenario?.visibility(document.visibilityState)
  run.cleanup = () => {
    restoreFetch()
    clearInterval(heartbeat)
    document.removeEventListener('visibilitychange', visibilityChanged)
    run.scenario?.dispose()
  }
  if (scenario) {
    run.scenario = createScenario(scenario, {
      totalBytes: bytes,
      onChange: () => { if (active === run && run.lastHookState) report(run, run.lastHookState) },
      onTimeout: () => { if (active === run) stopRun(run, 'deadline') }
    })
    document.addEventListener('visibilitychange', visibilityChanged)
    visibilityChanged()
    let lastHeartbeat = Date.now()
    heartbeat = setInterval(() => {
      const now = Date.now()
      if (now - lastHeartbeat > 10_000) {
        if (run.sinkEvents.length >= 300) run.sinkEvents.splice(10, 1)
        run.sinkEvents.push({ type: 'timer-gap', at: new Date(now).toISOString(),
          gapMs: now - lastHeartbeat, visibility: document.visibilityState,
          note: 'May reflect sleep, throttling or a busy event loop; not proof of sleep.' })
      }
      lastHeartbeat = now
      if (active === run && run.lastHookState) report(run, run.lastHookState)
    }, 1000)
  }
  report(run, { status: 'preparing', totalBytes: bytes, bytesDone: 0, totalFiles: files.length,
    filesDone: 0, failedSoFar: [], verificationFailures: [], pass: 1 })
  try {
    const serviceWorkerUrl = new URL('./reusable-components/zip-download-sw.js', import.meta.url).href
    const sink = await createServiceWorkerSink({
      url: serviceWorkerUrl, transferStreams, transferChunks, holdWorkerUntilComplete,
      ...(cancellationProbe ? { navigate: (url: string) => consumeProbe(run, url) } : {}),
      onEvent: (event) => {
        if (typeof event.bytes === 'number') run.workerBytes = event.bytes
        const last = run.sinkEvents.at(-1)
        // Keep diagnostics bounded and sample progress; always retain terminal messages.
        if (event.type !== 'zipdl-progress' || !last || performance.now() - last.elapsedMs >= 5000) {
          if (run.sinkEvents.length >= 300) run.sinkEvents.splice(10, 1)
          run.sinkEvents.push({ ...event, at: new Date().toISOString(), elapsedMs: performance.now() - run.startedAt })
        }
        if (active === run && run.lastHookState) report(run, run.lastHookState)
      }
    })
    if (run.cancelled) return
    if (!sink) throw new Error('The download service worker is unavailable.')
    run.transport = sink.streaming
      ? (transferStreams ?? transferableStreamsSupported()) ? 'transferable-stream' : 'message-channel'
      : 'buffered-blob'
    if (run.scenario && !sink.streaming) {
      run.scenario.unsupported(run.transport)
      throw new Error('This diagnostic requires a streaming service worker. The current browser selected the buffered fallback; the result is inconclusive.')
    }
    restoreFetch = installSyntheticFetch(run, files)
    hookApi.start({ files, zipName: run.filename, serviceWorkerUrl, sink: {
      ...sink,
      save: (request) => sink.save({ ...request, ...(exactLength ? { expectedBytes: run.zipBytes } : {}) })
    } })
  } catch (error) {
    run.scenario?.finish('error')
    run.cleanup()
    if (active === run) active = null
    report(run, { status: 'error', message: error instanceof Error ? error.message : String(error),
      totalBytes: bytes, bytesDone: run.generatedBytes, totalFiles: files.length, filesDone: 0,
      failedSoFar: [], verificationFailures: [], pass: 1 })
    throw error
  }
}

function consumeProbe(run: any, url: string) {
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.src = new URL('./reusable-components/check.html', import.meta.url).href
  run.probeConsumer = { type: 'controlled-frame-fetch', status: 'starting' }
  frame.onload = () => {
    void (async () => {
      try {
        const response = await frame.contentWindow!.fetch(url)
        if (!response.ok || !response.body) throw new Error('The internal stream probe did not start.')
        run.probeConsumer.status = 'reading'
        const reader = response.body.getReader()
        while (!(await reader.read()).done) { /* Consume the real worker stream without a native download. */ }
        run.probeConsumer.status = 'ended'
      } catch (error) {
        run.probeConsumer.status = 'errored'
        run.probeConsumer.error = error instanceof Error ? error.message : String(error)
      }
      if (run.lastHookState) report(run, run.lastHookState)
    })()
  }
  document.body.appendChild(frame)
  return () => frame.remove()
}

export function cancel({ automatic = false } = {}) {
  if (!active) return
  stopRun(active, 'cancel', automatic)
}

function stopRun(run: any, reason: 'cancel' | 'deadline', automatic = false) {
  if (reason === 'cancel') run.scenario?.decision('cancel', automatic ? 'automation' : 'user')
  run.cancelled = true
  hookApi.cancel()
  run.scenario?.finish('cancelled')
  run.cleanup()
  report(run, { ...(run.lastHookState ?? hookApi.state), status: 'cancelled' })
  if (active === run) active = null
}

export function retry({ automatic = false } = {}) {
  if (!active || hookApi.state.status !== 'paused') return
  active.scenario?.decision('retry', automatic ? 'automation' : 'user')
  hookApi.retryCurrent()
}

export function checkCancellation({ onState, transferStreams, signal }: {
  onState?: (state: any) => void
  transferStreams?: boolean
  signal?: AbortSignal
} = {}): Promise<{ passed: boolean; reason?: string; result: any }> {
  if (active) return Promise.reject(new Error('A ZIP download is already running.'))
  signal?.throwIfAborted()
  return new Promise((resolve) => {
    let latest: any = null
    let stoppedAutomatically = false
    let finished = false
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (passed: boolean, reason?: string) => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      clearTimeout(stopTimer)
      clearTimeout(settleTimer)
      signal?.removeEventListener('abort', abort)
      resolve({ passed, reason, result: {
        ...latest,
        nativeDownloadOutcome: 'No native download is created by the internal controlled-frame probe. The main ZIP uses the native download sink.'
      } })
    }
    const abort = () => {
      cancel()
      finish(false, 'The tester stopped the check.')
    }
    const deadline = setTimeout(() => {
      finish(false, 'The cancellation setup did not finish within one minute.')
      cancel({ automatic: true })
    }, 60_000)
    signal?.addEventListener('abort', abort, { once: true })
    void start({
      bytes: 64 * 1024 ** 2, scenario: 'cancel', transferStreams, cancellationProbe: true,
      onState: (state) => {
        latest = state
        onState?.(state)
        if (finished) return
        if (state.status === 'running' && !stoppedAutomatically && state.scenario?.phase === 'source-silence') {
          stoppedAutomatically = true
          stopTimer = setTimeout(() => cancel({ automatic: true }), 500)
        }
        if (state.status === 'cancelled') {
          if (!stoppedAutomatically || signal?.aborted) { finish(false, 'The tester stopped the check.'); return }
          const stoppedBytes = state.generatedBytes
          clearTimeout(settleTimer)
          settleTimer = setTimeout(() => {
            const passed = !active && latest.generatedBytes === stoppedBytes &&
              latest.scenario?.pendingWaitMs === 0 &&
              latest.scenario?.events.some((event: any) => event.type === 'automation-cancel') &&
              latest.scenario?.events.some((event: any) => event.type === 'frontend-fetch-aborted' && event.pendingWaitMs > 0) &&
              latest.probeConsumer?.status === 'errored'
            finish(passed, passed ? undefined : 'Source cancellation and its stream consumer did not finish cleanly.')
          }, state.probeConsumer?.status === 'errored' ? 200 : 3000)
        } else if (['done', 'error'].includes(state.status)) {
          finish(false, state.message || 'The cancellation check did not reach its expected stopping point.')
        }
      }
    }).catch((error) => finish(false, error.message))
  })
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

// Small protocol comparisons run through the actual worker before the one native ZIP.
// They are internal response checks, not native-download or saved-file evidence.
export async function checkProtocol({ signal }: { signal?: AbortSignal } = {}) {
  const serviceWorkerUrl = new URL('./reusable-components/zip-download-sw.js', import.meta.url).href
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.src = new URL('./reusable-components/check.html', import.meta.url).href
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Protocol check frame did not load.')), 10_000)
    frame.onload = () => { clearTimeout(timer); resolve() }
    frame.onerror = () => { clearTimeout(timer); reject(new Error('Protocol check frame failed.')) }
  })
  document.body.appendChild(frame)
  const cases: any[] = []
  try {
    await ready
    const variants = [
      { name: 'cloned-chunks', transferStreams: false, transferChunks: false },
      { name: 'transferred-chunks', transferStreams: false, transferChunks: true },
      { name: 'declared-length', transferStreams: false, exactLength: true },
      { name: 'incorrect-length', transferStreams: false, exactLength: true, truncate: true },
      { name: 'worker-lifetime', transferStreams: false, holdWorkerUntilComplete: true },
      ...(transferableStreamsSupported() ? [{ name: 'transferred-stream', transferStreams: true }] : [])
    ]
    for (const variant of variants) {
      signal?.throwIfAborted()
      const caseStarted = performance.now()
      const total = 1024 * 1024 + 17
      const events: any[] = []
      let consumed = 0
      let responseError: string | undefined
      let contentLength: string | null = null
      let consumer: Promise<void> | undefined
      let savingError: string | undefined
      const caseController = new AbortController()
      const abortCase = () => caseController.abort(signal?.reason)
      signal?.addEventListener('abort', abortCase, { once: true })
      const timer = setTimeout(() => caseController.abort(new Error('Protocol check timed out.')), 15_000)
      try {
        const sink = await createServiceWorkerSink({
          url: serviceWorkerUrl, ...variant, firstByteMs: 10_000, completionMs: 10_000,
          onEvent: (event) => events.push(event),
          navigate: (url) => {
            consumer = (async () => {
              const response = await frame.contentWindow!.fetch(url, { signal: caseController.signal })
              if (!response.ok || !response.body) throw new Error('Protocol response unavailable')
              contentLength = response.headers.get('content-length')
              const reader = response.body.getReader()
              for (;;) {
                const next = await reader.read()
                if (next.done) break
                for (const byte of next.value) {
                  if (byte !== 42) throw new Error('Protocol payload bytes changed')
                }
                consumed += next.value.byteLength
              }
            })().catch((error) => { responseError = String(error) })
            return () => {}
          }
        })
        if (!sink) throw new Error('Protocol check requires the download worker')
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new Uint8Array(total).fill(42)); controller.close() }
        })
        await sink.save({ name: "protocol's (test)*.zip", body: stream, signal: caseController.signal,
          ...(variant.exactLength ? { expectedBytes: total + (variant.truncate ? 1 : 0) } : {})
        }).catch((error) => { savingError = String(error) })
        await consumer
        signal?.throwIfAborted()
        const passed = variant.truncate
          ? Boolean(savingError && responseError && events.some((event) => event.type === 'zipdl-error'))
          : !savingError && !responseError && consumed === total
            && events.some((event) => event.type === 'zipdl-closed' && event.bytes === total)
            && contentLength === (variant.exactLength ? String(total) : null)
        cases.push({ ...variant, elapsedMs: performance.now() - caseStarted, passed, consumed, contentLength, savingError, responseError, events })
        if (!passed) return { passed: false, cases }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abortCase)
        caseController.abort()
      }
    }
    return { passed: true, cases, scope: 'Internal worker responses; main native ZIP must still be saved and verified.' }
  } finally { frame.remove() }
}
