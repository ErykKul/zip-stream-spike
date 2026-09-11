// Drives the spike page in a real browser on Xvfb, watches the download directory,
// samples renderer memory, and reports whether the file grew during generation.
// usage: node run.mjs <chromium|firefox> <mode: sw|opfs|abort> <totalMB> <rateMBs> [keepalive:0|1] [transferable:0|1]
import { chromium, firefox } from '/home/eryk/workspaces/tree-view/dataverse-frontend/node_modules/playwright/index.mjs'
import { readdirSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

const [browserName, mode, totalMB = '64', rateMBs = '4', keepalive = '1', transferable = '1', shortClose = '0'] = process.argv.slice(2)
const base = process.env.SPIKE_URL || 'http://localhost:8765/'
const dlDir = `/tmp/claude-1000/spike-dl-${browserName}-${mode}-${Date.now()}`
mkdirSync(dlDir, { recursive: true })

const launcher = browserName === 'firefox' ? firefox : chromium
const opts = { headless: false, downloadsPath: dlDir }
if (browserName === 'chromium') Object.assign(opts, { executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
const browser = await launcher.launch(opts)
const context = await browser.newContext({ acceptDownloads: true })
const page = await context.newPage()
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

function dirBytes() {
  let bytes = 0
  for (const f of readdirSync(dlDir)) { try { bytes += statSync(join(dlDir, f)).size } catch {} }
  return bytes
}
function rendererRssMB() {
  try {
    const pattern = browserName === 'firefox' ? '-contentproc' : 'type=renderer'
    const out = execSync(`ps -eo pid,rss,args | grep -F -- '${pattern}' | grep -v grep | awk '{s+=$2} END {print s+0}'`).toString().trim()
    return Math.round(Number(out) / 1024)
  } catch { return -1 }
}

await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForFunction(() => /controlled|failed|no \(/.test(document.getElementById('swAvail').textContent), null, { timeout: 30000 })
log('page:', await page.locator('#swAvail').textContent(), '| transferable:', await page.locator('#xferAvail').textContent(), '| opfs:', await page.locator('#opfsAvail').textContent())

await page.fill('#totalMb', totalMB)
await page.fill('#rateMbs', rateMBs)
if (keepalive === '1') await page.check('#keepalive'); else await page.uncheck('#keepalive')
if (transferable === '1') await page.check('#transferable'); else await page.uncheck('#transferable')
if (shortClose === '1') await page.check('#shortClose'); else await page.uncheck('#shortClose')

const downloadPromise = page.waitForEvent('download', { timeout: 120000 }).catch(() => null)
await page.click(mode === 'opfs' ? '#startOpfs' : '#startSw')
const t0 = Date.now()
const download = await downloadPromise
log('download event:', download ? download.suggestedFilename() : 'none within 120 s')

const samples = []
let firstGrowth = null
const totalBytes = Number(totalMB) * 1024 * 1024
const expectedSeconds = totalBytes / (Number(rateMBs) * 1024 * 1024)
const abortAt = mode === 'abort' ? Math.max(20, expectedSeconds * 0.3) : Infinity
let aborted = false
while (true) {
  const elapsed = (Date.now() - t0) / 1000
  const generated = await page.locator(mode === 'opfs' ? '#opfsBytes' : '#swBytes').textContent().catch(() => '?')
  const status = await page.locator(mode === 'opfs' ? '#opfsStatus' : '#swStatus').textContent().catch(() => '?')
  const onDisk = dirBytes()
  const rss = rendererRssMB()
  samples.push({ elapsed: Math.round(elapsed), generated, onDisk, rss })
  if (firstGrowth === null && onDisk > 0) firstGrowth = { elapsed: Math.round(elapsed), generated }
  log(`t=${Math.round(elapsed)}s generated=${generated} onDisk=${(onDisk / 1048576).toFixed(1)}MB rendererRSS=${rss}MB status="${status}"`)
  if (!aborted && elapsed >= abortAt) { await page.click('#abortSw'); aborted = true; log('ABORT clicked') }
  if (/done|failed|errored|cancelled|download triggered/.test(status) && elapsed > 5) break
  if (elapsed > expectedSeconds + 600) { log('giving up'); break }
  await page.waitForTimeout(15000)
}
let outcome = 'no download event'
if (download) {
  const failure = await download.failure()
  outcome = failure ? `download FAILED: ${failure}` : `download completed: ${await download.path()}`
}
const rssValues = samples.map((s) => s.rss).filter((v) => v > 0)
log('RESULT', JSON.stringify({ browser: browserName, mode, totalMB, rateMBs, keepalive, transferable, shortClose, firstGrowth, outcome,
  finalOnDiskMB: Math.round(dirBytes() / 1048576), rssMinMB: Math.min(...rssValues), rssMaxMB: Math.max(...rssValues), samples: samples.length }))
await browser.close()
rmSync(dlDir, { recursive: true, force: true })
