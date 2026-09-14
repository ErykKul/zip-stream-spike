const $ = (id) => document.getElementById(id)
const GiB = 1024 ** 3
const MiB = 1024 ** 2
const STORAGE_KEY = 'dataverse-zip-check-v2'
// Remove the result left by earlier versions; current results belong to this tab only.
try { localStorage.removeItem(STORAGE_KEY) } catch { /* Storage is optional. */ }
function clearSavedSession() {
  try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* Storage is optional. */ }
}
window.addEventListener('pagehide', clearSavedSession)
const reloaded = performance.getEntriesByType('navigation')[0]?.type === 'reload'
if (reloaded) clearSavedSession()
const activeStatuses = new Set(['checking', 'preparing', 'running', 'paused', 'verifying'])
let engine
let result = null
let busy = false
let runId = 0
let verifyController = null
let suiteController = null
let lastPaint = 0
let lastStored = 0
let previousEngineStatus = ''

function bytes(value = 0) {
  return value >= GiB ? `${(value / GiB).toFixed(2)} GiB` : `${(value / MiB).toFixed(1)} MiB`
}
function duration(ms = 0) {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
function setBusy(value) {
  busy = value
  document.querySelectorAll('.ram-button, #smoke-test, #repeat-test, #new-test, [data-scenario]').forEach((button) => { button.disabled = value || !engine })
  $('cancel-run').hidden = !value
  $('verify-file').disabled = value || !engine
}
function store(force = false) {
  if (!result || (!force && Date.now() - lastStored < 1000)) return
  lastStored = Date.now()
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(result)) } catch { /* Private browsing may disable storage. */ }
}
function sampleHeap() {
  if (!result || !performance.memory) return
  const used = performance.memory.usedJSHeapSize
  result.jsHeap = { scope: 'JS heap only; excludes other browser processes and disk caches', firstBytes: result.jsHeap?.firstBytes ?? used, peakBytes: Math.max(result.jsHeap?.peakBytes ?? 0, used), lastBytes: used }
}
function showResult() {
  if (!result) return
  $('result-panel').hidden = false
  $('result-panel').dataset.outcome = result.status
  const large = result.ramGiB > 0 && result.targetPayloadBytes > result.ramGiB * GiB
  if (result.status === 'verified') {
    $('result-heading').textContent = result.suite?.passed ? 'Browser ZIP check passed' : large ? 'Large ZIP verified' : 'Small ZIP verified'
    $('result-summary').textContent = result.suite?.passed
      ? `${bytes(result.targetPayloadBytes)} was saved and verified. Automatic stopping, retry, resumed bytes, source silence, and the stream lifetime check passed. The report lists conditions that require a separate manual or real-server test.`
      : result.scenario
      ? 'The saved ZIP passed its integrity checks. The report records which interruptions occurred; manual actions and background exposure must be checked separately.'
      : large
      ? `${bytes(result.targetPayloadBytes)} of ZIP payload was saved and verified on this ${result.ramGiB} GB RAM computer. This records a successful run on this browser; it is not a measurement of its total memory use.`
      : 'The saved ZIP passed the integrity check. Next, choose your RAM size to test a larger download.'
  } else if (activeStatuses.has(result.status) && result.status !== 'verifying') {
    $('result-heading').textContent = result.status === 'checking' ? 'Checking stopping' : result.status === 'paused' && !result.suite ? 'Waiting for Retry' : 'Test in progress'
    $('result-summary').textContent = result.suite
      ? 'The automatic checks are running. Keep this tab open and your computer awake. The frontend retries the simulated interruptions automatically.'
      : result.status === 'paused'
      ? 'The source response was interrupted. Click Retry download above to continue from the saved position.'
      : 'The download is still running. A result is available after it finishes and the saved ZIP is checked.'
  } else if (result.status === 'inconclusive') {
    $('result-heading').textContent = result.scenario?.timedOut ? 'Check reached its time limit' : 'Check could not complete'
    $('result-summary').textContent = result.scenario?.timedOut
      ? 'The diagnostic was stopped at its time limit. This is an incomplete result; it does not identify the cause or establish browser support.'
      : result.error || result.scenario?.detail || 'The interruption check did not complete. Save the report with its recorded reason.'
  } else if (result.status === 'verifying') {
    $('result-heading').textContent = 'Verification in progress'
    $('result-summary').textContent = 'The saved ZIP is still being checked. Wait for verification to finish before reporting a pass or failure.'
  } else if (result.status === 'download-finished') {
    $('result-heading').textContent = 'Download sent · verification pending'
    $('result-summary').textContent = 'The browser consumed the ZIP stream. Its final save is not yet verified; choose the completed download above to check it.'
  } else if (result.status === 'cancelled') {
    $('result-heading').textContent = 'Test stopped'
    $('result-summary').textContent = result.suite
      ? 'The automatic check was stopped, and no further download will start. This run does not establish a complete browser-test pass.'
      : result.scenario
      ? 'The page reports that this run stopped. Check the browser download list and record its outcome above; a stopped page alone does not verify cancellation of the saved download.'
      : 'This run was stopped. It does not establish whether this browser supports the larger download.'
  } else if (result.status === 'interrupted') {
    $('result-heading').textContent = 'Previous test interrupted'
    $('result-summary').textContent = 'The page closed or reloaded before the run finished. The cause is unknown; this is not a memory-limit diagnosis.'
  } else {
    $('result-heading').textContent = 'Test did not pass'
    $('result-summary').textContent = result.error || 'The saved archive has not been verified.'
  }
  $('result-json').textContent = JSON.stringify(result, null, 2)
  store(true)
}
function handleState(state, id) {
  if (id !== runId || !result || ['failed', 'cancelled', 'verified', 'verification-failed'].includes(result.status)) return
  const terminal = ['done', 'error', 'cancelled', 'paused', 'awaiting-retry'].includes(state.status)
  const changed = previousEngineStatus !== state.status
  previousEngineStatus = state.status
  Object.assign(result, {
    status: state.status,
    engineStatus: state.status,
    transport: state.transport,
    diagnostic: state.diagnostic || result.diagnostic,
    filename: state.filename,
    downloadElapsedMs: state.elapsedMs,
    generatedBytes: state.generatedBytes,
    payloadBytesProcessed: state.bytesDone,
    rangeRequests: state.rangeRequests,
    filesDone: state.filesDone,
    totalFiles: state.totalFiles,
    failedFiles: state.failedSoFar,
    checksumFailures: state.verificationFailures
  })
  if (state.scenario) result.scenario = state.scenario
  sampleHeap()
  store(terminal || changed)
  if (!terminal && !changed && performance.now() - lastPaint < 150) return
  lastPaint = performance.now()
  $('bytes-progress').textContent = `${bytes(state.bytesDone)} / ${bytes(result.targetPayloadBytes)}`
  $('time-progress').textContent = duration(state.elapsedMs)
  $('progress').value = Math.min(1, (state.bytesDone || 0) / result.targetPayloadBytes)
  $('file-name').textContent = state.filename || ''
  $('retry-run').hidden = !(result.scenario && !result.suite && state.status === 'paused')
  if (result.scenario) {
    $('scenario-progress').textContent = `${result.scenario.title}: ${result.scenario.detail || result.scenario.phase}. ${duration(result.scenario.elapsedMs)} elapsed; limit ${duration(result.scenario.maxDurationMs)}.`
    if (result.scenario.timedOut || result.scenario.outcome === 'inconclusive') {
      result.status = 'inconclusive'
      result.verified = false
      if (result.suite) { result.suite.phase = 'inconclusive'; result.suite.passed = false }
      $('status-heading').textContent = result.scenario.timedOut ? 'Time limit reached' : 'Check could not complete'
      $('status-detail').textContent = result.scenario.detail || 'The diagnostic stopped before a complete verified result. Save the report so we can inspect where it stopped.'
      $('retry-run').hidden = true
      setBusy(false)
      showResult()
      return
    }
  }
  if (result.scenario && state.status === 'paused') {
    if (result.suite) {
      result.status = 'failed'
      result.suite.phase = 'failed'
      result.error = 'The frontend exhausted automatic recovery during the simulated interruption. Save the result for investigation.'
      $('status-heading').textContent = 'Automatic recovery did not pass'
      $('status-detail').textContent = result.error
      engine.cancel()
      setBusy(false)
      showResult()
      return
    }
    setBusy(true)
    $('status-heading').textContent = 'Retry needed'
    $('status-detail').textContent = 'Automatic retries were exhausted. Click Retry download to try again from the last delivered byte.'
    showResult()
    return
  }
  if (state.status === 'preparing' || state.status === 'running') {
    $('status-heading').textContent = result.scenario?.phase === 'lifetime-hold' ? 'Checking stream lifetime' : state.status === 'preparing' ? 'Preparing' : 'Downloading'
    if (result.scenario) $('status-detail').textContent = result.scenario.detail || 'The small diagnostic is running.'
    else if (changed) $('status-detail').textContent = state.status === 'preparing'
      ? 'Starting the browser download. If a save dialog appears, choose a folder on disk.'
      : 'The ZIP is being created and handed to your browser. Keep this tab open until it finishes.'
  } else if (state.status === 'done') {
    setBusy(false)
    result.finishedAt = new Date().toISOString()
    if (result.suite) {
      const events = result.scenario?.events || []
      result.suite.phase = 'verification-pending'
      result.suite.checks = {
        cancellation: result.suite.cancellation?.passed === true,
        retryAndResume: events.some((event) => event.type === 'http-error' && event.status === 503)
          && events.some((event) => event.type === 'body-error')
          && !events.some((event) => ['automation-retry', 'user-retry'].includes(event.type)
            || (event.type === 'engine-state' && event.status === 'paused'))
          && events.some((event) => event.type === 'resumed-request' && event.matched),
        sourceSilence: events.some((event) => event.type === 'source-silence-end' && event.actualDurationMs >= 45000),
        streamLifetime: result.scenario?.outcome === 'source-complete'
          && events.some((event) => ['lifetime-hold-end', 'lifetime-already-covered'].includes(event.type)),
        savedZip: false
      }
    }
    if ((state.verificationFailures?.length || 0) + (state.failedSoFar?.length || 0) > 0) {
      result.status = 'failed'
      result.error = 'The frontend reported missing files or checksum failures. This run did not pass.'
      $('status-heading').textContent = 'Failed'
      $('status-detail').textContent = result.error
    } else {
      result.status = 'download-finished'
      $('status-heading').textContent = 'Ready to verify'
      $('status-detail').textContent = 'All ZIP data was handed to the browser. Wait for its download to finish, then verify the saved file below.'
      $('verify-panel').hidden = false
    }
    showResult()
  } else if (terminal) {
    result.status = state.status === 'cancelled' ? 'cancelled' : 'failed'
    if (result.suite) { result.suite.phase = result.status; result.suite.passed = false }
    result.error = state.message || state.failedSoFar?.at(-1)?.error || 'The download did not complete.'
    $('status-heading').textContent = result.status === 'cancelled' ? 'Stopped' : 'Failed'
    $('status-detail').textContent = result.error
    if (state.status === 'paused' || state.status === 'awaiting-retry') engine.cancel()
    setBusy(false)
    showResult()
  }
}

async function startRun({ bytes: totalBytes, ramGiB = 0, transferStreams, scenario, suite = false } = {}) {
  await ready
  if (!engine) throw new Error('The test engine did not load.')
  if (busy) throw new Error('Stop the current test first.')
  if (suite) scenario = 'complete'
  const scenarioSpec = scenario ? engine.scenarios[scenario] : null
  if (scenario && !scenarioSpec) throw new Error('Unknown interruption check.')
  if (scenarioSpec?.bytes != null) totalBytes = scenarioSpec.bytes
  const id = ++runId
  const controller = suite ? new AbortController() : null
  suiteController = controller
  previousEngineStatus = ''
  result = {
    schema: 2,
    page: location.origin + location.pathname,
    startedAt: new Date().toISOString(),
    frontendCommit: engine.metadata.sourceCommit,
    engineBuildId: engine.metadata.buildId,
    frontendMechanismId: engine.metadata.frontendMechanismId,
    libraries: engine.metadata.libraries,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    browserBrands: navigator.userAgentData?.brands,
    ramGiB,
    targetPayloadBytes: totalBytes,
    testOptions: { bytes: totalBytes, ramGiB, scenario, suite, transferStreams },
    diagnostic: scenario || (transferStreams === false ? 'forced-message-channel' : false),
    scenario: scenarioSpec ? { ...scenarioSpec, bytes: totalBytes, phase: 'preparing', elapsedMs: 0, events: [] } : undefined,
    suite: suite ? {
      id: 'automatic-browser-check-v2', phase: 'cancellation-check', passed: false,
      cancellation: { passed: false, status: 'pending' },
      notCovered: [
        'Cancellation using the browser download-manager controls',
        'Native reload/close warning and the choice to leave or stay',
        'Real offline/reconnection, Dataverse authentication, CORS, and storage behavior',
        'OS sleep/wake; background coverage depends on the recorded visibility intervals'
      ]
    } : undefined,
    status: 'preparing',
    memoryObservation: 'not-measured',
    verified: false,
    limits: 'Synthetic local source. Does not test a Dataverse network, login, storage or prove flat total memory.'
  }
  setBusy(true)
  $('memory-observation').value = 'not-measured'
  $('copy-status').textContent = ''
  $('result-panel').hidden = true
  $('previous-run').hidden = true
  $('verify-panel').hidden = true
  $('verify-file').value = ''
  $('retry-run').hidden = true
  $('scenario-panel').hidden = !scenarioSpec
  $('manual-observations').hidden = Boolean(suite || scenario === 'complete')
  $('scenario-progress').textContent = ''
  $('diagnostic-action').value = 'not-recorded'
  $('download-observation').value = 'not-observed'
  $('guard-observation').value = 'not-checked'
  if (scenarioSpec) {
    $('scenario-instructions').textContent = scenario === 'complete'
      ? 'The stopping check runs first, followed by your large ZIP with automatic recovery and a stream lifetime check. Keep this tab open and the computer awake; no Retry click is needed.'
      : scenario === 'background'
      ? 'Once the download starts, use another tab for about 12 minutes. Leave this tab open and the computer awake, with developer tools closed. Return to verify the small ZIP; visibility changes are recorded.'
      : scenario === 'cancel'
        ? 'During the pause, try reloading and choose to stay when warned. Then stop the test here OR cancel in the browser download list. Record what you tried and what the download list reported. Repeat this small check for a different action.'
        : 'This check injects a failed response, interrupts a file body, and pauses data for 45 seconds. The frontend retries automatically; verify the completed ZIP afterward. The network remains connected.'
  }
  $('run-panel').hidden = false
  $('status-heading').textContent = 'Preparing'
  $('status-detail').textContent = 'Starting the browser download…'
  $('progress').value = 0
  $('progress').setAttribute('aria-label', 'Download progress')
  $('bytes-progress').textContent = `0 MiB / ${bytes(totalBytes)}`
  $('time-progress').textContent = '0:00'
  $('file-name').textContent = ''
  $('cancel-run').textContent = 'Stop test'
  document.querySelectorAll('.ram-button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.ram) === ramGiB)))
  $('status-heading').focus({ preventScroll: true })
  $('run-panel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' })
  store(true)
  try {
    if (suite) {
      result.status = 'checking'
      $('status-heading').textContent = 'Checking stopping'
      $('status-detail').textContent = 'Checking that a waiting stream stops cleanly. Your large ZIP download starts automatically afterward.'
      $('progress').removeAttribute('value')
      $('bytes-progress').textContent = 'Small stopping check'
      store(true)
      const cancellation = await engine.checkCancellation({
        signal: controller.signal,
        ...(transferStreams === false ? { transferStreams: false } : {}),
        onState: (state) => {
          if (id !== runId || controller.signal.aborted) return
          result.suite.cancellation = { passed: false, status: 'running', result: state }
          $('time-progress').textContent = duration(state.elapsedMs)
          $('scenario-progress').textContent = state.scenario?.detail || 'Checking whether a stopped source releases its pending read.'
          store()
        }
      })
      if (id !== runId || controller.signal.aborted) return
      result.suite.cancellation = cancellation
      if (!cancellation.passed) throw new Error(`The stopping check did not pass. ${cancellation.reason || 'The source did not confirm clean cancellation.'}`)
      result.suite.phase = 'download'
      result.status = 'preparing'
      $('status-heading').textContent = 'Starting your large ZIP'
      $('status-detail').textContent = 'Stopping passed. The main download now checks interruption recovery and stream lifetime automatically.'
      $('progress').value = 0
      $('bytes-progress').textContent = `0 MiB / ${bytes(totalBytes)}`
      $('time-progress').textContent = '0:00'
      store(true)
    }
    if (controller?.signal.aborted || id !== runId) return
    await engine.start({ bytes: totalBytes, onState: (state) => handleState(state, id), ...(scenario ? { scenario } : {}), ...(transferStreams === false ? { transferStreams: false } : {}) })
  } catch (error) {
    if (id !== runId) return
    if (controller?.signal.aborted) {
      result.status = 'cancelled'
      result.verified = false
      result.suite.phase = 'cancelled'
      $('status-heading').textContent = 'Stopped'
      $('status-detail').textContent = 'The automatic check was stopped. No further download will start.'
      setBusy(false)
      showResult()
      return
    }
    result.status = result.scenario?.outcome === 'inconclusive' ? 'inconclusive' : 'failed'
    if (result.suite) { result.suite.phase = result.status; result.suite.passed = false }
    result.error = error.message
    $('status-heading').textContent = result.status === 'inconclusive' ? 'Check could not complete' : 'Failed'
    $('status-detail').textContent = error.message
    setBusy(false)
    showResult()
  }
}

function startSuite(options = {}) {
  return startRun({ ...options, suite: true, scenario: 'complete' })
}

function newTest() {
  if (busy) return
  ++runId
  result = null
  suiteController = null
  clearSavedSession()
  for (const id of ['result-panel', 'run-panel', 'verify-panel', 'previous-run']) $(id).hidden = true
  $('verify-file').value = ''
  $('result-json').textContent = ''
  $('copy-status').textContent = ''
  $('memory-observation').value = 'not-measured'
  document.querySelectorAll('.ram-button').forEach((button) => button.setAttribute('aria-pressed', 'false'))
  $('pick-heading').scrollIntoView({ block: 'center' })
  document.querySelector('.ram-button').focus({ preventScroll: true })
}

async function verifyFile(file) {
  if (!file || !result || busy) return
  if (file.name.replace(/ \(\d+\)(?=\.zip$)/, '') !== result.filename) {
    result.status = 'verification-failed'
    result.verified = false
    if (result.suite) result.suite.passed = false
    result.error = `Choose ${result.filename}. The unique filename keeps this browser's result tied to this run; keep that filename when saving.`
    $('status-heading').textContent = 'Verification failed'
    $('status-detail').textContent = result.error
    $('verify-file').value = ''
    showResult()
    return
  }
  result.selectedFilename = file.name
  const id = runId
  verifyController = new AbortController()
  result.status = 'verifying'
  result.verified = false
  if (result.suite) { result.suite.phase = 'verification'; result.suite.passed = false }
  result.error = undefined
  result.verificationError = undefined
  result.verificationProgress = { bytesRead: 0, totalBytes: file.size, elapsedMs: 0 }
  setBusy(true)
  $('verify-file').disabled = true
  $('status-heading').textContent = 'Verifying saved ZIP'
  $('status-detail').textContent = 'Reading every saved entry and checking its contents. Nothing is uploaded.'
  $('cancel-run').textContent = 'Stop verification'
  $('progress').value = 0
  $('progress').setAttribute('aria-label', 'Verification progress')
  $('bytes-progress').textContent = `${bytes(0)} / ${bytes(file.size)}`
  $('time-progress').textContent = '0:00'
  showResult()
  try {
    const verification = await engine.verifySavedZip(file, {
      expectedPayloadBytes: result.targetPayloadBytes,
      signal: verifyController.signal,
      onProgress: (state) => {
        if (id !== runId) return
        result.verificationProgress = { bytesRead: state.bytesRead, totalBytes: state.totalBytes, elapsedMs: state.elapsedMs, lastProgressAt: new Date().toISOString() }
        store()
        $('progress').value = state.totalBytes ? state.bytesRead / state.totalBytes : 0
        $('bytes-progress').textContent = `${bytes(state.bytesRead)} / ${bytes(state.totalBytes)}`
        $('time-progress').textContent = duration(state.elapsedMs)
      }
    })
    if (id !== runId) return
    result.verification = verification
    if (result.suite) {
      result.suite.checks = { ...result.suite.checks, savedZip: verification.verified === true }
      result.suite.passed = result.scenario?.outcome === 'source-complete'
        && result.suite.cancellation?.passed === true
        && ['cancellation', 'retryAndResume', 'sourceSilence', 'streamLifetime', 'savedZip']
          .every((check) => result.suite.checks[check] === true)
      result.suite.phase = result.suite.passed ? 'complete' : 'inconclusive'
    }
    result.verified = verification.verified === true && (!result.suite || result.suite.passed)
    result.status = result.verified ? 'verified' : 'inconclusive'
    result.verifiedAt = new Date().toISOString()
    result.error = result.verified ? undefined : 'The saved ZIP verified, but a required automatic check is missing from this report. This is not a complete browser-test pass.'
    $('status-heading').textContent = result.suite?.passed ? 'Browser ZIP check passed' : result.verified ? 'ZIP verified' : 'ZIP verified · check incomplete'
    $('status-detail').textContent = result.error || (result.suite
      ? 'Automatic stopping, recovery, stream lifetime, and saved-file integrity checks passed. Copy or save your result below.'
      : 'The saved archive has the expected size, complete ZIP structure, and correct contents.')
    $('progress').value = 1
    $('verify-panel').hidden = true
  } catch (error) {
    if (id !== runId) return
    result.status = verifyController.signal.aborted ? 'download-finished' : 'verification-failed'
    result.verified = false
    result.error = verifyController.signal.aborted ? undefined : error.message
    result.verificationError = error.message
    if (result.suite) { result.suite.phase = verifyController.signal.aborted ? 'verification-pending' : 'verification-failed'; result.suite.passed = false }
    $('status-heading').textContent = verifyController.signal.aborted ? 'Ready to verify' : 'Verification failed'
    $('status-detail').textContent = verifyController.signal.aborted
      ? 'Verification stopped. You can choose the completed ZIP to try again.'
      : `${error.message} Choose the complete ZIP from this run to try again.`
  } finally {
    if (id === runId) {
      verifyController = null
      $('verify-file').disabled = false
      $('verify-file').value = ''
      setBusy(false)
      showResult()
    }
  }
}

document.querySelectorAll('.ram-button').forEach((button) => {
  button.addEventListener('click', () => {
    const ramGiB = Number(button.dataset.ram)
    void startSuite({ ramGiB, bytes: (ramGiB + Math.max(1, Math.ceil(ramGiB * 0.09))) * GiB })
  })
})
$('smoke-test').addEventListener('click', () => void startRun({ bytes: 64 * MiB }))
$('new-test').addEventListener('click', newTest)
$('repeat-test').addEventListener('click', () => {
  if (busy || !result) return
  const options = result.testOptions || { bytes: result.targetPayloadBytes, ramGiB: result.ramGiB,
    ...(result.transport === 'message-channel' && result.diagnostic === 'forced-message-channel' ? { transferStreams: false } : {}),
    ...(result.scenario ? { scenario: result.scenario.id } : {}), suite: Boolean(result.suite) }
  void startRun(options)
})
document.querySelectorAll('[data-scenario]').forEach((button) => {
  button.addEventListener('click', () => void startRun({ scenario: button.dataset.scenario }))
})
$('retry-run').addEventListener('click', () => {
  $('retry-run').hidden = true
  engine?.retry()
})
for (const id of ['diagnostic-action', 'download-observation', 'guard-observation']) {
  $(id).addEventListener('change', () => {
    if (!result) return
    result.manualObservations = {
      action: $('diagnostic-action').value,
      browserDownload: $('download-observation').value,
      navigationGuard: $('guard-observation').value
    }
    showResult()
  })
}
$('verify-file').addEventListener('change', (event) => void verifyFile(event.target.files[0]))
$('cancel-run').addEventListener('click', () => {
  if (verifyController) { verifyController.abort(); return }
  suiteController?.abort()
  engine?.cancel()
  if (result?.suite) {
    result.status = 'cancelled'
    result.verified = false
    result.suite.phase = 'cancelled'
    result.suite.passed = false
    $('status-heading').textContent = 'Stopped'
    $('status-detail').textContent = 'The automatic check was stopped. No further download will start.'
    setBusy(false)
    showResult()
  }
})
$('memory-observation').addEventListener('change', (event) => {
  if (result) { result.memoryObservation = event.target.value; showResult() }
})
$('copy-result').addEventListener('click', async () => {
  $('result-json').textContent = JSON.stringify(result, null, 2)
  try {
    await navigator.clipboard.writeText(JSON.stringify(result, null, 2))
    $('copy-status').textContent = 'Copied'
  } catch {
    const range = document.createRange()
    range.selectNodeContents($('result-json'))
    getSelection().removeAllRanges()
    getSelection().addRange(range)
    $('result-json').parentElement.open = true
    $('copy-status').textContent = 'Select and copy the result below.'
  }
})
$('save-result').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2) + '\n'], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `dataverse-zip-result-${Date.now()}.json`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
})
$('dismiss-previous').addEventListener('click', () => { $('previous-run').hidden = true })
window.addEventListener('beforeunload', (event) => {
  if (!busy) return
  store(true)
  event.preventDefault()
  event.returnValue = ''
})
try {
  const previous = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null')
  if (previous && activeStatuses.has(previous.status) && previous.status !== 'verifying') {
    result = { ...previous, status: 'interrupted', verified: false }
    $('previous-run').hidden = false
    $('previous-detail').textContent = `Last recorded: ${bytes(previous.payloadBytesProcessed)} of ${bytes(previous.targetPayloadBytes)}. A closed tab, reload, crash, or other interruption can cause this; the reason was not recorded.`
    showResult()
  } else if (previous && ['download-finished', 'verification-failed', 'verifying'].includes(previous.status)) {
    result = { ...previous, status: 'download-finished', verified: false }
    $('run-panel').hidden = false
    $('verify-panel').hidden = false
    $('status-heading').textContent = 'Ready to verify'
    $('status-detail').textContent = 'Your last download was sent to the browser. You can still choose the saved ZIP to verify it.'
    $('file-name').textContent = previous.filename || ''
    showResult()
  } else if (previous && ['verified', 'failed', 'cancelled', 'interrupted', 'inconclusive'].includes(previous.status)) {
    result = previous
    $('memory-observation').value = previous.memoryObservation || 'not-measured'
    showResult()
  }
} catch { /* Saved state is optional. */ }
if (result?.scenario) {
  $('run-panel').hidden = false
  $('scenario-panel').hidden = false
  $('scenario-instructions').textContent = `${result.scenario.title}. This is the saved report; a previous transfer is not resumed by reloading.`
  $('scenario-progress').textContent = result.scenario.detail || result.scenario.phase || ''
  $('manual-observations').hidden = Boolean(result.suite || result.scenario.id === 'complete')
  $('diagnostic-action').value = result.manualObservations?.action || 'not-recorded'
  $('download-observation').value = result.manualObservations?.browserDownload || 'not-observed'
  $('guard-observation').value = result.manualObservations?.navigationGuard || 'not-checked'
}
setBusy(false)
const ready = (async () => {
  try {
    if (reloaded) {
      // Firefox reload can bypass worker interception for descendant requests.
      // Start the fresh session with normal navigation before creating streams.
      const fresh = new URL(location.href)
      fresh.searchParams.set('fresh', String(Date.now()))
      location.replace(fresh.href)
      return
    }
    if ('serviceWorker' in navigator) {
      const legacyUrl = new URL('sw.js', location.href).href
      const registrations = await navigator.serviceWorker.getRegistrations()
      for (const registration of registrations) {
        if (registration.active?.scriptURL === legacyUrl) await registration.unregister()
      }
      if (navigator.serviceWorker.controller?.scriptURL === legacyUrl && !sessionStorage.getItem('zip-spike-v2-migrated')) {
        sessionStorage.setItem('zip-spike-v2-migrated', '1')
        location.reload()
        return
      }
    }
    engine = await import('./engine.js?v=20260914-6')
    $('source-version').textContent = `Frontend source: ${engine.metadata.sourceCommit}. Test build: ${engine.metadata.buildId}.`
    $('boot-status').textContent = 'Ready. Choose a memory size to begin.'
    setBusy(false)
  } catch (error) {
    $('boot-status').textContent = `The test could not load: ${error.message}. Reload the page to try again.`
  }
})()
window.spikeTest = { startRun, startSuite, verifyFile, getResult: () => result }
