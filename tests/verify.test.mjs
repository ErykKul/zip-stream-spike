import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describePayload, makePattern, MIB, GIB } from '../src/payload.mjs'

const localRequire = createRequire(new URL('../package.json', import.meta.url))
let dependencyRequire
try { localRequire.resolve('esbuild'); dependencyRequire = localRequire }
catch { dependencyRequire = createRequire(new URL('../../dataverse-frontend/package.json', import.meta.url)) }
const { build } = dependencyRequire('esbuild')
const bundle = await build({
  entryPoints: ['src/verify.mjs'], bundle: true, write: false, platform: 'node', format: 'esm',
  nodePaths: [resolve(dependencyRequire.resolve('react'), '../..')]
})
const { verifyZip } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const { makeZip } = await import(pathToFileURL(dependencyRequire.resolve('client-zip')).href)
const checksums = JSON.parse(await readFile(new URL('../generated/checksums.json', import.meta.url), 'utf8'))

async function archive(bytes, { wrongContent = false, wrongName = false } = {}) {
  const pattern = makePattern()
  if (wrongContent) pattern[17] ^= 1
  const entries = describePayload(bytes).map((entry) => {
    let offset = 0
    return {
      name: wrongName ? 'different.bin' : entry.path,
      input: new ReadableStream({ pull(controller) {
        if (offset === entry.size) { controller.close(); return }
        controller.enqueue(pattern.slice())
        offset += pattern.length
      } })
    }
  })
  return new Response(makeZip(entries)).blob()
}

test('plans RAM presets with both large ZIP64 entries and exact payload sizes', () => {
  for (const ram of [4, 8, 16, 24, 32, 48, 64, 96, 128]) {
    const bytes = (ram + Math.max(1, Math.ceil(ram * .09))) * GIB
    const plan = describePayload(bytes)
    assert.equal(plan.reduce((sum, entry) => sum + entry.size, 0), bytes)
    assert.ok(plan.some((entry) => entry.size > 4 * GIB))
    assert.ok(plan.every((entry) => checksums[entry.size]))
  }
  assert.throws(() => describePayload(0))
  assert.throws(() => describePayload(MIB + 1))
})

test('verifies a real client-zip archive and every entry checksum', async () => {
  const file = await archive(3 * MIB)
  const progress = []
  const result = await verifyZip(file, { checksums, expectedPayloadBytes: 3 * MIB, onProgress: (event) => progress.push(event) })
  assert.equal(result.verified, true)
  assert.equal(result.entries, 2)
  assert.equal(result.payloadBytes, 3 * MIB)
  assert.equal(result.zipBytes, file.size)
  assert.equal(result.zip64, false)
  assert.equal(progress.at(-1).bytesRead, 3 * MIB)
})

test('rejects truncation, unexpected prefixes, and the wrong saved test size', async () => {
  const file = await archive(MIB)
  await assert.rejects(verifyZip(file.slice(0, file.size - 1), { checksums }), /missing|truncated/)
  await assert.rejects(verifyZip(new Blob(['x', file]), { checksums }), /boundary/)
  await assert.rejects(verifyZip(file, { checksums, expectedPayloadBytes: 2 * MIB }), /different test size/)
})

test('rejects payload corruption and a valid ZIP containing the wrong content', async () => {
  const file = await archive(MIB)
  const bytes = new Uint8Array(await file.arrayBuffer())
  bytes[1000] ^= 1
  await assert.rejects(verifyZip(new Blob([bytes]), { checksums }), /CRC-32 mismatch/)
  await assert.rejects(verifyZip(await archive(MIB, { wrongContent: true }), { checksums }), /SHA-256 mismatch/)
  await assert.rejects(verifyZip(await archive(MIB, { wrongName: true }), { checksums }), /unexpected entry/)
})

test('rejects central directory and data descriptor damage', async () => {
  const file = await archive(MIB)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const view = new DataView(bytes.buffer)
  const central = view.getUint32(bytes.length - 6, true)
  const badDirectory = bytes.slice()
  badDirectory[central] ^= 1
  await assert.rejects(verifyZip(new Blob([badDirectory]), { checksums }), /directory entry is damaged/)
  const badDescriptor = bytes.slice()
  badDescriptor[central - 16] ^= 1
  await assert.rejects(verifyZip(new Blob([badDescriptor]), { checksums }), /invalid data descriptor/)
})
