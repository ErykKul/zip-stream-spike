import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describePayload } from './payload.mjs'

const table = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let value = i
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  table[i] = value
}
function crc32(bytes, previous = 0) {
  let crc = ~previous
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff]
  return ~crc >>> 0
}
function fail(message) { throw new Error(`ZIP verification failed: ${message}`) }
function integer64(view, offset) {
  const value = view.getBigUint64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('a ZIP64 value exceeds the supported range')
  return Number(value)
}
async function read(file, start, length) {
  if (!Number.isSafeInteger(start) || start < 0 || start + length > file.size) fail('archive is truncated')
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer())
}
function dataView(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }

export async function verifyZip(file, { checksums, expectedPayloadBytes, onProgress } = {}) {
  const startedAt = performance.now()
  if (!file || file.size < 22) fail('file is empty or too short')
  const tailOffset = Math.max(0, file.size - 65557)
  const tail = await read(file, tailOffset, file.size - tailOffset)
  const view = dataView(tail)
  let end = -1
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === tail.length) {
      end = offset
      break
    }
  }
  if (end < 0) fail('end-of-directory record is missing; download may be incomplete')
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) fail('multi-disk archives are unsupported')
  if (view.getUint16(end + 20, true)) fail('unexpected archive comment')
  let count = view.getUint16(end + 10, true)
  let centralSize = view.getUint32(end + 12, true)
  let centralOffset = view.getUint32(end + 16, true)
  let zip64 = false
  let recordsOffset = tailOffset + end
  if (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) {
    zip64 = true
    if (view.getUint32(end - 16, true) || view.getUint32(end - 4, true) !== 1) fail('invalid ZIP64 disk record')
    recordsOffset = integer64(view, end - 12)
    const record = dataView(await read(file, recordsOffset, 56))
    if (record.getUint32(0, true) !== 0x06064b50 || integer64(record, 4) !== 44) fail('invalid ZIP64 end record')
    if (recordsOffset + 56 !== tailOffset + end - 20) fail('unexpected ZIP64 end position')
    if (record.getUint32(16, true) || record.getUint32(20, true)) fail('invalid ZIP64 disk numbers')
    count = integer64(record, 32)
    if (integer64(record, 24) !== count) fail('inconsistent ZIP64 entry count')
    centralSize = integer64(record, 40)
    centralOffset = integer64(record, 48)
  }
  if (count < 1 || count > 1024 || centralSize > 1024 ** 2) fail('unexpected central directory size')
  if (centralOffset + centralSize !== recordsOffset) fail('central directory boundary is wrong')
  const directory = await read(file, centralOffset, centralSize)
  const central = dataView(directory)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const entries = []
  let cursor = 0
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > directory.length || central.getUint32(cursor, true) !== 0x02014b50) fail('central directory entry is damaged')
    const flags = central.getUint16(cursor + 8, true)
    if (flags & 1 || central.getUint16(cursor + 10, true) !== 0) fail('entries must be unencrypted and stored without compression')
    const nameLength = central.getUint16(cursor + 28, true)
    const extraLength = central.getUint16(cursor + 30, true)
    const commentLength = central.getUint16(cursor + 32, true)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > directory.length || central.getUint16(cursor + 34, true)) fail('invalid directory entry length or disk')
    const name = decoder.decode(directory.subarray(cursor + 46, cursor + 46 + nameLength))
    let size = central.getUint32(cursor + 24, true)
    let compressedSize = central.getUint32(cursor + 20, true)
    let offset = central.getUint32(cursor + 42, true)
    const largeSize = size === 0xffffffff
    let extra = cursor + 46 + nameLength
    const extraEnd = extra + extraLength
    while (extra < extraEnd) {
      if (extra + 4 > extraEnd) fail('invalid extra field')
      const type = central.getUint16(extra, true)
      const length = central.getUint16(extra + 2, true)
      if (extra + 4 + length > extraEnd) fail('truncated extra field')
      if (type === 1) {
        let field = extra + 4
        const next64 = () => { if (field + 8 > extra + 4 + length) fail('truncated ZIP64 extra field'); const value = integer64(central, field); field += 8; return value }
        if (size === 0xffffffff) size = next64()
        if (compressedSize === 0xffffffff) compressedSize = next64()
        if (offset === 0xffffffff) offset = next64()
      }
      extra += 4 + length
    }
    if (size !== compressedSize) fail('stored entry sizes differ')
    entries.push({ name, size, offset, crc: central.getUint32(cursor + 16, true), flags, largeSize })
    cursor = next
  }
  if (cursor !== directory.length) fail('unexpected central directory data')
  const payloadBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
  if (expectedPayloadBytes !== undefined && payloadBytes !== expectedPayloadBytes) fail('saved file belongs to a different test size')
  const plan = describePayload(payloadBytes)
  if (plan.length !== entries.length) fail('unexpected number of payload entries')
  let bytesRead = 0
  let entriesDone = 0
  let nextOffset = 0
  let lastProgress = -Infinity
  const progress = (force = false) => {
    const now = performance.now()
    if (force || now - lastProgress > 250) {
      onProgress?.({ bytesRead, totalBytes: payloadBytes, entriesDone, totalEntries: entries.length, elapsedMs: now - startedAt })
      lastProgress = now
    }
  }
  progress(true)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.name !== plan[i].path || entry.size !== plan[i].size) fail(`unexpected entry ${entry.name}`)
    if (entry.offset !== nextOffset) fail(`entry order or boundary is wrong for ${entry.name}`)
    const local = dataView(await read(file, entry.offset, 30))
    if (local.getUint32(0, true) !== 0x04034b50 || local.getUint16(8, true) !== 0 || local.getUint16(6, true) !== entry.flags) fail(`invalid local header for ${entry.name}`)
    const nameLength = local.getUint16(26, true)
    const extraLength = local.getUint16(28, true)
    const name = decoder.decode(await read(file, entry.offset + 30, nameLength))
    if (name !== entry.name) fail('local and central entry names differ')
    const dataOffset = entry.offset + 30 + nameLength + extraLength
    if (dataOffset + entry.size > centralOffset) fail('entry extends into central directory')
    const hash = sha256.create()
    let crc = 0
    for (let offset = 0; offset < entry.size; offset += 4 * 1024 ** 2) {
      const bytes = await read(file, dataOffset + offset, Math.min(4 * 1024 ** 2, entry.size - offset))
      hash.update(bytes)
      crc = crc32(bytes, crc)
      bytesRead += bytes.length
      progress()
    }
    if (crc !== entry.crc) fail(`CRC-32 mismatch in ${entry.name}`)
    const expected = checksums[String(entry.size)]
    if (!expected || bytesToHex(hash.digest()) !== expected) fail(`synthetic payload SHA-256 mismatch in ${entry.name}`)
    const descriptorBytes = entry.largeSize ? 24 : 16
    const descriptor = dataView(await read(file, dataOffset + entry.size, descriptorBytes))
    if (descriptor.getUint32(0, true) !== 0x08074b50 || descriptor.getUint32(4, true) !== crc) fail(`invalid data descriptor for ${entry.name}`)
    const compressed = entry.largeSize ? integer64(descriptor, 8) : descriptor.getUint32(8, true)
    const size = entry.largeSize ? integer64(descriptor, 16) : descriptor.getUint32(12, true)
    if (compressed !== entry.size || size !== entry.size) fail(`descriptor size mismatch in ${entry.name}`)
    nextOffset = dataOffset + entry.size + descriptorBytes
    entriesDone++
    progress(true)
  }
  if (nextOffset !== centralOffset) fail('unexpected bytes before central directory')
  return { verified: true, entries: entries.length, payloadBytes, zipBytes: file.size,
    zip64, elapsedMs: performance.now() - startedAt, checks: 'SHA-256 and ZIP CRC-32' }
}
