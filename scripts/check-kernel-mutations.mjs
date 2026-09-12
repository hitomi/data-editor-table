import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(path.join(tmpdir(), 'data-editor-kernel-mutations-'))
const tests = ['protocol', 'entities', 'persistence', 'history', 'reference-model', 'structure-model', 'session', 'task', 'generated-trace', 'generated-save-model', 'generated-history-model', 'generated-task-model', 'durable-ingress'].map(name => `src/kernel/${name}.test.ts`)
const mutations = [
  { id: 'drop-rejected-ingress', file: 'src/kernel/durable-commit.ts',
    from: "if (transition.result.kind !== 'accepted' && !ingress)",
    to: "if (transition.result.kind !== 'accepted')" },
  { id: 'drop-unconfirmed-deletion', file: 'src/kernel/projection.ts',
    from: 'if (intent.sequence > through || settled.has(intent.id)) return []',
    to: "if (intent.sequence > through || settled.has(intent.id) || intent.operation.kind === 'delete') return []" },
  { id: 'latest-as-normalization', file: 'src/kernel/shared-state-bases.ts',
    from: "return { kind: 'canonical', item, document: result.kind === 'deleted' ? null : result.canonical }",
    to: "return { kind: 'canonical', item, document: state.authority.content.kind === 'complete' ? state.authority.content.snapshot.entities.find(row => row.entityId === entity)?.document ?? null : null }" },
  { id: 'ignore-incarnation', file: 'src/kernel/protocol.ts',
    from: 'return JSON.stringify([typeof identity.key, identity.key, identity.incarnation])',
    to: 'return JSON.stringify([typeof identity.key, identity.key])' },
  { id: 'settle-unsent-intents', file: 'src/kernel/persistence.ts',
    from: 'submission.coverage.flatMap(entry => entry.intentIds.map(intentId => ({',
    to: 'submission.coverage.flatMap(entry => state.journal.intents.map(record => record.id).map(intentId => ({' },
  { id: 'suppress-unknown-undo', file: 'src/kernel/intent.ts',
    from: "if ('submission' in state.persistence && state.persistence.submission.coverage.some(item => item.intentIds.some(id => operation.targets.includes(id)))) return 'unknown'",
    to: "if ('submission' in state.persistence && state.persistence.submission.coverage.some(item => item.intentIds.some(id => operation.targets.includes(id)))) return 'suppress'" },
  { id: 'accept-obsolete-attempt', file: 'src/kernel/persistence.ts',
    from: "state.persistence.kind !== 'sending' || state.persistence.attempt !== attempt || !matches(state.persistence.submission, ref)",
    to: "state.persistence.kind !== 'sending' || !matches(state.persistence.submission, ref)" },
  { id: 'accept-older-authority', file: 'src/kernel/protocol.ts',
    from: 'return BigInt(actual.position) >= BigInt(required.position)', to: 'return true' },
  { id: 'ignore-session-input-owner', file: 'src/kernel/task.ts',
    from: 'return state.session?.id === owner.sessionId && inputRefKey(state.session.input) === inputRefKey(owner.input)',
    to: 'return state.session?.id === owner.sessionId' },
  { id: 'cancel-consumed-task', file: 'src/kernel/task.ts',
    from: "if (task.kind === 'cancelled' || task.kind === 'consumed') return ignored(state, 'Task already has a terminal disposition.')",
    to: "if (task.kind === 'cancelled') return ignored(state, 'Task already has a terminal disposition.')" },
]
const hash = text => createHash('sha256').update(text).digest('hex')
const originals = new Map()
const report = { tests, baseline: null, mutations: [], workspaceUnchanged: false }
// Playwright owns and clears test-results at startup, including in prepublishOnly.
const reportDirectory = path.join(root, 'kernel-mutation-results')
async function run(label) {
  const output = path.join(temporary, `${label}.json`)
  let exitCode = 0, diagnostics = ''
  try {
    const result = await execute(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...tests, '--reporter=json', `--outputFile=${output}`],
      { cwd: temporary, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
    diagnostics = result.stdout + result.stderr
  } catch (error) {
    if (typeof error.code !== 'number' || error.killed) throw error
    exitCode = error.code; diagnostics = (error.stdout ?? '') + (error.stderr ?? '')
  }
  const result = JSON.parse(await readFile(output, 'utf8'))
  const failed = result.testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed').map(test => ({ suite: path.relative(temporary, suite.name), name: test.fullName, failures: test.failureMessages })))
  await writeFile(path.join(reportDirectory, `${label}.json`), JSON.stringify({ exitCode, result, diagnostics }, null, 2))
  return { exitCode, passed: result.numPassedTests, failed }
}
try {
  await mkdir(reportDirectory, { recursive: true })
  for (const name of ['src', 'tests/kernel', 'package.json', 'vitest.config.ts', 'tsconfig.json']) await cp(path.join(root, name), path.join(temporary, name), { recursive: true })
  await symlink(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), 'dir')
  for (const mutation of mutations) if (!originals.has(mutation.file)) originals.set(mutation.file, await readFile(path.join(root, mutation.file), 'utf8'))
  report.baseline = await run('baseline')
  if (report.baseline.exitCode !== 0 || report.baseline.failed.length || !report.baseline.passed) throw new Error('Mutation baseline must pass before faults are injected.')
  for (const mutation of mutations) {
    const original = originals.get(mutation.file)
    if (original.split(mutation.from).length !== 2) throw new Error(`Mutation anchor must match exactly once: ${mutation.id}`)
    await writeFile(path.join(temporary, mutation.file), original.replace(mutation.from, mutation.to))
    let result
    try { result = await run(mutation.id) }
    finally { await writeFile(path.join(temporary, mutation.file), original) }
    const detected = result.exitCode !== 0 && result.failed.length > 0
    report.mutations.push({ ...mutation, originalHash: hash(original), detected, ...result })
    console.log(`${detected ? 'Detected' : 'SURVIVED'} ${mutation.id}: ${result.failed.length} failing tests`)
  }
  for (const [file, original] of originals) if (await readFile(path.join(root, file), 'utf8') !== original) throw new Error(`Workspace source changed during mutation audit: ${file}`)
  report.workspaceUnchanged = true
  if (report.mutations.some(mutation => !mutation.detected)) throw new Error('A semantic fault survived; add a meaningful regression before accepting this gate.')
  console.log(`Verified ${report.mutations.length} semantic mutations; report: ${path.join(reportDirectory, 'summary.json')}`)
} finally {
  try {
    await mkdir(reportDirectory, { recursive: true })
    await writeFile(path.join(reportDirectory, 'summary.json'), JSON.stringify(report, null, 2))
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
