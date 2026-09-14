import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

const frontend = resolve(process.argv[2] || '../dataverse-frontend')
const paths = [
  'LICENSE',
  'src/sections/dataset/dataset-files/files-tree/useStreamingZipDownload.ts',
  'src/sections/dataset/dataset-files/files-tree/zipStreamSink.ts',
  'src/sections/dataset/dataset-files/files-tree/zipDownloadLimits.ts',
  'src/sections/dataset/dataset-files/files-tree/format.ts',
  'src/shared/hooks/useBeforeUnloadGuard.ts',
  'src/files/domain/models/FileTreeItem.ts',
  'src/files/domain/models/FileAccess.ts',
  'src/files/domain/models/FileMetadata.ts',
  'src/files/domain/models/FileTypeToFriendlyTypeMap.ts',
  'public/zip-download-sw.js'
]
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: frontend, encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...paths], { cwd: frontend, encoding: 'utf8' }).trim()
if (dirty) throw new Error('Refusing to snapshot modified frontend source files')
const sourceFiles = {}
for (const path of paths) {
  const content = await readFile(resolve(frontend, path))
  const output = path === 'public/zip-download-sw.js' ? 'reusable-components/zip-download-sw.js' : `vendor/frontend/${path}`
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, content)
  sourceFiles[path] = createHash('sha256').update(content).digest('hex')
}
await writeFile('vendor/frontend/source.json', JSON.stringify({
  repository: 'https://github.com/IQSS/dataverse-frontend',
  sourceCommit,
  sourceFiles
}, null, 2) + '\n')
console.log(`Copied ${paths.length} unchanged frontend files from ${sourceCommit}`)
