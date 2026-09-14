import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makePattern, MIB, GIB } from '../src/payload.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const localRequire = createRequire(new URL('../package.json', import.meta.url))
const frontendRequire = createRequire(resolve(root, '../dataverse-frontend/package.json'))
let dependencyRequire
try { localRequire.resolve('esbuild'); dependencyRequire = localRequire }
catch { dependencyRequire = frontendRequire }
const { build } = dependencyRequire('esbuild')
const packageSpec = JSON.parse(await readFile('package.json', 'utf8'))
const libraries = {}
await mkdir('licenses', { recursive: true })
for (const [name, version] of Object.entries({ ...packageSpec.dependencies, ...packageSpec.devDependencies })) {
  let pkgPath
  try { pkgPath = dependencyRequire.resolve(`${name}/package.json`) }
  catch { pkgPath = resolve(dependencyRequire.resolve(name), '../package.json') }
  const installed = JSON.parse(await readFile(pkgPath, 'utf8'))
  if (installed.version !== version) throw new Error(`${name}: expected ${version}, installed ${installed.version}`)
  libraries[name] = version
  let license
  for (const filename of ['LICENSE', 'LICENSE.txt', 'LICENSE.md']) {
    try { license = await readFile(resolve(dirname(pkgPath), filename)); break }
    catch { /* Try the alternate filename. */ }
  }
  if (!license) throw new Error(`Missing license text for ${name}`)
  await writeFile(`licenses/${name.replaceAll('/', '-')}-${version}.txt`, license)
}
const source = JSON.parse(await readFile('vendor/frontend/source.json', 'utf8'))
for (const [path, expected] of Object.entries(source.sourceFiles)) {
  const local = path === 'public/zip-download-sw.js' ? 'reusable-components/zip-download-sw.js' : `vendor/frontend/${path}`
  const actual = createHash('sha256').update(await readFile(local)).digest('hex')
  if (actual !== expected) throw new Error(`Frontend snapshot was modified: ${local}`)
}

const pattern = makePattern()
const digest = createHash('sha256')
const digestSizes = new Set([5 * GIB])
for (let size = MIB; size <= 4 * GIB; size *= 2) digestSizes.add(size)
const checksums = {}
for (let bytes = pattern.length; bytes <= 5 * GIB; bytes += pattern.length) {
  digest.update(pattern)
  if (digestSizes.has(bytes)) checksums[bytes] = digest.copy().digest('hex')
}
await mkdir('generated', { recursive: true })
await writeFile('generated/checksums.json', JSON.stringify(checksums, null, 2) + '\n')
const metadata = { ...source, libraries, clientZipVersion: libraries['client-zip'],
  pattern: 'xorshift32-6d2b79f5-repeat-256KiB-v1',
  rangeBytes: 10 * MIB, sourceChunkBytes: pattern.length,
  maximumEntryBytes: 5 * GIB,
  workerPath: 'reusable-components/zip-download-sw.js',
  completionMeaning: 'Source stream consumed; saved file must be verified separately.' }
const inputs = ['src/engine.ts', 'src/verify.mjs', 'src/verify-worker.mjs', 'src/payload.mjs', 'scripts/build.mjs', 'package.json']
const hash = createHash('sha256').update(JSON.stringify(metadata)).update(JSON.stringify(checksums))
for (const input of inputs) hash.update(await readFile(input))
metadata.buildId = hash.digest('hex').slice(0, 16)
await writeFile('generated/metadata.json', JSON.stringify(metadata, null, 2) + '\n')
const options = {
  bundle: true, format: 'esm', target: ['es2020'], minify: true, sourcemap: true,
  legalComments: 'linked', nodePaths: [resolve(dependencyRequire.resolve('react'), '../..')],
  alias: { '@': resolve('vendor/frontend/src') },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.BASE_URL': '"./"' }
}
await build({ ...options, entryPoints: ['src/engine.ts'], outfile: 'engine.js', platform: 'browser' })
await build({ ...options, entryPoints: ['src/verify-worker.mjs'], outfile: 'verify-worker.js', platform: 'browser' })
await writeFile('provenance.json', JSON.stringify(metadata, null, 2) + '\n')
console.log(`Built engine ${metadata.buildId} from frontend ${source.sourceCommit}`)
