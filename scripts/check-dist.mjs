import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

execFileSync('git', ['diff', '--exit-code', '--', 'dist'], {
  cwd: repositoryRoot,
  stdio: 'inherit',
})

const untrackedDistFiles = execFileSync(
  'git',
  ['ls-files', '--others', '--exclude-standard', '--', 'dist'],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }
)
  .trim()
  .split('\n')
  .filter(Boolean)

if (untrackedDistFiles.length > 0) {
  console.error('Generated dist files are not tracked:')
  for (const file of untrackedDistFiles) console.error(`- ${file}`)
  process.exitCode = 1
}
