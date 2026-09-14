import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScenario, scenarios } from '../src/scenarios.mjs'
import { MIB, GIB, PATTERN_BYTES } from '../src/payload.mjs'

function clock() {
  let current = 0
  let nextId = 0
  const timers = new Map()
  return {
    environment: {
      now: () => current,
      setTimeout: (callback, delay) => { const id = ++nextId; timers.set(id, { at: current + delay, callback }); return id },
      clearTimeout: (id) => timers.delete(id)
    },
    async advance(milliseconds) {
      const target = current + milliseconds
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        current = next[1].at
        timers.delete(next[0])
        next[1].callback()
        await Promise.resolve()
      }
      current = target
      await Promise.resolve()
    },
    pending: () => timers.size
  }
}
const request = (from = 0) => ({ fileIndex: 0, from, to: from + 10 * MIB - 1, range: `bytes=${from}-${from + 10 * MIB - 1}` })

test('diagnostics keep the payload small and have explicit real-time limits', () => {
  assert.deepEqual(Object.keys(scenarios), ['complete', 'recovery', 'background', 'cancel'])
  for (const scenario of [scenarios.recovery, scenarios.background, scenarios.cancel]) {
    assert.equal(scenario.bytes, 64 * MIB)
    assert.ok(scenario.maxDurationMs <= 15 * 60_000)
    assert.ok(scenario.expectedDurationMs <= scenario.maxDurationMs)
  }
  assert.equal(scenarios.background.expectedDurationMs, (64 * MIB / (256 * 1024)) * 2500 + 45_000)
  assert.throws(() => createScenario('invalid'), /Unknown diagnostic/)
  assert.equal(scenarios.complete.minDurationMs, 12 * 60_000)
  assert.equal(scenarios.complete.maxDurationMs, 45 * 60_000)
  assert.throws(() => createScenario('complete'), /at least 64 MiB/)
  assert.throws(() => createScenario('complete', { totalBytes: 16 * MIB }), /at least 64 MiB/)
})

test('recovery injects one HTTP error, one body error, exact-offset resume, and a measured quiet interval', async () => {
  const time = clock()
  const scenario = createScenario('recovery', { environment: time.environment })
  assert.deepEqual(scenario.beforeRequest(request()), { status: 503 })
  assert.equal(scenario.beforeRequest(request()), null)
  await scenario.beforeChunk({ fileIndex: 0, offset: 0 })
  await assert.rejects(scenario.beforeChunk({ fileIndex: 0, offset: 3 * MIB }), /Simulated response-body interruption/)
  scenario.hookState({ status: 'paused', bytesDone: 3 * MIB })
  assert.equal(scenario.snapshot().phase, 'paused')
  scenario.decision('retry')
  assert.equal(scenario.beforeRequest(request(3 * MIB)), null)
  await scenario.beforeChunk({ fileIndex: 0, offset: 3 * MIB })
  let complete = false
  const quiet = scenario.beforeChunk({ fileIndex: 0, offset: 16 * MIB }).then(() => { complete = true })
  assert.equal(scenario.snapshot().phase, 'source-silence')
  await time.advance(44_999)
  assert.equal(complete, false)
  await time.advance(1)
  await quiet
  assert.equal(complete, true)
  await scenario.beforeChunk({ fileIndex: 0, offset: 17 * MIB })
  const events = scenario.snapshot().events
  assert.equal(events.filter((event) => event.type === 'http-error').length, 1)
  assert.equal(events.filter((event) => event.type === 'body-error').length, 1)
  assert.equal(events.find((event) => event.type === 'resumed-request').matched, true)
  assert.equal(events.filter((event) => event.type === 'source-silence-start').length, 1)
  assert.equal(events.find((event) => event.type === 'source-silence-end').actualDurationMs, 45_000)
  scenario.finish('done')
  scenario.dispose()
  assert.equal(scenario.snapshot().outcome, 'source-complete')
  assert.equal(time.pending(), 0)
})

test('recovery rejects a resumed request at the wrong offset', async () => {
  const time = clock()
  const scenario = createScenario('recovery', { environment: time.environment })
  scenario.beforeRequest(request())
  scenario.beforeRequest(request())
  await assert.rejects(scenario.beforeChunk({ fileIndex: 0, offset: 3 * MIB }))
  assert.throws(() => scenario.beforeRequest(request(0)), /expected 3145728/)
  assert.equal(scenario.snapshot().events.find((event) => event.type === 'resumed-request').matched, false)
  scenario.dispose()
})

test('stopping during source silence immediately aborts the read and removes timers', async () => {
  const time = clock()
  const scenario = createScenario('cancel', { environment: time.environment })
  const quiet = scenario.beforeChunk({ fileIndex: 0, offset: 3 * MIB })
  const rejected = assert.rejects(quiet, { name: 'AbortError' })
  await time.advance(1_000)
  scenario.decision('cancel')
  scenario.finish('cancelled')
  scenario.dispose()
  await rejected
  const snapshot = scenario.snapshot()
  assert.equal(snapshot.outcome, 'cancelled')
  assert.equal(snapshot.pendingWaitMs, 0)
  assert.ok(snapshot.events.some((event) => event.type === 'source-silence-aborted'))
  assert.ok(!snapshot.events.some((event) => event.type === 'source-silence-end'))
  assert.equal(time.pending(), 0)
})

test('source-reader cancellation aborts just its waiting read', async () => {
  const time = clock()
  const scenario = createScenario('background', { environment: time.environment })
  const abort = new AbortController()
  const read = scenario.beforeChunk({ fileIndex: 0, offset: 16 * MIB, signal: abort.signal })
  const rejected = assert.rejects(read, { name: 'AbortError' })
  abort.abort()
  await rejected
  assert.equal(time.pending(), 1, 'only the overall deadline remains')
  scenario.dispose()
  assert.equal(time.pending(), 0)
})

test('the deadline is inconclusive and cannot become a pass or ordinary cancellation', async () => {
  const time = clock()
  let deadlines = 0
  const scenario = createScenario('background', { environment: time.environment, onTimeout: () => { deadlines++ } })
  scenario.visibility('hidden')
  await time.advance(900_000)
  scenario.finish('cancelled')
  assert.equal(deadlines, 1)
  assert.equal(scenario.snapshot().timedOut, true)
  assert.equal(scenario.snapshot().outcome, 'inconclusive')
  await assert.rejects(scenario.beforeChunk({ fileIndex: 0, offset: 0 }), { name: 'AbortError' })
  scenario.dispose()
  assert.equal(time.pending(), 0)
})

test('a buffered fallback is inconclusive before source bytes are sent', () => {
  const time = clock()
  const scenario = createScenario('recovery', { environment: time.environment })
  scenario.unsupported('buffered-blob')
  scenario.finish('error')
  scenario.dispose()
  assert.equal(scenario.snapshot().phase, 'unsupported')
  assert.equal(scenario.snapshot().outcome, 'inconclusive')
  assert.equal(scenario.snapshot().events.filter((event) => event.type === 'source-request').length, 0)
  assert.equal(time.pending(), 0)
})

async function exerciseRecovery(scenario, time) {
  assert.deepEqual(scenario.beforeRequest(request()), { status: 503 })
  assert.equal(scenario.beforeRequest(request()), null)
  await assert.rejects(scenario.beforeChunk({ fileIndex: 0, offset: 3 * MIB }), /Simulated response-body interruption/)
  scenario.hookState({ status: 'running', bytesDone: 3 * MIB })
  assert.equal(scenario.beforeRequest(request(3 * MIB)), null)
  const quiet = scenario.beforeChunk({ fileIndex: 0, offset: 16 * MIB })
  await time.advance(45_000)
  await quiet
}

test('complete test combines recovery and a final-chunk hold to exactly twelve minutes', async () => {
  const time = clock()
  const scenario = createScenario('complete', { totalBytes: 35 * GIB, environment: time.environment })
  assert.equal(scenario.snapshot().bytes, 35 * GIB)
  await exerciseRecovery(scenario, time)
  await scenario.beforeChunk({ fileIndex: 0, offset: 5 * GIB - PATTERN_BYTES, isFinalChunk: false })
  assert.ok(!scenario.snapshot().events.some((event) => event.type === 'lifetime-hold-start'))
  let finished = false
  const finalChunk = scenario.beforeChunk({ fileIndex: 6, offset: 5 * GIB - PATTERN_BYTES, isFinalChunk: true })
    .then(() => { finished = true })
  assert.equal(scenario.snapshot().phase, 'lifetime-hold')
  assert.equal(scenario.snapshot().pendingWaitMs, 675_000)
  await time.advance(674_999)
  assert.equal(finished, false)
  await time.advance(1)
  await finalChunk
  assert.equal(scenario.snapshot().elapsedMs, 720_000)
  scenario.finish('done')
  scenario.dispose()
  const snapshot = scenario.snapshot()
  assert.equal(snapshot.outcome, 'source-complete')
  assert.equal(snapshot.events.find((event) => event.type === 'lifetime-hold-end').actualDurationMs, 675_000)
  assert.ok(!snapshot.events.some((event) => event.type === 'automation-retry'))
  assert.ok(!snapshot.events.some((event) => event.type === 'user-retry'))
  assert.equal(time.pending(), 0)
})

test('complete test adds no lifetime delay when natural transfer already exceeds twelve minutes', async () => {
  const time = clock()
  const scenario = createScenario('complete', { totalBytes: 35 * GIB, environment: time.environment })
  await exerciseRecovery(scenario, time)
  await time.advance(800_000)
  const before = scenario.snapshot().elapsedMs
  await scenario.beforeChunk({ fileIndex: 6, offset: 5 * GIB - PATTERN_BYTES, isFinalChunk: true })
  assert.equal(scenario.snapshot().elapsedMs, before)
  const events = scenario.snapshot().events
  assert.ok(events.some((event) => event.type === 'lifetime-already-covered'))
  assert.ok(!events.some((event) => event.type === 'lifetime-hold-start'))
  scenario.finish('done')
  scenario.dispose()
  assert.equal(scenario.snapshot().outcome, 'source-complete')
  assert.equal(time.pending(), 0)
})

test('cancelling the complete test during its lifetime hold releases the pending read immediately', async () => {
  const time = clock()
  const scenario = createScenario('complete', { totalBytes: 64 * MIB, environment: time.environment })
  await exerciseRecovery(scenario, time)
  const hold = scenario.beforeChunk({ fileIndex: 0, offset: 64 * MIB - PATTERN_BYTES, isFinalChunk: true })
  const rejected = assert.rejects(hold, { name: 'AbortError' })
  scenario.decision('cancel', 'automation')
  scenario.finish('cancelled')
  scenario.dispose()
  await rejected
  assert.equal(scenario.snapshot().outcome, 'cancelled')
  assert.equal(scenario.snapshot().pendingWaitMs, 0)
  assert.ok(scenario.snapshot().events.some((event) => event.type === 'lifetime-hold-aborted'))
  assert.equal(time.pending(), 0)
})

test('complete test cannot claim source completion when required recovery or lifetime checks were skipped', async () => {
  const time = clock()
  const scenario = createScenario('complete', { totalBytes: 64 * MIB, environment: time.environment })
  await exerciseRecovery(scenario, time)
  scenario.finish('done')
  scenario.dispose()
  assert.equal(scenario.snapshot().outcome, 'inconclusive')
  assert.equal(scenario.snapshot().phase, 'incomplete')
  assert.equal(scenario.snapshot().events.find((event) => event.type === 'incomplete-scenario').lifetimeSatisfied, false)
  assert.equal(time.pending(), 0)
})

test('complete test stops an unfinished source at forty-five minutes without labelling it successful', async () => {
  const time = clock()
  let expired = false
  const scenario = createScenario('complete', {
    totalBytes: 35 * GIB, environment: time.environment, onTimeout: () => { expired = true }
  })
  await time.advance(2_700_000)
  assert.equal(expired, true)
  scenario.finish('cancelled')
  scenario.dispose()
  assert.equal(scenario.snapshot().timedOut, true)
  assert.equal(scenario.snapshot().outcome, 'inconclusive')
  assert.equal(time.pending(), 0)
})

test('large complete tests sample ordinary requests while retaining exact counters and recovery events', async () => {
  const time = clock()
  const scenario = createScenario('complete', { totalBytes: 35 * GIB, environment: time.environment })
  await exerciseRecovery(scenario, time)
  for (let index = 0; index < 3_584; index++) {
    scenario.beforeRequest({ fileIndex: 1, from: index * 10 * MIB, to: index * 10 * MIB + 10 * MIB - 1, range: 'synthetic-test-range' })
  }
  const snapshot = scenario.snapshot()
  assert.equal(snapshot.sourceRequestCount, 3_587)
  assert.equal(snapshot.lastRequest.from, 3_583 * 10 * MIB)
  assert.equal(snapshot.events.filter((event) => event.type === 'source-request').length, 26)
  assert.equal(snapshot.events.find((event) => event.type === 'resumed-request').from, 3 * MIB)
  assert.match(snapshot.sourceRequestSampling, /every 256th/)
  scenario.dispose()
})
