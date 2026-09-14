// Bounded browser diagnostics against the unchanged frontend ZIP mechanism.
// Small synthetic payloads exercise error/retry, inactivity and cancellation.
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const bytes = 64 * 1024 ** 2
const background = process.argv.includes('--background')
const suite = process.argv.includes('--suite')
const longRun = background || suite
const timeout = longRun ? 15 * 60_000 + 15_000 : 100_000
const reportPath = resolve(process.env.SPIKE_REPORT || `/tmp/spike-${suite ? 'suite' : background ? 'background' : 'interruptions'}-report.json`)
const report = { startedAt: new Date().toISOString(), mode: suite ? 'complete-browser-suite' : background ? 'background-duration' : 'quick-interruptions', cases: [] }
const removedDefaultArgs = [
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding'
]

async function loadPlaywright() {
  for (const candidate of process.env.PLAYWRIGHT_MODULE
    ? [process.env.PLAYWRIGHT_MODULE]
    : ['playwright', '../dataverse-frontend/node_modules/playwright/index.mjs']) {
    let modulePath
    try {
      modulePath = candidate === 'playwright' ? require.resolve(candidate) : resolve(root, candidate)
      await access(modulePath)
    } catch { continue }
    return import(pathToFileURL(modulePath).href)
  }
  throw new Error('Install Playwright or set PLAYWRIGHT_MODULE to its index.mjs.')
}

async function serve() {
  const prefix = '/zip-stream-spike/'
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      if (!pathname.startsWith(prefix)) { response.writeHead(404).end(); return }
      const relative = pathname.slice(prefix.length) || 'index.html'
      const target = resolve(root, relative)
      if (!target.startsWith(root + (root.endsWith(sep) ? '' : sep)) || relative.split('/').some((part) => part.startsWith('.'))) {
        response.writeHead(403).end(); return
      }
      if (!(await stat(target)).isFile()) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
      createReadStream(target).pipe(response)
    } catch { response.writeHead(404).end() }
  })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  return { server, url: `http://127.0.0.1:${server.address().port}${prefix}` }
}

async function snapshot(page) { return page.evaluate(() => window.spikeTest.getResult()) }

async function within(promise, milliseconds, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds) })
    ])
  } finally { clearTimeout(timer) }
}

async function waitForEvent(page, type, limit = timeout) {
  await page.waitForFunction((eventType) => {
    const result = window.spikeTest.getResult()
    return result?.scenario?.events?.some((event) => event.type === eventType) || ['failed', 'cancelled', 'inconclusive'].includes(result?.status)
  }, type, { polling: 100, timeout: limit })
  const result = await snapshot(page)
  assert.ok(result.scenario.events.some((event) => event.type === type), `Missing ${type}: ${JSON.stringify(result)}`)
  return result.scenario.events.findLast((event) => event.type === type)
}

function independentZipCheck(file) {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    count = 0
    for entry in archive.infolist():
        with archive.open(entry) as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk: break
                count += len(chunk)
    assert count == int(sys.argv[2]), (count, sys.argv[2])
    print(json.dumps({'entries': len(archive.infolist()), 'payloadBytes': count, 'crcChecked': True}))
`, file, String(bytes)], { encoding: 'utf8', timeout: 30_000 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

async function saveAndVerify(page, download, directory) {
  const archive = join(directory, download.suggestedFilename())
  await within(download.saveAs(archive), timeout, 'Native download exceeded the diagnostic deadline')
  assert.equal(await download.failure(), null)
  await page.waitForFunction(() => ['download-finished', 'failed', 'cancelled', 'inconclusive'].includes(window.spikeTest.getResult()?.status), null, { polling: 100, timeout })
  assert.equal((await snapshot(page)).status, 'download-finished')
  const independent = independentZipCheck(archive)
  await page.locator('#verify-file').setInputFiles(archive)
  await page.waitForFunction(() => ['verified', 'verification-failed'].includes(window.spikeTest.getResult()?.status), null, { polling: 100, timeout: 30_000 })
  const result = await snapshot(page)
  assert.equal(result.verified, true, JSON.stringify(result))
  assert.equal(result.verification.payloadBytes, bytes)
  assert.deepEqual(result.failedFiles, [])
  assert.deepEqual(result.checksumFailures, [])
  return { archiveBytes: (await stat(archive)).size, independent, result }
}

async function begin(browser, base, scenario, forced) {
  const context = await browser.newContext({ acceptDownloads: true })
  context.setDefaultTimeout(timeout)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push({ name: error.name, message: error.message, stack: error.stack }))
  await page.addInitScript(() => {
    window.__diagnosticRejections = []
    addEventListener('unhandledrejection', (event) => {
      window.__diagnosticRejections.push({ type: typeof event.reason, reason: String(event.reason), stack: event.reason?.stack })
    })
  })
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.waitForFunction(() => typeof window.spikeTest?.startRun === 'function')
  // Real activation is necessary for a browser beforeunload dialog.
  await page.locator('h1').click()
  const downloadPromise = page.waitForEvent('download', { timeout })
  downloadPromise.catch(() => {}) // Errors are handled when the caller awaits it.
  await page.evaluate(({ payload, selectedScenario, forceMessageChannel }) => {
    void window.spikeTest.startRun({ bytes: payload, scenario: selectedScenario, ...(forceMessageChannel ? { transferStreams: false } : {}) })
      .catch((error) => { window.__diagnosticStartError = String(error.stack || error) })
  }, { payload: bytes, selectedScenario: scenario, forceMessageChannel: forced })
  await page.waitForFunction(() => window.spikeTest.getResult() || window.__diagnosticStartError, null, { polling: 100, timeout: 5_000 })
  const startError = await page.evaluate(() => window.__diagnosticStartError)
  if (startError) { await context.close(); throw new Error(startError) }
  return { context, page, downloadPromise, errors }
}

async function recovery(browser, base, directory, forced) {
  const current = await begin(browser, base, 'recovery', forced)
  const { context, page, downloadPromise, errors } = current
  try {
    await waitForEvent(page, 'body-error')
    console.log(`${forced ? 'MessageChannel' : 'automatic'} recovery: response interrupted; awaiting frontend automatic retry`)
    assert.equal((await snapshot(page)).scenario.events.filter((event) => event.type === 'http-error').length, 1)
    const resumed = await waitForEvent(page, 'resumed-request')
    assert.equal(resumed.from, 3 * 1024 ** 2)
    assert.equal(resumed.matched, true)
    assert.ok(!(await snapshot(page)).scenario.events.some((event) =>
      ['automation-retry', 'user-retry'].includes(event.type) || (event.type === 'engine-state' && event.status === 'paused')))
    await waitForEvent(page, 'source-silence-start')
    console.log(`${forced ? 'MessageChannel' : 'automatic'} recovery: resumed exactly at 3 MiB; waiting through 45-second source silence`)
    // This probe disrupts browser networking while the source is deliberately
    // paused. Synthetic bytes remain local; this is not a server retry test.
    const before = await page.evaluate(() => ({ online: navigator.onLine, visibility: document.visibilityState }))
    await context.setOffline(true)
    await page.waitForTimeout(5_000)
    const offline = await page.evaluate(() => ({ online: navigator.onLine, visibility: document.visibilityState }))
    await context.setOffline(false)
    assert.equal(offline.online, false)
    const after = await page.evaluate(() => ({ online: navigator.onLine, visibility: document.visibilityState }))
    const silence = await waitForEvent(page, 'source-silence-end')
    assert.ok(silence.actualDurationMs >= 44_000, JSON.stringify(silence))
    const download = await downloadPromise
    const verified = await saveAndVerify(page, download, directory)
    assert.deepEqual(errors, [])
    return { ...verified, networkToggle: { requestedOfflineMs: 5_000, before, offline, after, scope: 'Browser transport only; synthetic source is local.' } }
  } finally { await context.setOffline(false); await context.close() }
}

async function cancellation(browser, base, forced, native) {
  const { context, page, downloadPromise, errors } = await begin(browser, base, 'cancel', forced)
  try {
    await waitForEvent(page, 'source-silence-start')
    const download = await within(downloadPromise, 10_000, 'Browser did not start the native download before the cancellation interval')
    let dismissedBeforeUnload = false
    if (!native) {
      const dialogPromise = page.waitForEvent('dialog', { timeout: 5_000 })
      const reloading = page.reload({ timeout: 8_000 }).catch((error) => error.message)
      const dialog = await dialogPromise
      assert.equal(dialog.type(), 'beforeunload')
      await dialog.dismiss()
      await reloading
      assert.equal((await snapshot(page)).scenario.phase, 'source-silence')
      dismissedBeforeUnload = true
    }
    const stopStarted = Date.now()
    if (native) await download.cancel()
    else await page.locator('#cancel-run').click()
    const failure = await within(download.failure(), 10_000, 'Native browser download did not stop within 10 seconds')
    assert.ok(failure, 'Cancelled download must not be reported as a successful native download')
    // Native cancellation propagation is observed separately. Do not silently
    // cancel the app before recording whether its production sink noticed.
    await page.waitForFunction(() => ['cancelled', 'failed'].includes(window.spikeTest.getResult()?.status), null, { polling: 100, timeout: 5_000 }).catch(() => {})
    const result = await snapshot(page)
    assert.equal(result.verified, false)
    if (!native) assert.equal(result.status, 'cancelled')
    const observed = {
      dismissedBeforeUnload,
      nativeDownloadFailure: failure,
      stoppedAfterMs: Date.now() - stopStarted,
      engineNoticedNativeCancel: native ? ['cancelled', 'failed'].includes(result.status) : undefined,
      unexpectedPageErrors: errors,
      unhandledRejections: await page.evaluate(() => window.__diagnosticRejections),
      result
    }
    if (errors.length) throw Object.assign(new Error(`Cancellation raised ${errors.length} uncaught page error(s)`), { observations: observed })
    return observed
  } finally { await context.close() }
}

async function backgroundDuration(browser, base, directory, forced) {
  const { context, page, downloadPromise, errors } = await begin(browser, base, 'background', forced)
  const other = await context.newPage()
  try {
    const before = await page.evaluate(() => document.visibilityState)
    await other.goto('about:blank')
    await other.bringToFront()
    const after = await page.evaluate(() => document.visibilityState)
    console.log(`Background diagnostic: initial=${before}, with other tab in front=${after}; 15-minute scenario cap`)
    const lastSeen = setInterval(async () => {
      try {
        const result = await snapshot(page)
        console.log(`Background elapsed ${Math.round(result.downloadElapsedMs / 1000)}s, payload ${Math.round(result.payloadBytesProcessed / 1024 ** 2)} MiB`)
      } catch { /* Main test reports page failures. */ }
    }, 30_000)
    let verified
    try { verified = await saveAndVerify(page, await downloadPromise, directory) } finally { clearInterval(lastSeen) }
    assert.deepEqual(errors, [])
    const finalVisibility = await page.evaluate(() => document.visibilityState)
    return {
      ...verified,
      visibility: { before, after, final: finalVisibility },
      scope: process.env.HEADLESS === '0'
        ? 'Headful automated run; visibility observations are recorded. OS sleep and browser policies require a manual check.'
        : 'Headless duration/inactivity check. This is not evidence of actual user background-tab throttling.'
    }
  } finally { await context.close() }
}

// Playwright enables focus emulation internally, keeping document.visibilityState
// visible even in a background tab. Standard ChromeDriver avoids that override.
// Use it for a headful lifetime run and inspect the actual browser command line.
async function backgroundWebDriver(base, directory, forced) {
  const driver = spawn(process.env.CHROMEDRIVER || '/usr/bin/chromedriver', ['--port=0'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let sessionId
  let endpoint
  let output = ''
  const request = async (method, path, body) => {
    const response = await fetch(endpoint + path, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000)
    })
    const { value } = await response.json()
    if (!response.ok || value?.error) throw new Error(`WebDriver ${path}: ${value?.message || response.status}`)
    return value
  }
  const call = (path, body) => request('POST', `/session/${sessionId}${path}`, body)
  const script = (source, args = []) => call('/execute/sync', { script: source, args })
  const pause = (ms) => new Promise((done) => setTimeout(done, ms))
  try {
    const port = await within(new Promise((done, fail) => {
      driver.once('error', fail)
      driver.once('exit', (code) => fail(new Error(`ChromeDriver exited ${code}: ${output}`)))
      driver.stdout.on('data', (chunk) => {
        output += String(chunk)
        const match = /started successfully on port (\d+)/.exec(output)
        if (match) done(Number(match[1]))
      })
      driver.stderr.on('data', (chunk) => { output += String(chunk) })
    }), 20_000, 'ChromeDriver did not start within 20 seconds')
    endpoint = `http://127.0.0.1:${port}`
    const session = await request('POST', '/session', { capabilities: { alwaysMatch: {
      browserName: 'chrome',
      'goog:chromeOptions': {
        binary: process.env.BROWSER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800'],
        excludeSwitches: removedDefaultArgs.map((value) => value.replace(/^--/, '')),
        prefs: { 'download.default_directory': directory, 'download.prompt_for_download': false, 'download.directory_upgrade': true }
      }
    } } })
    sessionId = session.sessionId
    const commandLine = await call('/goog/cdp/execute', { cmd: 'Browser.getBrowserCommandLine', params: {} })
    for (const flag of removedDefaultArgs) assert.ok(!commandLine.arguments.includes(flag), `Browser still disables background behavior: ${flag}`)
    const originalWindow = await request('GET', `/session/${sessionId}/window`)
    await call('/url', { url: base })
    const readyUntil = Date.now() + 20_000
    while (!(await script('return typeof window.spikeTest?.startRun === "function" && (!arguments[0] || typeof window.spikeTest.startSuite === "function")', [suite]))) {
      assert.ok(Date.now() < readyUntil, 'The page did not become ready')
      await pause(100)
    }
    await script('window.__diagnosticRejections=[]; addEventListener("unhandledrejection", event => window.__diagnosticRejections.push({type:typeof event.reason,reason:String(event.reason)}))')
    const heading = await call('/element', { using: 'css selector', value: 'h1' })
    await call(`/element/${heading['element-6066-11e4-a52e-4f735466cecf']}/click`, {})
    await script('void window.spikeTest[arguments[1] ? "startSuite" : "startRun"]({bytes:64*1024**2,...(arguments[1] ? {} : {scenario:"background"}),...(arguments[0] ? {transferStreams:false} : {})}).catch(error => {window.__diagnosticStartError=String(error.stack || error)}); return true', [forced, suite])
    const initial = await script('return document.visibilityState')
    await script('window.open("about:blank", "_blank"); return true')
    await pause(1000)
    const hidden = await script('return document.visibilityState')
    assert.equal(hidden, 'hidden', 'The background test page did not become hidden')
    console.log(`ChromeDriver ${session.capabilities.browserVersion}: real tab visibility ${initial} → ${hidden}; background-disabling flags absent`)
    const deadline = Date.now() + 15 * 60_000
    let result
    let lastLog = 0
    const visibilitySamples = { hidden: 0, visible: 0 }
    while (true) {
      const observed = await script('return {result:window.spikeTest.getResult(),visibility:document.visibilityState,startError:window.__diagnosticStartError}')
      assert.ok(!observed.startError, observed.startError)
      result = observed.result
      assert.ok(result, 'The page did not initialize the diagnostic result')
      visibilitySamples[observed.visibility] = (visibilitySamples[observed.visibility] || 0) + 1
      if (Date.now() - lastLog >= 30_000) {
        lastLog = Date.now()
        console.log(`Hidden ${suite ? 'suite' : 'background'} elapsed ${Math.round((result.downloadElapsedMs || 0) / 1000)}s, payload ${Math.round((result.payloadBytesProcessed || 0) / 1024 ** 2)} MiB, phase=${result.scenario?.phase || result.suite?.phase}, visibility=${observed.visibility}`)
        report.inProgress = { result, visibilitySamples: { ...visibilitySamples }, browser: session.capabilities.browserVersion, browserCommandLine: commandLine.arguments }
        await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
      }
      if (result.status === 'download-finished') break
      if (['failed', 'cancelled', 'inconclusive'].includes(result.status)) throw Object.assign(new Error(`Background diagnostic ended ${result.status}: ${result.error}`), { observations: { result, visibilitySamples } })
      assert.ok(Date.now() < deadline, 'Background diagnostic exceeded 15 minutes')
      await pause(1000)
    }
    assert.equal(visibilitySamples.visible, 0, 'The download tab unexpectedly became visible before completion')
    const archive = join(directory, result.filename)
    const saveUntil = Date.now() + 30_000
    let archiveSize
    while (true) {
      try { archiveSize = (await stat(archive)).size; if (archiveSize > bytes) break } catch { /* Wait for the native .crdownload rename. */ }
      assert.ok(Date.now() < saveUntil, 'Browser did not finish saving its native ZIP')
      await pause(100)
    }
    const independent = independentZipCheck(archive)
    // The hidden interval is complete. Bring the test back to verify its file.
    await call('/window', { handle: originalWindow })
    const input = await call('/element', { using: 'css selector', value: '#verify-file' })
    await call(`/element/${input['element-6066-11e4-a52e-4f735466cecf']}/value`, { text: archive, value: [archive] })
    const verifyUntil = Date.now() + 30_000
    while (true) {
      result = await script('return window.spikeTest.getResult()')
      if (result.status === 'verified') break
      assert.notEqual(result.status, 'verification-failed', result.error)
      assert.ok(Date.now() < verifyUntil, 'Saved-file verification exceeded 30 seconds')
      await pause(100)
    }
    const rejections = await script('return window.__diagnosticRejections')
    assert.deepEqual(rejections, [])
    const silence = result.scenario.events.find((event) => event.type === 'source-silence-end')
    assert.ok(silence?.actualDurationMs >= 44_000, 'The full source-silence interval was not observed')
    if (suite) {
      assert.equal(result.suite?.passed, true, JSON.stringify(result.suite))
      assert.equal(result.suite.cancellation.passed, true)
      assert.equal(result.suite.cancellation.result.probeConsumer?.status, 'errored', 'The controlled service-worker consumer did not observe cancellation')
      assert.ok(result.suite.cancellation.result.scenario.events.some((event) => event.type === 'frontend-fetch-aborted' && event.pendingWaitMs > 0), 'Cancellation did not abort the actual frontend fetch during its pending source read')
      assert.equal(result.scenario.id, 'complete')
      assert.ok(result.downloadElapsedMs >= 720_000, 'The full 12-minute lifetime was not observed')
      assert.ok(!result.scenario.events.some((event) => ['automation-retry', 'user-retry'].includes(event.type)
        || (event.type === 'engine-state' && event.status === 'paused')), 'Recovery required a Retry decision instead of frontend automatic recovery')
      assert.ok(result.scenario.events.some((event) => event.type === 'resumed-request' && event.from === 3 * 1024 ** 2 && event.matched), 'The complete suite did not resume at the delivered offset')
    }
    delete report.inProgress
    return {
      browser: session.capabilities.browserVersion, driver: 'ChromeDriver W3C WebDriver', browserCommandLine: commandLine.arguments,
      archiveBytes: archiveSize, independent, result, visibility: { before: initial, background: hidden, samples: visibilitySamples },
      scope: 'Headful automated browser under Xvfb, actual hidden tab with background-disabling switches excluded. Automation remains attached; this does not replace a manual browser/OS sleep check.'
    }
  } finally {
    if (sessionId) await within(request('DELETE', `/session/${sessionId}`), 10_000, 'ChromeDriver session cleanup timed out').catch(() => {})
    driver.kill('SIGTERM')
  }
}

let browser
let server
let directory
try {
  if (suite && process.env.HEADLESS !== '0') throw new Error('Use HEADLESS=0 for --suite so its background visibility is tested without Playwright focus emulation.')
  const chromium = longRun && process.env.HEADLESS === '0' ? null : (await loadPlaywright()).chromium
  let executablePath = process.env.BROWSER_EXECUTABLE_PATH
  if (!executablePath) { try { await access('/usr/bin/chromium'); executablePath = '/usr/bin/chromium' } catch { /* Managed browser fallback. */ } }
  const local = process.env.SPIKE_URL ? null : await serve()
  server = local?.server
  const base = process.env.SPIKE_URL || local.url
  const artifacts = resolve(root, process.env.SPIKE_ARTIFACT_ROOT || '.smoke-downloads')
  await mkdir(artifacts, { recursive: true })
  directory = await mkdtemp(join(artifacts, 'interruptions-'))
  if (!(longRun && process.env.HEADLESS === '0')) browser = await chromium.launch({ executablePath, headless: process.env.HEADLESS !== '0', args: ['--no-sandbox'], ignoreDefaultArgs: removedDefaultArgs, downloadsPath: directory })
  Object.assign(report, { browser: browser ? await browser.version() : 'ChromeDriver (recorded in case)', base, headless: process.env.HEADLESS !== '0', removedDefaultArgs, payloadBytes: bytes, artifacts: directory })
  console.log(JSON.stringify(report))
  const transports = process.argv.includes('--message-channel-only') ? [true]
    : process.argv.includes('--automatic-only') || longRun ? [false] : [false, true]
  for (const forced of transports) {
    const transport = forced ? 'forced-message-channel' : 'automatic'
    const cases = longRun ? [[suite ? 'complete-suite' : 'background', () => process.env.HEADLESS === '0'
      ? backgroundWebDriver(base, directory, forced) : backgroundDuration(browser, base, directory, forced)]]
      : process.argv.includes('--native-cancel-only') ? [['native-cancel', () => cancellation(browser, base, forced, true)]] : [
      ['recovery-and-offline', () => recovery(browser, base, directory, forced)],
      ['page-cancel-and-beforeunload', () => cancellation(browser, base, forced, false)],
      ['native-cancel', () => cancellation(browser, base, forced, true)]
    ]
    for (const [name, run] of cases) {
      const start = Date.now()
      try {
        const outcome = await run()
        report.cases.push({ name, transport, passed: true, elapsedMs: Date.now() - start, ...outcome })
        console.log(`PASS ${transport} ${name} (${Math.round((Date.now() - start) / 1000)}s)`)
      } catch (error) {
        report.cases.push({ name, transport, passed: false, elapsedMs: Date.now() - start, error: String(error.stack || error), ...error.observations })
        console.error(`FAIL ${transport} ${name}: ${error.message}`)
        process.exitCode = 1
      }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
    }
  }
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  await browser?.close()
  if (server) await new Promise((done) => server.close(done))
  if (directory) await rm(directory, { recursive: true, force: true })
  console.log(`Report: ${reportPath}`)
}
