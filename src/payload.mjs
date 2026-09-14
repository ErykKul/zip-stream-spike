export const MIB = 1024 ** 2
export const GIB = 1024 ** 3
export const MAX_ENTRY_BYTES = 5 * GIB
export const PATTERN_BYTES = 256 * 1024

// Versioned deterministic bytes. All entries start at byte zero of this pattern.
// Repetition avoids random-number CPU costs; ZIP uses STORE, without compression.
export function makePattern() {
  const pattern = new Uint8Array(PATTERN_BYTES)
  let seed = 0x6d2b79f5
  for (let i = 0; i < pattern.length; i++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    pattern[i] = seed >>> 24
  }
  return pattern
}

export function describePayload(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < MIB || bytes % MIB || bytes > 256 * GIB) {
    throw new Error('Choose a whole number of MiB between 1 MiB and 256 GiB.')
  }
  const sizes = []
  let remaining = bytes
  while (remaining >= MAX_ENTRY_BYTES) {
    sizes.push(MAX_ENTRY_BYTES)
    remaining -= MAX_ENTRY_BYTES
  }
  for (let size = 4 * GIB; size >= MIB; size /= 2) {
    if (remaining >= size) {
      sizes.push(size)
      remaining -= size
    }
  }
  return sizes.map((size, index) => ({
    name: `part-${String(index + 1).padStart(3, '0')}-${size / MIB}MiB.bin`,
    path: `payload/part-${String(index + 1).padStart(3, '0')}-${size / MIB}MiB.bin`,
    size
  }))
}
