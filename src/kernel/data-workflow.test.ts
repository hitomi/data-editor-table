import { describe, expect, it } from 'vitest'
import { entityId, KernelFixture, permissivePolicy } from '../../tests/kernel/fixtures.js'
import { ReferenceEditor } from '../../tests/kernel/reference-model.js'
import { kernelId, type Document, type InputRecord } from './model.js'
import { planDocumentWrite, type RowCommand } from './prepare.js'
import { compileChangePatches } from './projection.js'

const deletion = (entity: string): RowCommand => ({ kind: 'delete', entityId: entityId(entity) })
const row = (fixture: KernelFixture, entity: string) => fixture.project().rows.find(row => row.entityId === entityId(entity))
const rawInput = (input: InputRecord | undefined) => input?.input.kind === 'encoded' ? input.input.value : undefined

describe('data fact transitions', () => {
  it('keeps uninitialized, failed initial read and confirmed empty authority distinct', () => {
    const fixture = new KernelFixture()
    expect(() => fixture.prepare([{ kind: 'create', entityId: entityId('new'), document: {} }])).toThrow('complete authority')
    fixture.dispatch({ kind: 'read-started', ticket: 'read' })
    fixture.dispatch({ kind: 'read-failed', ticket: 'read', issue: { code: 'offline', message: 'Offline' } })
    expect(fixture.state.authority.content.kind).toBe('uninitialized')
    expect(fixture.state.authority.read.kind).toBe('failed')
    fixture.observe({}, 0)
    expect(fixture.state.authority.content.kind).toBe('complete')
    expect(fixture.state.authority.read.kind).toBe('idle')
    expect(fixture.project().rows).toEqual([])
  })

  it('rejects a whole prepared action when its second item has an invalid comparison', () => {
    const fixture = new KernelFixture({ a: { x: 0 }, b: { x: 0 } })
    const prepared = fixture.prepare([fixture.write('a', { x: 1 }), fixture.write('b', { x: 2 })])
    const second = prepared.intents[1]!
    if (second.operation.kind !== 'write') throw new Error('Unexpected fixture')
    const group = second.operation.groups[0]!
    const invalid = { ...prepared, intents: [prepared.intents[0]!, { ...second, operation: { ...second.operation,
      groups: [{ ...group, expectations: [{ ...group.expectations[0]!, expected: { kind: 'value' as const, value: 99 } }] }],
    } }] }
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'prepared-action', prepared: invalid }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    expect(fixture.state.journal.intents).toEqual([])
    expect(fixture.state.inputs).toEqual([])
    expect(rawInput(prepared.inputs[0])).toBe('original input')
  })

  it('rejects stale local preparation even when the authority observation has not changed', () => {
    const fixture = new KernelFixture({ a: { x: 0 } })
    const delayed = fixture.prepare([fixture.write('a', { x: 2 })], 'row', 'delayed 2')
    fixture.apply([fixture.write('a', { x: 1 })])
    const before = fixture.state
    const result = fixture.dispatch({ kind: 'prepared-action', prepared: delayed })
    expect(result.result).toMatchObject({ kind: 'rejected', issue: { message: expect.stringContaining('stale') } })
    expect(fixture.state).toBe(before)
    expect(row(fixture, 'a')?.preview).toEqual({ x: 1 })
    expect(rawInput(delayed.inputs[0])).toBe('delayed 2')
  })

  it('owns accepted input and documents independently of caller mutation', () => {
    const document = { x: { nested: 1 } }, input = { text: 'one' }
    const fixture = new KernelFixture({ a: document })
    const prepared = fixture.prepare([fixture.write('a', { x: { nested: 2 } })], 'row', input)
    input.text = 'corrupted'; document.x.nested = 99
    expect(fixture.dispatch({ kind: 'prepared-action', prepared }).result.kind).toBe('accepted')
    expect(row(fixture, 'a')?.authority).toEqual({ x: { nested: 1 } })
    expect(rawInput(fixture.state.inputs[0])).toEqual({ text: 'one' })
    expect(Object.isFrozen(fixture.state.journal.intents[0]?.operation)).toBe(true)
    const before = JSON.stringify(fixture.state)
    for (let i = 0; i < 3; i++) fixture.project()
    expect(JSON.stringify(fixture.state)).toBe(before)
  })

  it('retains a deletion conflict while another row becomes saveable and later satisfied', () => {
    const fixture = new KernelFixture({ a: { x: 0 }, b: { x: 0 } })
    const deleted = fixture.apply([deletion('a')], 'row', 'delete a')
    fixture.observe({ a: { x: 1 }, b: { x: 0 } }, 1)
    fixture.apply([fixture.write('b', { x: 2 })])
    expect(row(fixture, 'a')).toMatchObject({ existence: 'pending-delete', persistence: 'blocked', preview: { x: 1 }, intentIds: deleted.action.intentIds })
    expect(fixture.project().changes.map(change => change.entityId)).toEqual([entityId('b')])
    fixture.observe({ a: { x: 1 }, b: { x: 2 } }, 2)
    expect(row(fixture, 'a')?.persistence).toBe('blocked')
    expect(fixture.state.journal.intents[0]).toEqual(deleted.intents[0])
    expect(fixture.state.settlements.map(proof => proof.intentId)).not.toContain(deleted.intents[0]!.id)
    expect(rawInput(fixture.state.inputs[0])).toBe('delete a')
  })

  it('settles a deleted incarnation on complete absence without manufacturing a creation', () => {
    const fixture = new KernelFixture({ a: { x: 0 } })
    const deleted = fixture.apply([deletion('a')])
    fixture.observe({ a: { x: 1 } }, 1)
    fixture.observe({}, 2)
    expect(fixture.project().changes).toEqual([])
    expect(fixture.project().rows).toEqual([])
    expect(fixture.state.journal.intents).toEqual(deleted.intents)
    expect(fixture.state.settlements).toEqual([{ kind: 'externally-satisfied', intentId: deleted.intents[0]!.id, observation: kernelId<'observation'>('read:2') }])
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('settled-intents')
    expect(fixture.state.entities[0]?.kind).toBe('retired')
  })

  it('retains raw input through materialization failure and repeated matching display refreshes', () => {
    const fixture = new KernelFixture({ a: { profile: { name: 'A' }, hidden: 0 } })
    const prepared = fixture.apply([{ kind: 'write', entityId: entityId('a'), groups: [{ id: kernelId<'write-group'>('name'),
      writes: [{ kind: 'set', path: ['profile', 'name'], value: 'B' }], comparison: 'paths', reads: [],
    }] }], 'row', 'B')
    for (let version = 1; version <= 3; version++) {
      fixture.observe({ a: { profile: null, hidden: version } }, version)
      expect(row(fixture, 'a')?.preview).toEqual({ profile: null, hidden: version })
      expect(row(fixture, 'a')?.issues.some(issue => issue.code === 'materialization-blocked')).toBe(true)
      expect(fixture.state.journal.intents[0]).toEqual(prepared.intents[0])
      expect(fixture.state.settlements).toEqual([])
      expect(fixture.state.inputs[0]?.disposition.kind).toBe('intents')
      expect(rawInput(fixture.state.inputs[0])).toBe('B')
    }
  })

  it('coalesces comparison targets while retaining unrelated remote fields', () => {
    const fixture = new KernelFixture({ a: { x: 0, hidden: 0 } })
    fixture.apply([fixture.write('a', { x: 1 })]); fixture.apply([fixture.write('a', { x: 2 })])
    fixture.observe({ a: { x: 0, hidden: 4 } }, 1)
    expect(row(fixture, 'a')?.preview).toEqual({ x: 2, hidden: 4 })
    expect(row(fixture, 'a')?.issues).toEqual([])
    const change = fixture.project().changes[0]!
    expect(compileChangePatches(change)).toEqual([{ kind: 'set', path: ['x'], value: 1 }, { kind: 'set', path: ['x'], value: 2 }])
    fixture.observe({ a: { x: 2, hidden: 5 } }, 2)
    expect(fixture.state.settlements).toHaveLength(2)
    expect(row(fixture, 'a')?.persistence).toBe('clean')
    expect(row(fixture, 'a')?.preview).toEqual({ x: 2, hidden: 5 })
  })

  it('does not borrow remote hidden fields to satisfy a conservative whole-row comparison', () => {
    const fixture = new KernelFixture({ a: { x: 0, hidden: 0 } })
    fixture.apply([fixture.write('a', { x: 1 }, { comparison: 'entity' })])
    fixture.observe({ a: { x: 1, hidden: 1 } }, 1)
    expect(row(fixture, 'a')?.persistence).toBe('blocked')
    expect(fixture.state.settlements).toEqual([])
    fixture.observe({ a: { x: 1, hidden: 0 } }, 2)
    expect(fixture.state.settlements).toHaveLength(1)
  })

  it('checks a multi-field write group as one comparison domain', () => {
    const fixture = new KernelFixture({ a: { x: 0, y: 0 } })
    fixture.apply([fixture.write('a', { x: 1, y: 1 })])
    fixture.observe({ a: { x: 1, y: 0 } }, 1)
    expect(row(fixture, 'a')?.issues.map(issue => issue.code)).toContain('write-conflict')
    expect(fixture.project().changes).toEqual([])
    fixture.observe({ a: { x: 1, y: 1 } }, 2)
    expect(fixture.state.settlements).toHaveLength(1)
  })

  it('reports original base, final target and actual value with a frontier-bound conflict identity', () => {
    const fixture = new KernelFixture({ a: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 })])
    fixture.observe({ a: { x: 3 } }, 1)
    const conflict = row(fixture, 'a')!.issues[0]!
    expect(conflict.comparison).toEqual({ resources: [{ kind: 'path', entityId: entityId('a'), path: ['x'] }],
      base: [{ kind: 'value', value: 0 }], local: [{ kind: 'value', value: 1 }], remote: [{ kind: 'value', value: 3 }],
    })
    expect(row(fixture, 'a')?.issues[0]?.id).toBe(conflict.id)
    fixture.apply([fixture.write('a', { x: 2 })])
    expect(row(fixture, 'a')?.issues[0]?.id).not.toBe(conflict.id)
    expect(row(fixture, 'a')?.issues[0]?.comparison?.local).toEqual([{ kind: 'value', value: 2 }])
  })

  it('runs a business planner once and preserves changed semantic reads even when targets match', () => {
    const fixture = new KernelFixture({ a: { qty: 1, total: 10 } })
    let calls = 0
    const plan = planDocumentWrite(entityId('a'), row(fixture, 'a')!.preview!, kernelId<'write-group'>('calculation'), 20, (context, target) => {
      calls++; context.read(['qty'])
      return [{ kind: 'set', path: ['total'], value: target }]
    })
    fixture.apply([{ kind: 'write', entityId: entityId('a'), groups: [plan] }], 'row', '20')
    for (let version = 1; version <= 3; version++) fixture.observe({ a: { qty: 2, total: 20 } }, version)
    expect(calls).toBe(1)
    expect(row(fixture, 'a')?.issues.map(issue => issue.code)).toContain('semantic-read-changed')
    expect(fixture.state.settlements).toEqual([])
    expect(rawInput(fixture.state.inputs[0])).toBe('20')
  })

  it('retains the values read by a business plan when acceptance preparation happens later', () => {
    const fixture = new KernelFixture({ a: { qty: 1, total: 10 } })
    const plan = planDocumentWrite(entityId('a'), row(fixture, 'a')!.preview!, kernelId<'write-group'>('delayed-calculation'), 20, (context, target) => {
      context.read(['qty'])
      return [{ kind: 'set', path: ['total'], value: target }]
    })
    fixture.observe({ a: { qty: 2, total: 10 } }, 1)
    const prepared = fixture.prepare([{ kind: 'write', entityId: entityId('a'), groups: [plan] }], 'row', '20')
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'prepared-action', prepared }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    expect(rawInput(prepared.inputs[0])).toBe('20')
  })

  it('rejects hidden read-only writes and retains previously accepted input on permission revocation', () => {
    const fixture = new KernelFixture({ a: { x: 0, hidden: 0 } })
    fixture.dispatch({ kind: 'policy-observed', policy: { ...permissivePolicy, version: kernelId<'policy-version'>('readonly'),
      defaultEntity: { ...permissivePolicy.defaultEntity, readonlyPaths: [['hidden']] },
    } })
    const unsafe = fixture.prepare([fixture.write('a', { x: 1, hidden: 1 })])
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'prepared-action', prepared: unsafe }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    fixture.apply([fixture.write('a', { x: 1 })], 'row', 'keep me')
    fixture.dispatch({ kind: 'policy-observed', policy: { ...permissivePolicy, version: kernelId<'policy-version'>('revoked'),
      defaultEntity: { ...permissivePolicy.defaultEntity, write: false },
    } })
    expect(row(fixture, 'a')?.persistence).toBe('blocked')
    expect(rawInput(fixture.state.inputs[0])).toBe('keep me')
    fixture.dispatch({ kind: 'policy-observed', policy: { ...permissivePolicy, version: kernelId<'policy-version'>('restored') } })
    expect(row(fixture, 'a')?.persistence).toBe('pending')
  })

  it('keeps bulk input owned until every row contribution has settlement evidence', () => {
    const fixture = new KernelFixture({ a: { x: 0 }, b: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 }), fixture.write('b', { x: 2 })], 'row', 'bulk input')
    fixture.observe({ a: { x: 3 }, b: { x: 2 } }, 1)
    expect(fixture.state.settlements).toHaveLength(1)
    expect(fixture.state.inputs[0]?.disposition.kind).toBe('intents')
    expect(rawInput(fixture.state.inputs[0])).toBe('bulk input')
    fixture.observe({ a: { x: 1 }, b: { x: 2 } }, 2)
    expect(fixture.state.inputs[0]?.disposition).toMatchObject({ kind: 'settled-intents', proofs: [
      { observation: 'read:2' }, { observation: 'read:1' },
    ] })
  })

  it('propagates blocked dependencies and respects transaction atomicity across rows', () => {
    const fixture = new KernelFixture({ a: { x: 0 }, b: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 }), fixture.write('b', { x: 2 })], 'transaction')
    fixture.observe({ a: { x: 3 }, b: { x: 0 } }, 1)
    expect(row(fixture, 'b')?.issues.map(issue => issue.code)).toContain('dependency-blocked')
    expect(fixture.project().changes).toEqual([])
    const dependent = new KernelFixture({ a: { x: 0 }, b: { x: 0 } })
    dependent.apply([dependent.write('a', { x: 1 })])
    dependent.apply([dependent.write('b', { x: 2 }, { reads: [{ resource: { kind: 'path', entityId: entityId('a'), path: ['x'] }, role: 'semantic-read' }] })])
    dependent.observe({ a: { x: 3 }, b: { x: 0 } }, 1)
    expect(row(dependent, 'b')?.issues.map(issue => issue.code)).toContain('dependency-blocked')
  })

  it('cancels a never-submitted creation without needing server delete permission', () => {
    const fixture = new KernelFixture({})
    fixture.apply([{ kind: 'create', entityId: entityId('local'), document: { x: 0 } }])
    fixture.apply([fixture.write('local', { x: 1 })])
    fixture.dispatch({ kind: 'policy-observed', policy: { ...permissivePolicy, version: kernelId<'policy-version'>('revoked'), create: false,
      defaultEntity: { ...permissivePolicy.defaultEntity, delete: false },
    } })
    fixture.apply([deletion('local')])
    expect(fixture.project().changes).toEqual([])
    expect(fixture.project().rows).toEqual([])
    expect(fixture.project().neutralIntentIds).toHaveLength(3)
    expect(fixture.state.settlements).toEqual([])
    expect(fixture.state.inputs.every(input => input.disposition.kind === 'intents')).toBe(true)
  })

  it('does not grant write authority from local policy-guard edits', () => {
    const fixture = new KernelFixture({ a: { allowed: false, x: 0 } })
    fixture.apply([fixture.write('a', { allowed: true })])
    fixture.apply([fixture.write('a', { x: 1 }, { reads: [{ resource: { kind: 'path', entityId: entityId('a'), path: ['allowed'] }, role: 'policy-guard' }] })])
    // The captured guard is the authoritative false, never the locally true.
    const write = fixture.state.journal.intents.at(-1)!.operation
    if (write.kind !== 'write') throw new Error('Unexpected fixture')
    expect(write.groups[0]!.expectations.find(expected => expected.role === 'policy-guard')?.expected).toEqual({ kind: 'value', value: false })
    expect(row(fixture, 'a')?.issues).toEqual([])
  })

  it('keeps creation permission separate from permission to edit created defaults', () => {
    const fixture = new KernelFixture({})
    fixture.dispatch({ kind: 'policy-observed', policy: { ...permissivePolicy, version: kernelId<'policy-version'>('factory-only'),
      defaultEntity: { ...permissivePolicy.defaultEntity, write: false },
    } })
    fixture.apply([{ kind: 'create', entityId: entityId('local'), document: { x: 0 } }])
    const change = fixture.prepare([fixture.write('local', { x: 1 })]), before = fixture.state
    expect(fixture.dispatch({ kind: 'prepared-action', prepared: change }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    expect(row(fixture, 'local')?.preview).toEqual({ x: 0 })
  })

  it('does not bind a proposed-key collision or turn an absent edit into a create', () => {
    const fixture = new KernelFixture({ a: { x: 0 } })
    fixture.apply([{ kind: 'create', entityId: entityId('local'), proposedKey: 'a', document: { x: 2 } }])
    expect(row(fixture, 'local')?.issues.map(issue => issue.code)).toContain('create-key-collision')
    expect(row(fixture, 'a')?.preview).toEqual({ x: 0 })
    const existing = new KernelFixture({ a: { x: 0 } })
    existing.apply([existing.write('a', { x: 2 })])
    existing.observe({}, 1)
    expect(row(existing, 'a')).toMatchObject({ existence: 'remote-deleted', persistence: 'blocked', preview: null })
    expect(existing.project().changes).toEqual([])
    expect(existing.state.journal.intents[0]?.operation.kind).toBe('write')
    expect(existing.state.inputs[0]?.disposition.kind).toBe('intents')
  })

  it('rejects omitted or overlapping write domains without accepting any input', () => {
    const fixture = new KernelFixture({ a: { profile: { name: 'A' }, hidden: 0 } })
    const prepared = fixture.prepare([fixture.write('a', { hidden: 1 })])
    const intent = prepared.intents[0]!
    if (intent.operation.kind !== 'write') throw new Error('Unexpected fixture')
    const group = intent.operation.groups[0]!
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'prepared-action', prepared: { ...prepared, intents: [{ ...intent,
      operation: { ...intent.operation, groups: [{ ...group, expectations: [] }] },
    }] } }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    const overlap = fixture.prepare([{ kind: 'write', entityId: entityId('a'), groups: [{ id: kernelId<'write-group'>('overlap'), comparison: 'entity', reads: [],
      writes: [{ kind: 'set', path: ['profile'], value: { name: 'B' } }, { kind: 'set', path: ['profile', 'name'], value: 'C' }],
    }] }])
    expect(fixture.dispatch({ kind: 'prepared-action', prepared: overlap }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
  })

  it('preserves data and intent when refresh fails or stale authority arrives', () => {
    const fixture = new KernelFixture({ a: { x: 0 } })
    fixture.apply([fixture.write('a', { x: 1 })])
    fixture.observe({ a: { x: 0 } }, 2)
    const journal = fixture.state.journal
    fixture.dispatch({ kind: 'read-started', ticket: 'latest' })
    fixture.dispatch({ kind: 'read-failed', ticket: 'old', issue: { code: 'offline', message: 'Old' } })
    expect(fixture.state.authority.read.kind).toBe('loading')
    fixture.dispatch({ kind: 'read-failed', ticket: 'latest', issue: { code: 'offline', message: 'Offline' } })
    expect(fixture.state.authority.read.kind).toBe('failed')
    expect(fixture.state.journal).toBe(journal)
    expect(row(fixture, 'a')?.preview).toEqual({ x: 1 })
    const before = fixture.state
    expect(fixture.observe({ a: { x: 0 } }, 1).result.kind).toBe('ignored')
    expect(fixture.state).toBe(before)
  })

  it('does not let an old observation or policy identity acquire a different meaning', () => {
    const fixture = new KernelFixture({ a: { x: 0 } })
    fixture.observe({ a: { x: 1 } }, 1)
    const content = fixture.state.authority.content
    if (content.kind !== 'complete') throw new Error('Unexpected fixture')
    const before = fixture.state
    expect(fixture.dispatch({ kind: 'authority-observed', snapshot: { ...content.snapshot,
      observation: kernelId<'observation'>('read:0'), version: { kind: 'ordered', token: 'version:2', position: '2' },
    } }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(before)
    fixture.dispatch({ kind: 'policy-observed', policy: { ...permissivePolicy, version: kernelId<'policy-version'>('revoked'), create: false } })
    const revoked = fixture.state
    expect(fixture.dispatch({ kind: 'policy-observed', policy: { ...permissivePolicy, create: false } }).result.kind).toBe('rejected')
    expect(fixture.state).toBe(revoked)
  })
})

describe('independent scalar model comparison', () => {
  it('matches the scalar specification for every remote value in a small coalesced chain', () => {
    for (const first of [0, 1, 2]) for (const second of [0, 1, 2]) for (const remote of [0, 1, 2, 3]) {
      const fixture = new KernelFixture({ a: { x: 0, hidden: 0 } })
      const reference = new ReferenceEditor({ a: { x: 0, hidden: 0 } })
      fixture.apply([fixture.write('a', { x: first })]); reference.write('a', { x: first }); reference.observe(reference.authority, reference.version)
      fixture.apply([fixture.write('a', { x: second })]); reference.write('a', { x: second }); reference.observe(reference.authority, reference.version)
      const remoteRows: Record<string, Document> = { a: { x: remote, hidden: 5 } }
      fixture.observe(remoteRows, 1); reference.observe({ a: { x: remote, hidden: 5 } }, 1)
      const trace = `0 -> ${first} -> ${second}, remote ${remote}`
      expect(row(fixture, 'a')?.preview, trace).toEqual(reference.preview().a)
      expect(row(fixture, 'a')?.persistence === 'blocked', trace).toBe(reference.blockedEntities().includes('a'))
      expect(fixture.project().changes.map(change => change.after), trace)
        .toEqual(reference.requirements.some(item => item.state === 'pending' && !reference.neutralIds().has(item.id)) && !reference.blockedEntities().length ? [reference.preview().a] : [])
    }
  })
})
