import { expect, it } from 'vitest'
import { KernelFixture, permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { RecoveryFixture } from '../../tests/kernel/recovery-fixture.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { kernelId, type Document } from './model.js'
import { defineKernelSchema } from './schema.js'
import { Workspace } from './workspace.js'

const replacements: readonly Document[] = [
  { x: 2 }, { x: 2, hidden: null }, { x: 2, hidden: { sibling: 'keep' } }, { x: 2, hidden: { secret: 1, sibling: 'keep' } },
]
const cases = (['schema', 'policy'] as const).flatMap(boundary => replacements.map((document, index) => ({ boundary, document, index })))
it.each(cases)('retains the complete rejected replacement across reopen for $boundary case $index', async ({ boundary, document, index }) => {
  const scope = { sourceId: `replace:${boundary}:${index}`, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const initial = { a: { x: 0, hidden: { secret: null, sibling: 'keep' } }, b: { x: 0, hidden: { secret: null, sibling: 'keep' } } }
  const source = new SourceFixture(scope, initial)
  const schema = defineKernelSchema({ ...permissiveSchema, fields: [{ id: kernelId<'field'>('secret'), path: ['hidden', 'secret'], readonly: boundary === 'schema' }] })
  const policy = { ...permissivePolicy, defaultEntity: { ...permissivePolicy.defaultEntity,
    readonlyPaths: boundary === 'policy' ? [['hidden', 'secret'] as const] : [] } }
  const storage = new RecoveryFixture({ id: kernelId<'workspace'>('replacement'), scope, schema: schema.version, codec: schema.codec })
  const options = { scope, source, schema, policy }
  const workspace = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: false })
  await workspace.refresh()
  const before = workspace.getState(), rows = workspace.getProjection().rows
  const fixture = new KernelFixture(undefined, schema); fixture.state = before
  const raw = { rows: [{ x: 1, hidden: initial.a.hidden }, document], label: '完整替换原文' }
  const prepared = fixture.prepare(rows.map((row, position) => ({ kind: 'replace', entityId: row.entityId, document: raw.rows[position]! })), 'transaction', raw)
  expect((await workspace.dispatch({ kind: 'prepared-action', prepared })).kind).toBe('rejected')
  expect(workspace.getState()).toBe(before)
  expect(workspace.getProjection().changes).toEqual([])
  expect(workspace.getState().journal.intents).toEqual([])
  const pending = workspace.getIngress().pending
  expect(pending).toHaveLength(1)
  expect(pending[0]).toMatchObject({ phase: 'rejected', payload: { event: { prepared: { inputs: [{ input: { kind: 'encoded', value: raw } }] } } } })
  expect(storage.root?.record.ingress?.snapshot.pending).toEqual(pending)
  const restored = await Workspace.openDurable({ ...options, session: storage.acquire(), restore: true })
  expect(restored.getIngress().pending).toEqual(pending)
  expect(restored.getProjection().rows.map(row => row.preview)).toEqual(Object.values(initial))
  expect(restored.getProjection().changes).toEqual([])
  expect(source.snapshot().rows.map(row => row.document)).toEqual(Object.values(initial))
  expect(source.writes).toBe(0)
})
