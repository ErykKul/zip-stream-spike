import { MIB } from './payload.mjs'

export const scenarios = Object.freeze({
  complete: Object.freeze({
    id: 'complete', title: 'Complete browser ZIP test', bytes: null, payloadFromSelection: true,
    minDurationMs: 720_000, expectedDurationMs: 720_000, maxDurationMs: 2_700_000,
    description: 'The selected payload, simulated failures and automatic Retry, a 45-second quiet interval, and at least 12 minutes of stream lifetime. Source generation stops after 45 minutes if unfinished.'
  }),
  recovery: Object.freeze({
    id: 'recovery', title: 'Retry and resume', bytes: 64 * MIB,
    expectedDurationMs: 60_000, maxDurationMs: 180_000,
    description: 'One simulated HTTP 503, a broken response at 3 MiB, manual Retry, then 45 seconds of source silence.'
  }),
  background: Object.freeze({
    id: 'background', title: 'Background worker lifetime', bytes: 64 * MIB,
    expectedDurationMs: 685_000, maxDurationMs: 900_000,
    description: '64 MiB paced over about 12 minutes, including 45 seconds of source silence. Leave this tab in the background.'
  }),
  cancel: Object.freeze({
    id: 'cancel', title: 'Cancel a waiting download', bytes: 64 * MIB,
    expectedDurationMs: 60_000, maxDurationMs: 120_000,
    description: 'After 3 MiB, the source waits for 45 seconds. Stop the test or cancel the browser download while it waits.'
  })
})

const BODY_ERROR_OFFSET = 3 * MIB
const SILENCE_OFFSET = 16 * MIB
const SILENCE_MS = 45_000
const CHUNK_DELAY_MS = 2_500
const abortError = () => new DOMException('Diagnostic source cancelled', 'AbortError')

// Environment injection is confined to this module's unit tests. The browser engine
// always uses real time and the published durations above.
export function createScenario(id, {
  totalBytes, onChange = () => {}, onTimeout = () => {},
  environment = {
    now: () => Date.now(),
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (timer) => globalThis.clearTimeout(timer)
  }
} = {}) {
  const definition = scenarios[id]
  if (!definition) throw new Error(`Unknown diagnostic scenario: ${id}`)
  if (id === 'complete' && (!Number.isSafeInteger(totalBytes) || totalBytes < 64 * MIB || totalBytes % MIB)) {
    throw new Error('The complete diagnostic requires a payload of at least 64 MiB, in whole MiB.')
  }
  const spec = id === 'complete' ? { ...definition, bytes: totalBytes } : definition
  const includesRecovery = id === 'recovery' || id === 'complete'
  const started = environment.now()
  const events = []
  const lifetime = new AbortController()
  let phase = 'preparing'
  let detail = spec.description
  let outcome = 'running'
  let timedOut = false
  let pendingWaitMs = 0
  let closed = false
  let sentHttpError = false
  let sentBodyError = false
  let checkedResume = false
  let resumeMatched = false
  let sentSilence = false
  let lifetimeSatisfied = false
  let holdingLifetime = false
  let sourceRequestCount = 0
  let lastRequest = null
  let lastHookStatus
  const elapsed = () => Math.max(0, environment.now() - started)
  const record = (type, fields = {}, notify = true) => {
    events.push({ type, at: new Date(environment.now()).toISOString(), elapsedMs: elapsed(), ...fields })
    if (notify && !closed) onChange()
  }
  const setPhase = (next, message) => { phase = next; detail = message }
  const expire = () => {
    if (closed || outcome !== 'running') return
    timedOut = true
    outcome = 'inconclusive'
    setPhase('timed-out', 'The diagnostic time limit was reached. This is inconclusive, not a successful download.')
    record('deadline-exceeded', { maxDurationMs: spec.maxDurationMs })
    lifetime.abort(abortError())
    onTimeout()
  }
  const deadlineTimer = environment.setTimeout(expire, spec.maxDurationMs)
  const checkDeadline = () => {
    if (elapsed() >= spec.maxDurationMs) expire()
    lifetime.signal.throwIfAborted()
  }
  const wait = (milliseconds, signal) => {
    checkDeadline()
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      let timer
      const finish = (error) => {
        environment.clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        lifetime.signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      const abort = () => finish(abortError())
      signal?.addEventListener('abort', abort, { once: true })
      lifetime.signal.addEventListener('abort', abort, { once: true })
      timer = environment.setTimeout(() => {
        try { checkDeadline(); finish() } catch (error) { finish(error) }
      }, milliseconds)
    })
  }

  record('scenario-start', {}, false)
  return {
    snapshot() {
      return { ...spec, startedAt: new Date(started).toISOString(), elapsedMs: elapsed(),
        phase, detail, outcome, timedOut, pendingWaitMs, sourceRequestCount, lastRequest,
        sourceRequestSampling: id === 'complete' ? 'First 12 and every 256th request; faults and the resumed request are always recorded.' : 'Every request',
        events: events.map((event) => ({ ...event })) }
    },
    beforeRequest(request) {
      checkDeadline()
      sourceRequestCount++
      lastRequest = { ...request }
      if (id !== 'complete' || sourceRequestCount <= 12 || sourceRequestCount % 256 === 0) {
        record('source-request', { ...request, requestNumber: sourceRequestCount })
      }
      if (includesRecovery && request.fileIndex === 0) {
        if (!sentHttpError) {
          sentHttpError = true
          setPhase('http-retry', 'The synthetic source returned HTTP 503. The frontend retries automatically.')
          record('http-error', { ...request, status: 503 })
          return { status: 503 }
        }
        if (sentBodyError && !checkedResume) {
          checkedResume = true
          const matched = request.from === BODY_ERROR_OFFSET
          resumeMatched = matched
          setPhase('resuming', `The frontend requested the next bytes from offset ${request.from}.`)
          record('resumed-request', { ...request, expectedFrom: BODY_ERROR_OFFSET, matched })
          if (!matched) throw new Error(`Diagnostic resume started at ${request.from}; expected ${BODY_ERROR_OFFSET}.`)
        }
      }
      return null
    },
    async beforeChunk({ fileIndex, offset, signal, isFinalChunk = false }) {
      checkDeadline()
      signal?.throwIfAborted()
      if (includesRecovery && fileIndex === 0 && !sentBodyError && offset >= BODY_ERROR_OFFSET) {
        sentBodyError = true
        setPhase('interrupted', id === 'complete'
          ? 'The synthetic response broke at 3 MiB. The test will request Retry after the frontend pauses.'
          : 'The synthetic response broke at 3 MiB. Wait for the frontend to pause, then choose Retry.')
        record('body-error', { fileIndex, offset })
        throw new Error('Simulated response-body interruption at 3 MiB. Choose Retry to resume.')
      }
      const silenceAt = id === 'cancel' ? BODY_ERROR_OFFSET : SILENCE_OFFSET
      if (!sentSilence && fileIndex === 0 && offset >= silenceAt) {
        sentSilence = true
        pendingWaitMs = SILENCE_MS
        const gapStart = environment.now()
        setPhase('source-silence', id === 'cancel'
          ? 'The source is deliberately quiet for 45 seconds. Cancel now using Stop or the browser download manager.'
          : 'The source is deliberately quiet for 45 seconds. Keepalive and the download stream remain active.')
        record('source-silence-start', { fileIndex, offset, durationMs: SILENCE_MS })
        try {
          await wait(SILENCE_MS, signal)
          setPhase('transferring', 'The quiet interval ended. The synthetic source is sending bytes again.')
          pendingWaitMs = 0
          record('source-silence-end', { fileIndex, offset, actualDurationMs: environment.now() - gapStart })
        } catch (error) {
          pendingWaitMs = 0
          record('source-silence-aborted', { fileIndex, offset, actualDurationMs: environment.now() - gapStart })
          throw error
        }
      }
      if (id === 'background' || (id === 'cancel' && sentSilence)) await wait(CHUNK_DELAY_MS, signal)
      if (id === 'complete' && isFinalChunk && !lifetimeSatisfied && !holdingLifetime) {
        holdingLifetime = true
        const remaining = Math.max(0, spec.minDurationMs - elapsed())
        if (remaining > 0) {
          pendingWaitMs = remaining
          const holdStart = environment.now()
          setPhase('lifetime-hold', 'The payload is almost ready. The last chunk waits until the stream has remained open for 12 minutes.')
          record('lifetime-hold-start', { fileIndex, offset, durationMs: remaining, minDurationMs: spec.minDurationMs })
          try {
            await wait(remaining, signal)
            pendingWaitMs = 0
            record('lifetime-hold-end', { fileIndex, offset, actualDurationMs: environment.now() - holdStart, minDurationMs: spec.minDurationMs })
          } catch (error) {
            pendingWaitMs = 0
            record('lifetime-hold-aborted', { fileIndex, offset, actualDurationMs: environment.now() - holdStart })
            throw error
          } finally {
            holdingLifetime = false
          }
        } else {
          holdingLifetime = false
          record('lifetime-already-covered', { fileIndex, offset, minDurationMs: spec.minDurationMs })
        }
        lifetimeSatisfied = elapsed() >= spec.minDurationMs
        setPhase('transferring', 'The stream lifetime check is complete. Sending the final payload bytes.')
      }
      checkDeadline()
      signal?.throwIfAborted()
    },
    sourceAborted(fields) { record('frontend-fetch-aborted', fields) },
    readerCancelled(fields) { record('source-reader-cancel', fields) },
    visibility(state) {
      if (closed) return
      record('visibility-change', { visibilityState: state })
      if (elapsed() >= spec.maxDurationMs) expire()
    },
    decision(action, actor = 'user') {
      record(`${actor}-${action}`)
      if (action === 'retry') setPhase('resuming', 'Retry was requested. Waiting for the frontend range request.')
    },
    hookState(state) {
      if (state.status === lastHookStatus) return
      lastHookStatus = state.status
      if (!timedOut && state.status === 'paused') {
        setPhase('paused', id === 'complete'
          ? 'The frontend paused after the simulated failure. The test will request Retry automatically.'
          : 'The frontend paused after the simulated failure. Choose Retry to continue from the delivered offset.')
      }
      record('engine-state', { status: state.status, bytesDone: state.bytesDone }, false)
    },
    unsupported(transport) {
      outcome = 'inconclusive'
      setPhase('unsupported', 'This diagnostic requires a service-worker stream; a buffered download cannot exercise it.')
      record('unsupported-transport', { transport })
    },
    finish(status) {
      if (outcome === 'running' && status === 'done' && id === 'complete' &&
        !(sentHttpError && sentBodyError && resumeMatched && sentSilence && lifetimeSatisfied)) {
        outcome = 'inconclusive'
        setPhase('incomplete', 'The source completed without exercising every required interruption and stream lifetime check.')
        record('incomplete-scenario', { sentHttpError, sentBodyError, checkedResume, resumeMatched, sentSilence, lifetimeSatisfied }, false)
      }
      if (outcome === 'running') {
        outcome = status === 'done' ? 'source-complete' : status === 'cancelled' ? 'cancelled' : 'error'
        setPhase(status === 'done' ? 'complete' : status === 'cancelled' ? 'stopped' : 'error',
          status === 'done' ? 'The source completed. Verify the saved ZIP to check recovery and integrity.'
            : status === 'cancelled' ? 'The test was cancelled.' : 'The frontend reported an error. The result includes the event sequence.')
        record('scenario-finished', { engineStatus: status }, false)
      }
      pendingWaitMs = 0
    },
    dispose() {
      if (closed) return
      closed = true
      environment.clearTimeout(deadlineTimer)
      lifetime.abort(abortError())
    }
  }
}
