import { kernelId, type Document, type EncodedValue, type PreparedAction, type ServerIdentity } from '../../src/kernel/model.js'
import { prepareRowAction, type RowCommand, type WritePlan } from '../../src/kernel/prepare.js'
import { createKernelState, type PolicySnapshot } from '../../src/kernel/state.js'
import { reduceKernel, type KernelEvent } from '../../src/kernel/transition.js'
import { projectKernel } from '../../src/kernel/projection.js'
import { defineKernelSchema, type KernelSchema } from '../../src/kernel/schema.js'
import { prepareSubmission } from '../../src/kernel/submission.js'
import { resourceAtRows } from '../../src/kernel/resources.js'

export const entityId = (value: string) => kernelId<'entity'>(value)
export const permissivePolicy: PolicySnapshot = {
  version: kernelId<'policy-version'>('policy:0'), create: true, order: true,
  defaultEntity: { write: true, replace: true, delete: true, readonlyPaths: [] }, entities: [],
}
export const permissiveSchema = defineKernelSchema({ version: kernelId<'schema-version'>('schema'), codec: kernelId<'codec-version'>('codec'), fields: [], validate: () => [] })

export class KernelFixture {
  state = createKernelState({ id: kernelId<'workspace'>('workspace'), scope: { sourceId: 'fixture-source', id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') },
    schema: kernelId<'schema-version'>('schema'), codec: kernelId<'codec-version'>('codec') }, permissivePolicy)
  private counter = 0
  constructor(rows?: Readonly<Record<string, Document>>, readonly schema: KernelSchema = permissiveSchema, capabilities: Readonly<{ restoreDeleted: boolean }> = { restoreDeleted: false }) {
    this.state = createKernelState(this.state.workspace, this.state.policy, capabilities)
    if (rows) this.observe(rows, 0)
  }
  project() { return projectKernel(this.state, this.schema) }
  next() { return ++this.counter }
  dispatch(event: KernelEvent) {
    const transition = reduceKernel(this.state, event, this.schema)
    this.state = transition.state
    return transition
  }
  observe(rows: Readonly<Record<string, Document>>, version: number, identities: Readonly<Record<string, ServerIdentity>> = {}) {
    const transition = this.dispatch({ kind: 'authority-observed', snapshot: {
      scope: this.state.workspace.scope, observation: kernelId<'observation'>(`read:${version}`),
      version: { kind: 'ordered', token: `version:${version}`, position: String(version) },
      entities: Object.entries(rows).map(([id, document]) => ({ entityId: entityId(id), identity: identities[id] ?? { key: id, incarnation: 'life:1' }, document })),
      order: Object.keys(rows).map(entityId),
    } })
    if (transition.result.kind === 'rejected') throw new Error(transition.result.issue.message)
    return transition
  }
  write(entity: string, values: Readonly<Record<string, EncodedValue>>, options: Readonly<{ comparison?: WritePlan['comparison']; reads?: readonly Omit<WritePlan['reads'][number], 'expected'>[] }> = {}): RowCommand {
    const authority = this.state.authority.content.kind === 'complete' ? this.state.authority.content.snapshot : null
    const actual = new Map(authority?.entities.map(row => [row.entityId, row.document] as const) ?? [])
    const preview = new Map(this.project().rows.flatMap(row => row.preview ? [[row.entityId, row.preview] as const] : []))
    return { kind: 'write', entityId: entityId(entity), groups: [{ id: kernelId<'write-group'>(`group:${this.next()}`),
      writes: Object.entries(values).map(([key, value]) => ({ kind: 'set', path: [key], value })),
      comparison: options.comparison ?? 'paths', reads: (options.reads ?? []).map(read => ({ ...read, expected: resourceAtRows(read.role === 'policy-guard' ? actual : preview, read.resource, authority?.order ?? []) })),
    }] }
  }
  prepare(commands: readonly RowCommand[], atomicity: 'row' | 'transaction' = 'row', input: EncodedValue = 'original input'): PreparedAction {
    const id = this.next(), ref = { id: kernelId<'input'>(`input:${id}`), version: 0 }
    return prepareRowAction(this.state, {
      action: { id: kernelId<'action'>(`action:${id}`), applicationId: kernelId<'application'>(`application:${id}`), label: 'Edit', saveAtomicity: atomicity },
      commands: commands.map((command, index) => ({ id: kernelId<'intent'>(`intent:${id}:${index}`), command, inputs: [ref], dependencies: [] })),
      inputs: [{ ref, input: { kind: 'encoded', value: input } }], cause: 'user',
    }, this.schema)
  }
  apply(commands: readonly RowCommand[], atomicity: 'row' | 'transaction' = 'row', input?: EncodedValue) {
    const prepared = this.prepare(commands, atomicity, input)
    const result = this.dispatch({ kind: 'prepared-action', prepared })
    if (result.result.kind !== 'accepted') throw new Error(result.result.kind === 'ignored' ? result.result.reason : result.result.issue.message)
    return prepared
  }
  prepareSave() {
    const id = this.next()
    return prepareSubmission(this.state, { operationId: kernelId<'operation'>(`operation:${id}`), payloadHash: kernelId<'payload-hash'>(`test-hash:${id}`),
      items: this.project().changes.map(change => ({ entityId: change.entityId, itemId: kernelId<'item'>(`item:${id}:${change.entityId}`) })),
      ...(this.project().orderChange ? { orderItemId: kernelId<'item'>(`item:${id}:order`) } : {}),
    }, this.schema)
  }
  freeze() {
    const prepared = this.prepareSave(), transition = this.dispatch({ kind: 'freeze-submission', prepared })
    if (transition.result.kind !== 'accepted') throw new Error('Fixture could not freeze a save')
    return { ...transition, submission: prepared.submission }
  }
}
