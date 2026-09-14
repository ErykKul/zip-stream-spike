const $ = (id) => document.getElementById(id)
const GiB = 1024 ** 3
const MiB = 1024 ** 2
const STORAGE_KEY = 'dataverse-zip-check-v2'
const activeStatuses = new Set(['preparing', 'running', 'verifying'])
let engine
let result = null
let busy = false
let runId = 0
let verifyController = null
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
  document.querySelectorAll('.ram-button, #smoke-test').forEach((button) => { button.disabled = value || !engine })
  $('cancel-run').hidden = !value
  $('verify-file').disabled = value || !engine
}
function store(force = false) {
  if (!result || (!force && Date.now() - lastStored < 1000)) return
  lastStored = Date.now()
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(result)) } catch { /* Private browsing may disable storage. */ }
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
    $('result-heading').textContent = large ? 'Large ZIP verified' : 'Small ZIP verified'
    $('result-summary').textContent = large
      ? `${bytes(result.targetPayloadBytes)} of ZIP payload was saved and verified on this ${result.ramGiB} GB RAM computer. This records a successful run on this browser; it is not a measurement of its total memory use.`
      : 'The saved ZIP passed the integrity check. Next, choose your RAM size to test a larger download.'
  } else if (result.status === 'verifying') {
    $('result-heading').textContent = 'Verification in progress'
    $('result-summary').textContent = 'The saved ZIP is still being checked. Wait for verification to finish before reporting a pass or failure.'
  } else if (result.status === 'download-finished') {
    $('result-heading').textContent = 'Download sent · verification pending'
    $('result-summary').textContent = 'The browser consumed the ZIP stream. Its final save is not yet verified; choose the completed download above to check it.'
  } else if (result.status === 'cancelled') {
    $('result-heading').textContent = 'Test stopped'
    $('result-summary').textContent = 'This run was stopped. It does not establish whether this browser supports the larger download.'
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
  sampleHeap()
  store(terminal || changed)
  if (!terminal && !changed && performance.now() - lastPaint < 150) return
  lastPaint = performance.now()
  $('bytes-progress').textContent = `${bytes(state.bytesDone)} / ${bytes(result.targetPayloadBytes)}`
  $('time-progress').textContent = duration(state.elapsedMs)
  $('progress').value = Math.min(1, (state.bytesDone || 0) / result.targetPayloadBytes)
  $('file-name').textContent = state.filename || ''
  if (state.status === 'preparing' || state.status === 'running') {
    $('status-heading').textContent = state.status === 'preparing' ? 'Preparing' : 'Downloading'
    if (changed) $('status-detail').textContent = state.status === 'preparing'
      ? 'Starting the browser download. If a save dialog appears, choose a folder on disk.'
      : 'The ZIP is being created and handed to your browser. Keep this tab open until it finishes.'
  } else if (state.status === 'done') {
    setBusy(false)
    result.finishedAt = new Date().toISOString()
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
    result.error = state.message || state.failedSoFar?.at(-1)?.error || 'The download did not complete.'
    $('status-heading').textContent = result.status === 'cancelled' ? 'Stopped' : 'Failed'
    $('status-detail').textContent = result.error
    if (state.status === 'paused' || state.status === 'awaiting-retry') engine.cancel()
    setBusy(false)
    showResult()
  }
}

async function startRun({ bytes: totalBytes, ramGiB = 0, transferStreams } = {}) {
  await ready
  if (!engine) throw new Error('The test engine did not load.')
  if (busy) throw new Error('Stop the current test first.')
  const id = ++runId
  previousEngineStatus = ''
  result = {
    schema: 2,
    page: location.origin + location.pathname,
    startedAt: new Date().toISOString(),
    frontendCommit: engine.metadata.sourceCommit,
    engineBuildId: engine.metadata.buildId,
    libraries: engine.metadata.libraries,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    browserBrands: navigator.userAgentData?.brands,
    ramGiB,
    targetPayloadBytes: totalBytes,
    diagnostic: transferStreams === false ? 'forced-message-channel' : false,
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
    await engine.start({ bytes: totalBytes, onState: (state) => handleState(state, id), ...(transferStreams === false ? { transferStreams: false } : {}) })
  } catch (error) {
    if (id !== runId) return
    result.status = 'failed'
    result.error = error.message
    $('status-heading').textContent = 'Failed'
    $('status-detail').textContent = error.message
    setBusy(false)
    showResult()
  }
}

async function verifyFile(file) {
  if (!file || !result || busy) return
  if (file.name.replace(/ \(\d+\)(?=\.zip$)/, '') !== result.filename) {
    result.status = 'verification-failed'
    result.verified = false
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
    result.verified = true
    result.status = 'verified'
    result.verifiedAt = new Date().toISOString()
    result.error = undefined
    $('status-heading').textContent = 'ZIP verified'
    $('status-detail').textContent = 'The saved archive has the expected size, complete ZIP structure, and correct contents.'
    $('progress').value = 1
    $('verify-panel').hidden = true
  } catch (error) {
    if (id !== runId) return
    result.status = verifyController.signal.aborted ? 'download-finished' : 'verification-failed'
    result.verified = false
    result.error = verifyController.signal.aborted ? undefined : error.message
    result.verificationError = error.message
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
    void startRun({ ramGiB, bytes: (ramGiB + Math.max(1, Math.ceil(ramGiB * 0.09))) * GiB })
  })
})
$('smoke-test').addEventListener('click', () => void startRun({ bytes: 64 * MiB }))
$('verify-file').addEventListener('change', (event) => void verifyFile(event.target.files[0]))
$('cancel-run').addEventListener('click', () => {
  if (verifyController) { verifyController.abort(); return }
  engine?.cancel()
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
  const previous = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
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
  } else if (previous && ['verified', 'failed', 'cancelled', 'interrupted'].includes(previous.status)) {
    result = previous
    $('memory-observation').value = previous.memoryObservation || 'not-measured'
    showResult()
  }
} catch { /* Saved state is optional. */ }
setBusy(false)
const ready = (async () => {
  try {
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
    engine = await import('./engine.js?v=20260914-1')
    $('source-version').textContent = `Frontend source: ${engine.metadata.sourceCommit}. Test build: ${engine.metadata.buildId}.`
    $('boot-status').textContent = 'Ready. Choose a memory size to begin.'
    setBusy(false)
  } catch (error) {
    $('boot-status').textContent = `The test could not load: ${error.message}. Reload the page to try again.`
  }
})()
window.spikeTest = { startRun, verifyFile, getResult: () => result }
