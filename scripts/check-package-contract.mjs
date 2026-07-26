import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))
const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8')
const chineseReadme = await readFile(
  path.join(repositoryRoot, 'README.zh-CN.md'),
  'utf8'
)
const documentation = await readFile(
  path.join(repositoryRoot, 'docs/api.zh-CN.md'),
  'utf8'
)
const requiredDocumentSections = [
  '定位与非目标',
  '安装',
  '公共入口',
  '核心类与接口',
  '生命周期/并发',
  '依赖注入',
  '错误模型',
  '最小第三方示例',
  '扩展点',
  '兼容策略',
]

for (const field of ['description', 'license', 'repository']) {
  if (!manifest[field]) throw new Error(`${manifest.name} is missing package.json#${field}`)
}
if (!manifest.engines?.node) throw new Error(`${manifest.name} is missing a Node.js engine range`)
if (manifest.sideEffects === undefined) throw new Error(`${manifest.name} must declare sideEffects`)
if (!manifest.files?.includes('docs')) throw new Error(`${manifest.name} does not publish docs`)
if (manifest.publishConfig?.access !== 'public') {
  throw new Error(`${manifest.name} must publish with public access`)
}
if (manifest.publishConfig?.registry !== 'https://npm.pkg.github.com') {
  throw new Error(`${manifest.name} must publish through GitHub Packages`)
}

const privatePackageClaims = [
  /\bprivate\b[^\n]{0,80}@velaros-ai/iu,
  /@velaros-ai[^\n]{0,80}\bprivate\b/iu,
  /私有[^\n]{0,80}@velaros-ai/u,
  /@velaros-ai[^\n]{0,80}私有/u,
]
for (const [fileName, contents] of [
  ['README.md', readme],
  ['README.zh-CN.md', chineseReadme],
  ['docs/api.zh-CN.md', documentation],
]) {
  for (const pattern of privatePackageClaims) {
    if (pattern.test(contents)) {
      throw new Error(`${fileName} must not describe the public package or scope as private`)
    }
  }
}
if (!readme.includes('public package') || !readme.includes('read:packages')) {
  throw new Error('README.md must document public package visibility and GitHub npm authentication')
}
if (!chineseReadme.includes('公开包') || !chineseReadme.includes('read:packages')) {
  throw new Error(
    'README.zh-CN.md must document public package visibility and GitHub npm authentication'
  )
}
for (const section of requiredDocumentSections) {
  if (!documentation.includes(`## ${section}`)) {
    throw new Error(`${manifest.name} API documentation is missing "${section}"`)
  }
}

for (const [publicPath, declaration] of Object.entries(manifest.exports ?? {})) {
  for (const target of readExportTargets(declaration)) {
    try {
      await access(path.join(repositoryRoot, target))
    } catch {
      throw new Error(`${manifest.name} export ${publicPath} points to missing ${target}`)
    }
  }
}

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'velaros-html-consumer-'))
try {
  capture(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryDirectory],
    repositoryRoot
  )
  const tarballs = (await readdir(temporaryDirectory)).filter((file) => file.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`${manifest.name} produced ${tarballs.length} tarballs`)
  }
  const tarball = path.join(temporaryDirectory, tarballs[0])
  await writeFile(
    path.join(temporaryDirectory, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  )
  await writeFile(
    path.join(temporaryDirectory, 'consumer.mjs'),
    Object.keys(manifest.exports)
      .map((publicPath, index) => {
        const specifier =
          publicPath === '.' ? manifest.name : `${manifest.name}/${publicPath.slice(2)}`
        return `import * as entry${index} from ${JSON.stringify(specifier)}\nvoid entry${index}\n`
      })
      .join('')
  )
  await writeFile(
    path.join(temporaryDirectory, 'consumer.ts'),
    Object.keys(manifest.exports)
      .map((publicPath, index) => {
        const specifier =
          publicPath === '.' ? manifest.name : `${manifest.name}/${publicPath.slice(2)}`
        return `import * as Entry${index} from ${JSON.stringify(specifier)}\nvoid Entry${index}\n`
      })
      .join('')
  )
  await writeFile(
    path.join(temporaryDirectory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: true,
        skipLibCheck: false,
        strict: true,
        target: 'ES2023',
      },
      files: ['./consumer.ts'],
    })
  )

  capture(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball],
    temporaryDirectory
  )
  capture(process.execPath, ['./consumer.mjs'], temporaryDirectory)
  capture(
    process.execPath,
    [path.join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    temporaryDirectory
  )

  const packedManifest = JSON.parse(
    await readFile(
      path.join(temporaryDirectory, 'node_modules', ...manifest.name.split('/'), 'package.json'),
      'utf8'
    )
  )
  for (const requiredFile of [
    'README.md',
    'README.zh-CN.md',
    'docs/api.zh-CN.md',
  ]) {
    await access(
      path.join(
        temporaryDirectory,
        'node_modules',
        ...manifest.name.split('/'),
        requiredFile
      )
    )
  }
  if (packedManifest.version !== manifest.version) {
    throw new Error(`${manifest.name} packed version does not match source manifest`)
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}

console.info(
  'HTML Artifacts package contract: metadata, exports, docs, runtime imports, and strict external types are valid.'
)

function readExportTargets(declaration) {
  if (typeof declaration === 'string') return [declaration]
  if (!declaration || typeof declaration !== 'object') return []
  return Object.values(declaration).filter((value) => typeof value === 'string')
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stdout || ''}\n${result.stderr || ''}`
    )
  }
  return result.stdout.trim()
}
