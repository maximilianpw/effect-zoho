import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ignoreBaselineVariable, type CommentBaseline } from './oxlint-no-comments.ts'

const root = join(import.meta.dirname, '..')
const baselineFile = join(root, 'comment-baseline.json')
const usage = 'Usage: bun run comments list [path...] | baseline [--grandfather path...]'

interface Found {
  readonly file: string
  readonly line: number
  readonly text: string
}

function findComments(paths: ReadonlyArray<string>): ReadonlyArray<Found> {
  const run = spawnSync(join(root, 'node_modules/.bin/oxlint'), ['--format', 'json', ...(paths.length === 0 ? ['.'] : paths)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, [ignoreBaselineVariable]: '1' },
  })
  if (run.stdout.trim() === '') throw new Error(`oxlint produced no report:\n${run.stderr}`)
  const report = JSON.parse(run.stdout) as {
    readonly diagnostics: ReadonlyArray<{
      readonly code: string
      readonly filename: string
      readonly labels: ReadonlyArray<{ readonly span: { readonly offset: number; readonly length: number; readonly line: number } }>
    }>
  }
  return report.diagnostics
    .filter((diagnostic) => diagnostic.code === 'local(no-comments)')
    .map(({ filename, labels: [label] }) => {
      if (label === undefined) throw new Error(`no location for a comment in ${filename}`)
      const source = readFileSync(join(root, filename), 'utf8')
      return { file: filename, line: label.span.line, text: source.slice(label.span.offset, label.span.offset + label.span.length) }
    })
}

const countByFile = (found: ReadonlyArray<Found>): ReadonlyMap<string, number> =>
  found.reduce((counts, { file }) => counts.set(file, (counts.get(file) ?? 0) + 1), new Map<string, number>())

function writeBaseline(baseline: CommentBaseline): void {
  const entries = Object.entries(baseline).filter(([, count]) => count > 0).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) rmSync(baselineFile, { force: true })
  else writeFileSync(baselineFile, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`)
  const total = entries.reduce((sum, [, count]) => sum + count, 0)
  console.log(`comment-baseline.json allows ${total} comments in ${entries.length} files.`)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'list') {
  const found = findComments(rest)
  for (const { file, line, text } of found) console.log(`${file}:${line}\n  ${text.split('\n').map((each) => each.trim()).join('\n  ')}`)
  console.log(`${found.length} comments in ${countByFile(found).size} files.`)
} else if (command === 'baseline') {
  const grandfathered = rest[0] === '--grandfather' ? rest.slice(1).map((path) => path.replace(/^\.\//, '').replace(/\/$/, '')) : []
  if (rest.length > 0 && grandfathered.length === 0) throw new Error(usage)
  const counts = countByFile(findComments([]))
  const current: CommentBaseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {}
  const tightened = Object.fromEntries(Object.entries(current).map(([file, allowed]) => [file, Math.min(allowed, counts.get(file) ?? 0)]))
  const added = [...counts].filter(([file]) => grandfathered.some((path) => path === '.' || file === path || file.startsWith(`${path}/`)))
  writeBaseline({ ...tightened, ...Object.fromEntries(added) })
} else {
  console.error(usage)
  process.exit(1)
}
