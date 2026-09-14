// A real browser download followed by saved-file verification. This is a
// correctness smoke check, not evidence of memory usage or large-file support.
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, open, rm, stat, truncate } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const bytes = process.argv.includes('--zip64') ? 5 * 1024 ** 3 + 64 * 1024 ** 2 : 64 * 1024 ** 2
const timeout = process.argv.includes('--zip64') ? 30 * 60_000 : 3 * 60_000

async function loadPlaywright() {
  const candidates = process.env.PLAYWRIGHT_MODULE
    ? [process.env.PLAYWRIGHT_MODULE]
    : ['playwright', '../dataverse-frontend/node_modules/playwright/index.mjs']
  for (const candidate of candidates) {
    let modulePath
    try {
      modulePath = candidate === 'playwright' ? require.resolve(candidate) : resolve(root, candidate)
      await access(modulePath)
    } catch {
      continue
    }
    return import(pathToFileURL(modulePath).href)
  }
  throw new Error('Playwright is unavailable. Install it locally or set PLAYWRIGHT_MODULE to its index.mjs.')
}

async function serve() {
  const prefix = '/zip-stream-spike/'
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      if (!pathname.startsWith(prefix)) {
        response.writeHead(404).end()
        return
      }
      const relative = pathname.slice(prefix.length) || 'index.html'
      const target = resolve(root, relative)
      if (!target.startsWith(root + (root.endsWith(sep) ? '' : sep)) || relative.split('/').some((part) => part.startsWith('.'))) {
        response.writeHead(403).end()
        return
      }
      const info = await stat(target)
      if (!info.isFile()) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
      createReadStream(target).pipe(response)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', done)
  })
  return { server, url: `http://127.0.0.1:${server.address().port}${prefix}` }
}

function checkWithIndependentZipReader(file) {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    assert entries, 'ZIP has no central-directory entries'
    total = 0
    for entry in entries:
        with archive.open(entry) as source:
            count = 0
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                count += len(chunk)
        assert count == entry.file_size, 'Entry length does not match the central directory'
        total += count
    assert total >= int(sys.argv[2]), 'ZIP payload is shorter than requested'
    if int(sys.argv[2]) > 2**32:
        assert any(entry.file_size > 2**32 for entry in entries), 'Expected a ZIP64-sized entry'
    print(json.dumps({'entries': len(entries), 'uncompressedBytes': total, 'crcChecked': True}))
`, file, String(bytes)], { encoding: 'utf8', timeout })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Independent ZIP validation failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

async function assertRejectsDamagedFile(page, path, label) {
  await page.evaluate(() => {
    document.getElementById('smoke-integrity-fixture')?.remove()
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'smoke-integrity-fixture'
    input.hidden = true
    document.body.append(input)
  })
  await page.locator('#smoke-integrity-fixture').setInputFiles(path)
  const result = await page.evaluate(async (expectedPayloadBytes) => {
    const { verifySavedZip } = await import('./engine.js')
    const file = document.getElementById('smoke-integrity-fixture').files[0]
    try {
      await verifySavedZip(file, { expectedPayloadBytes })
      return { rejected: false }
    } catch (error) {
      return { rejected: true, message: String(error.message || error) }
    }
  }, bytes)
  assert.equal(result.rejected, true, `${label} archive was incorrectly accepted`)
  console.log(`${label}: rejected (${result.message})`)
}

async function runScenario(browser, base, artifactDirectory, forceMessageChannel) {
  const label = forceMessageChannel ? 'MessageChannel' : 'automatic transport'
  const context = await browser.newContext({ acceptDownloads: true })
  context.setDefaultTimeout(timeout)
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  try {
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => typeof window.spikeTest?.startRun === 'function')
    const downloadPromise = page.waitForEvent('download', { timeout })
    if (!forceMessageChannel && bytes === 64 * 1024 ** 2) {
      await page.locator('#smoke-test').click()
    } else {
      await page.evaluate(({ payloadBytes, forced }) => {
        void window.spikeTest.startRun({ bytes: payloadBytes, ramGiB: 0, transferStreams: forced ? false : undefined })
      }, { payloadBytes: bytes, forced: forceMessageChannel })
    }
    const download = await downloadPromise
    const archive = join(artifactDirectory, download.suggestedFilename())
    console.log(`${label}: browser download started (${download.suggestedFilename()})`)
    await download.saveAs(archive)
    console.log(`${label}: browser download saved; checking with Python ZIP reader`)
    assert.equal(await download.failure(), null, `${label} download did not finish`)
    await page.waitForFunction(() => /ready to verify|failed|stopped/i.test(document.getElementById('status-heading').textContent))
    assert.match(await page.locator('#status-heading').textContent(), /ready to verify/i, JSON.stringify(await page.evaluate(() => window.spikeTest.getResult())))
    const info = await stat(archive)
    assert.ok(info.size > bytes, 'Saved archive lacks the expected ZIP headers and payload')
    const zip = checkWithIndependentZipReader(archive)
    console.log(`${label}: independent ZIP integrity passed; verifying saved file in page`)
    await page.locator('#verify-file').setInputFiles(archive)
    await page.waitForFunction(() => /zip verified|failed/i.test(document.getElementById('status-heading').textContent))
    assert.match(await page.locator('#status-heading').textContent(), /zip verified/i, JSON.stringify(await page.evaluate(() => window.spikeTest.getResult())))
    console.log(JSON.stringify({ scenario: label, archiveBytes: info.size, ...zip, savedFileVerifiedByPage: true }))

    if (process.argv.includes('--zip64')) {
      assert.deepEqual(pageErrors, [], `Unexpected browser errors: ${pageErrors.join('; ')}`)
      return
    }

    // Mutations only touch copies of the small test's own downloaded artifact.
    // Reading and writing one byte keeps the ZIP64 case bounded too.
    const corrupt = join(artifactDirectory, forceMessageChannel ? 'message-channel-corrupt.zip' : 'automatic-corrupt.zip')
    await copyFile(archive, corrupt)
    const handle = await open(corrupt, 'r+')
    try {
      const value = Buffer.alloc(1)
      await handle.read(value, 0, 1, 1024)
      value[0] ^= 0xff
      await handle.write(value, 0, 1, 1024)
    } finally {
      await handle.close()
    }
    await assertRejectsDamagedFile(page, corrupt, `${label}, corrupt payload`)
    await copyFile(archive, corrupt)
    await truncate(corrupt, info.size - 128)
    await assertRejectsDamagedFile(page, corrupt, `${label}, truncated directory`)
    assert.deepEqual(pageErrors, [], `Unexpected browser errors: ${pageErrors.join('; ')}`)
  } finally {
    await context.close()
  }
}

let server
let browser
let artifacts
try {
  const { chromium } = await loadPlaywright()
  let executablePath = process.env.BROWSER_EXECUTABLE_PATH
  if (!executablePath) {
    try {
      await access('/usr/bin/chromium')
      executablePath = '/usr/bin/chromium'
    } catch { /* Use the Playwright-managed Chromium when no system browser is installed. */ }
  }
  const local = process.env.SPIKE_URL ? null : await serve()
  server = local?.server
  const base = process.env.SPIKE_URL || local.url
  const downloads = resolve(root, process.env.SPIKE_ARTIFACT_ROOT || '.smoke-downloads')
  await mkdir(downloads, { recursive: true })
  artifacts = await mkdtemp(join(downloads, 'run-'))
  browser = await chromium.launch({ executablePath, headless: process.env.HEADLESS !== '0', args: ['--no-sandbox'], downloadsPath: artifacts })
  console.log(JSON.stringify({ browser: await browser.version(), base, payloadBytes: bytes, artifacts }))
  if (process.argv.includes('--screenshots-only')) {
    for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
      const page = await browser.newPage({ viewport })
      await page.goto(base, { waitUntil: 'networkidle' })
      await page.waitForFunction(() => typeof window.spikeTest?.startRun === 'function')
      const path = join(tmpdir(), `spike-${label}.png`)
      await page.screenshot({ path, fullPage: true })
      console.log(`Screenshot: ${path}`)
      await page.close()
    }
  } else {
    if (!process.argv.includes('--message-channel-only')) await runScenario(browser, base, artifacts, false)
    if (!process.argv.includes('--automatic-only')) await runScenario(browser, base, artifacts, true)
    console.log('PASS: selected downloads are valid ZIPs and saved-file verification succeeds.')
  }
} finally {
  await browser?.close()
  if (server) await new Promise((done) => server.close(done))
  if (artifacts) await rm(artifacts, { recursive: true, force: true })
}
