import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'out-dir': { type: 'string' },
    'require-tag': { type: 'boolean', default: false },
    'source-sha': { type: 'string' },
    tag: { type: 'string' },
  },
})

function run(command, args) {
  return execFileSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim()
}

const sourceSha = run('git', ['rev-parse', 'HEAD'])
if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  throw new Error(`Expected a full source commit SHA, received: ${sourceSha}`)
}
if (values['source-sha'] && values['source-sha'] !== sourceSha) {
  throw new Error(
    `Requested source SHA ${values['source-sha']} does not match checkout ${sourceSha}`
  )
}

const expectedTag = `v${packageJson.version}`
const releaseTag = values.tag ?? expectedTag
if (releaseTag !== expectedTag) {
  throw new Error(`Release tag ${releaseTag} does not match package version ${expectedTag}`)
}

if (values['require-tag']) {
  const taggedSourceSha = run('git', ['rev-parse', '--verify', `refs/tags/${releaseTag}^{commit}`])
  if (taggedSourceSha !== sourceSha) {
    throw new Error(
      `Tag ${releaseTag} points to ${taggedSourceSha}, but the release source is ${sourceSha}`
    )
  }
}

const temporaryDirectory = values['dry-run']
  ? mkdtempSync(join(tmpdir(), 'velaros-html-artifacts-release-'))
  : null
const outputDirectory = temporaryDirectory ?? resolve(repositoryRoot, values['out-dir'] ?? 'release')
mkdirSync(outputDirectory, { recursive: true })

try {
  const packResult = JSON.parse(
    run('npm', [
      'pack',
      '--json',
      '--silent',
      '--pack-destination',
      outputDirectory,
    ])
  )
  if (!Array.isArray(packResult) || packResult.length !== 1 || !packResult[0]?.filename) {
    throw new Error('npm pack did not return exactly one package archive')
  }

  const archivePath = resolve(outputDirectory, packResult[0].filename)
  const archive = readFileSync(archivePath)
  const manifest = {
    packageName: packageJson.name,
    version: packageJson.version,
    tag: releaseTag,
    sourceSha,
    tarball: {
      fileName: basename(archivePath),
      sizeBytes: archive.byteLength,
      sha256: createHash('sha256').update(archive).digest('hex'),
    },
  }
  const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`

  if (values['dry-run']) {
    process.stdout.write(serializedManifest)
  } else {
    writeFileSync(join(outputDirectory, 'release-manifest.json'), serializedManifest)
  }
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
}
