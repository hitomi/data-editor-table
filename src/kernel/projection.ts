import { compileSharedStateBases } from './shared-state-bases.js'
import { expandFrontier } from './frontier-table.js'
import { evaluatePrefixes, type PrefixComputation } from './prefix-evaluation.js'
import { createResourceSuffix } from './resource-suffix.js'
import { applyDocumentPatches, encodedValuesEqual, isDocument, ownEncodedValue, pathsOverlap, readDocument, resourceValuesEqual } from './document.js'
import type {
  Document, EntityId, ExpectedResource, InputRef, IntentId, IntentRecord, IntentSettlement, KernelIssue,
  Patch, ResourceRef, ResourceValue, StoragePath,
} from './model.js'
import { serverKeyIdentity } from './protocol.js'
import { rowOperationForIntent } from './intent.js'
import { operationResource, pathContains, resourceAtDocument, resourceAtRows, type RowOperation } from './resources.js'
import { policyForEntity, type KernelState } from './state.js'
import { assertKernelSchema, type KernelSchema } from './schema.js'
import { planOrder, projectOrder, type OrderChange, type OrderProjection } from './order.js'

export type ComparisonDetail = Readonly<{
  resources: readonly ResourceRef[]
  base: readonly ResourceValue[]
  local: readonly ResourceValue[]
  remote: readonly ResourceValue[]
}>
export type ProjectedIssue = KernelIssue & Readonly<{ id: string; comparison?: ComparisonDetail }>
export type RowProjection = Readonly<{
  entityId: EntityId
  authority: Document | null
  preview: Document | null
  existence: 'present' | 'local-create' | 'pending-delete' | 'remote-deleted'
  persistence: 'clean' | 'pending' | 'submitted' | 'blocked'
  intentIds: readonly IntentId[]
  retainedInputs: readonly InputRef[]
  issues: readonly ProjectedIssue[]
}>
export type RowChange = Readonly<{
  entityId: EntityId
  kind: 'create' | 'update' | 'delete'
  before: Document | null
  after: Document | null
  intentIds: readonly IntentId[]
  operations: readonly RowOperation[]
}>
export type KernelProjection = Readonly<{
  rows: readonly RowProjection[]
  changes: readonly RowChange[]
  neutralIntentIds: readonly IntentId[]
  order: OrderProjection
  orderChange: OrderChange | null
  /** Evidence suggestions only. A fact transition, never this selector,
   * owns insertion into the settlement and input ledgers. */
  suggestedSettlements: readonly IntentSettlement[]
}>

type RowIntent = IntentRecord & Readonly<{ operation: RowOperation }>
type Step = { intent: RowIntent; operation: RowOperation; intentStart: number }
type Check = { step: number; intent: RowIntent; expectations: readonly ExpectedResource[]; actual: readonly ResourceValue[] }
type WorkingRow = {
  entityId: EntityId; authority: Document | null; preview: Document | null
  intents: RowIntent[]; issues: Omit<ProjectedIssue, 'id'>[]; reserved: boolean
}

export function reservedIntentIds(state: KernelState): ReadonlySet<IntentId> {
  return new Set('submission' in state.persistence ? state.persistence.submission.coverage.flatMap(entry => entry.intentIds) : [])
}

function activeRowIntents(state: KernelState, through: number): RowIntent[] {
  const settled = new Set(state.settlements.map(entry => entry.intentId))
  return state.journal.intents.flatMap(intent => {
    if (intent.sequence > through || settled.has(intent.id)) return []
    const operation = rowOperationForIntent(state, intent)
    return operation ? [{ ...intent, operation }] : []
  })
}

/** One index per immutable projection input, shared by every causal prefix.
 * No cache survives an authority, policy, settlement or journal transition. */
type ProjectionFacts = () => ReturnType<typeof compileSharedStateBases>
function resolvedExpectation(facts: ProjectionFacts, expected: ExpectedResource, localPrefix: Iterable<RowOperation>): ResourceValue {
  if (expected.role !== 'write-base' || expected.anchor.kind === 'authority' || expected.resource.kind === 'order') return expected.expected
  return facts()(expected, localPrefix)
}

/** Groups of one intent are contiguous in the step plan. Iterate only that
 * intent's earlier groups, and only when canonical-base resolution needs them. */
function* localOperations(steps: readonly Step[], end: number): Iterable<RowOperation> {
  for (let index = steps[end]!.intentStart; index < end; index++) yield steps[index]!.operation
}

function issue(row: WorkingRow, code: string, intentIds: readonly IntentId[], message: string, comparison?: ComparisonDetail) {
  row.issues.push({ code, entityId: row.entityId, intentIds, message, ...(comparison ? { comparison } : {}) })
}

/** Net-zero prefixes remain owned history, but no longer require a write.
 * Compare captured/resolved authoring domains rather than the latest row, so
 * an unrelated refresh cannot revive a cancelled local requirement. */
function createNeutralPrefix(state: KernelState, facts: ProjectionFacts) {
  type Root = { expected: ExpectedResource; base: ResourceValue | null; target: ResourceValue | null }
  const steps: { intent: RowIntent; operation: RowOperation; localPrefix: readonly RowOperation[] }[] = []
  let roots: Root[] = [], first: RowOperation | null = null, structural = false
  const domain = (resource: ResourceRef): readonly string[] => resource.kind === 'entity' ? [] : resource.kind === 'path' ? resource.path : ['order']
  const covers = (a: ResourceRef, b: ResourceRef) => a.kind !== 'order' && b.kind !== 'order' && a.entityId === b.entityId && pathContains(domain(a), domain(b))
  const baseAt = (expected: ExpectedResource, index: number) => resolvedExpectation(facts, expected, steps[index]!.localPrefix)
  const rootAt = (expected: ExpectedResource, position: number): Root => {
    const root: Root = { expected, base: null, target: null }, resource = expected.resource
    if (resource.kind === 'order') return root
    try {
      let base = baseAt(expected, position)
      // A newly broadened domain contains earlier narrow writes. Reconstruct
      // its original authoring base once, when it replaces narrower roots.
      for (let index = position - 1; index >= 0; index--) {
        const operation = steps[index]!.operation
        if (operation.kind === 'replace') {
          const before = baseAt(operation.expected, index)
          if (before.kind !== 'value' || !isDocument(before.value)) return root
          base = operationResource(resource, base, { ...operation, document: before.value })
        } else if (operation.kind === 'write') {
          const group = operation.groups[0]!
          const inverse = group.writes.map(patch => {
            const expected = group.expectations.find(expected => expected.role === 'write-base' && covers(expected.resource, { kind: 'path', entityId: operation.entityId, path: patch.path }))!
            const value = baseAt(expected, index)
            const relative = patch.path.slice(domain(expected.resource).length)
            const before = relative.length && value.kind === 'value' && isDocument(value.value) ? readDocument(value.value, relative as unknown as StoragePath) : value
            return before.kind === 'missing' ? { kind: 'remove' as const, path: patch.path } : { kind: 'set' as const, path: patch.path, value: before.value }
          })
          base = operationResource(resource, base, { ...operation, groups: [{ ...group, writes: inverse }] })
        }
      }
      let target = base
      for (const step of steps) target = operationResource(resource, target, step.operation)
      root.base = base; root.target = target
    } catch { /* Incomplete domains retain their requirements. */ }
    return root
  }
  return (intent: RowIntent): boolean => {
    first ??= intent.operation
    if (first?.kind === 'create') return intent.operation.kind === 'delete'
    structural ||= intent.operation.kind === 'create' || intent.operation.kind === 'delete'
    if (structural) return false
    const operations: RowOperation[] = intent.operation.kind === 'write'
      ? intent.operation.groups.map(group => ({ ...intent.operation, groups: [group] })) : [intent.operation]
    const local: RowOperation[] = []
    for (const operation of operations) {
      const position = steps.length
      steps.push({ intent, operation, localPrefix: [...local] }); local.push(operation)
      for (const root of roots) {
        if (root.target === null || root.expected.resource.kind === 'order') continue
        try { root.target = operationResource(root.expected.resource, root.target, operation) }
        catch { root.target = null }
      }
      const expectations = operation.kind === 'write' ? operation.groups[0]!.expectations
        : operation.kind === 'replace' ? [operation.expected] : []
      for (const expected of expectations) {
        if (expected.role !== 'write-base' || roots.some(root => covers(root.expected.resource, expected.resource))) continue
        roots = roots.filter(root => !covers(expected.resource, root.expected.resource))
        roots.push(rootAt(expected, position))
      }
    }
    return roots.length > 0 && roots.every(root => root.base !== null && root.target !== null && resourceValuesEqual(root.base, root.target))
  }
}

function effectiveRowIntents(state: KernelState, facts: ProjectionFacts, active: readonly RowIntent[], reserved: ReadonlySet<IntentId>) {
  const rows = new Map<EntityId, RowIntent[]>(), neutral = new Set<IntentId>()
  const restored = new Set(state.journal.intents.filter(intent => intent.operation.kind === 'restore-resolution-row').map(intent => intent.id))
  for (const intent of active) { const row = rows.get(intent.operation.entityId) ?? []; row.push(intent); rows.set(intent.operation.entityId, row) }
  for (const row of rows.values()) {
    if (row.some(intent => reserved.has(intent.id))) continue
    let prefix: RowIntent[] = [], append = createNeutralPrefix(state, facts), requiresReview = false
    for (let index = 0; index < row.length; index++) {
      const intent = row[index]!
      prefix.push(intent); requiresReview ||= restored.has(intent.id)
      const isNeutral = append(intent)
      if (row[index + 1]?.applicationId === intent.applicationId) continue
      if (isNeutral && !requiresReview) { prefix.forEach(intent => neutral.add(intent.id)); prefix = []; append = createNeutralPrefix(state, facts) }
    }
  }
  return { active: active.filter(intent => !neutral.has(intent.id)), neutral: Object.freeze([...neutral]) }
}

/** Projection reads owned facts and fixed pure schema rules, never invokes setters/codecs,
 * and never reconstructs intent from visible row differences. */
export function projectKernel(state: KernelState, schema: KernelSchema): KernelProjection {
  assertKernelSchema(state.workspace, schema)
  let indexed: ReturnType<typeof compileSharedStateBases> | undefined
  const facts = () => indexed ??= compileSharedStateBases(state)
  return evaluatePrefixes(through => projectThrough(state, schema, facts, through))
}

/** A historical read can still consume an intermediate local result after its
 * provider becomes neutral. Evaluate that earlier causal prefix using current
 * authority and exact facts, without publishing or submitting the prefix.
 * Reads suspend at a strictly earlier sequence; the evaluator shares a cache
 * and resumes each local calculation without nesting the JavaScript stack. */
function* projectThrough(state: KernelState, schema: KernelSchema, facts: ProjectionFacts, through: number): PrefixComputation {
  if (state.authority.content.kind !== 'complete') return Object.freeze({ rows: Object.freeze([]), changes: Object.freeze([]), neutralIntentIds: Object.freeze([]), suggestedSettlements: Object.freeze([]),
    order: projectOrder(state, [], [], []).order, orderChange: null })
  const authority = state.authority.content.snapshot
  const reserved = reservedIntentIds(state), effective = effectiveRowIntents(state, facts, activeRowIntents(state, through), reserved), active = effective.active
  const orderPlan = planOrder(state, effective.neutral, through)
  const neutral = new Set([...effective.neutral, ...orderPlan.neutral])
  const virtual = new Map(authority.entities.map(row => [row.entityId, row.document] as const))
  const authoritative = new Map(virtual)
  const rows = new Map<EntityId, WorkingRow>()
  for (const id of authority.order) {
    const document = virtual.get(id)!
    rows.set(id, { entityId: id, authority: document, preview: document, intents: [], issues: [], reserved: false })
  }
  const steps: Step[] = []
  for (const intent of active) {
    const entityId = intent.operation.entityId
    let row = rows.get(entityId)
    if (!row) {
      row = { entityId, authority: null, preview: null, intents: [], issues: [], reserved: false }
      rows.set(entityId, row)
    }
    row.intents.push(intent); row.reserved ||= reserved.has(intent.id)
    const intentStart = steps.length
    if (intent.operation.kind === 'write') {
      for (const group of intent.operation.groups) steps.push({ intent, intentStart, operation: { ...intent.operation, groups: [group] } })
    } else steps.push({ intent, intentStart, operation: intent.operation })
  }
  // Existence requirements can terminate without materializing superseded
  // field operations. No display row participates in either proof.
  const terminal = new Map<EntityId, 'cancelled' | 'absent'>()
  for (const row of rows.values()) if (row.intents.at(-1)?.operation.kind === 'delete' && !row.reserved) {
    if (row.intents[0]?.operation.kind === 'create') terminal.set(row.entityId, 'cancelled')
    else if (row.authority === null) terminal.set(row.entityId, 'absent')
  }
  const checks: Check[] = []
  for (let index = 0; index < steps.length; index++) {
    const { intent, operation } = steps[index]!, row = rows.get(operation.entityId)!
    if (terminal.has(row.entityId)) { virtual.delete(row.entityId); continue }
    const before = virtual.get(row.entityId) ?? null
    const expectations = operation.kind === 'write' ? operation.groups[0]!.expectations
      : operation.kind === 'replace' || operation.kind === 'delete' ? [operation.expected] : []
    checks.push({ step: index, intent, expectations, actual: expectations.map(expected => resourceAtRows(expected.role === 'policy-guard' ? authoritative : virtual, expected.resource, expected.role === 'policy-guard' ? authority.order : orderPlan.before.get(intent.id)!)) })
    try {
      if (operation.kind === 'create') {
        if (before !== null || (operation.proposedKey !== undefined && authority.entities.some(entity => serverKeyIdentity(entity.identity.key) === serverKeyIdentity(operation.proposedKey!))))
          issue(row, 'create-key-collision', [intent.id], 'The proposed creation is already occupied; its identity remains separate.')
        virtual.set(row.entityId, operation.document)
      } else if (operation.kind === 'delete') {
        virtual.delete(row.entityId)
      } else {
        if (before === null) {
          issue(row, 'target-deleted', [intent.id], 'The target incarnation no longer exists. The input is retained for explicit recovery.')
          continue
        }
        virtual.set(row.entityId, operation.kind === 'replace' ? operation.document : applyDocumentPatches(before, operation.groups[0]!.writes))
      }
    } catch (error) {
      issue(row, 'materialization-blocked', [intent.id], error instanceof Error ? error.message : 'The declared write cannot be materialized.')
    }
  }
  const suffixTarget = createResourceSuffix(steps.map(step => step.operation))
  for (const check of checks) {
    const row = rows.get(check.intent.operation.entityId)!
    let sameBase = true, sameTarget = true, hasWriteBase = false
    const resources: ResourceRef[] = [], bases: ResourceValue[] = [], targets: ResourceValue[] = [], actuals: ResourceValue[] = []
    try {
      for (let index = 0; index < check.expectations.length; index++) {
        const expected = check.expectations[index]!
        let actual = check.actual[index]!
        const base = resolvedExpectation(facts, expected, localOperations(steps, check.step))
        if (expected.role !== 'write-base') {
          const predecessors = expected.anchor.kind === 'authority' ? [] : expandFrontier(state.journal.frontiers, expected.anchor.kind === 'logical-output' ? expected.anchor.predecessor : expected.anchor.frontier)
          if (expected.role === 'semantic-read' && predecessors.some(id => neutral.has(id))) {
            const prefix = yield check.intent.sequence - 1
            actual = resourceAtRows(prefix.documents, expected.resource, prefix.order)
            const prerequisite = expected.resource.kind === 'order' ? prefix.projection.order.issues : prefix.rows.get(expected.resource.entityId)?.issues
            if (prerequisite?.length) issue(row, 'dependency-blocked', [check.intent.id], 'The intermediate result consumed by this input no longer has valid causal prerequisites.')
          }
          if (!resourceValuesEqual(actual, base)) issue(row, expected.role === 'semantic-read' ? 'semantic-read-changed' : 'policy-guard-changed', [check.intent.id], 'A dependency of the original input changed; the original requirement is retained.', {
            resources: [expected.resource], base: [base], local: [base], remote: [actual],
          })
          continue
        }
        hasWriteBase = true
        if (expected.resource.kind === 'order') throw new Error('A row write cannot use the order as its write base.')
        const target = suffixTarget(expected.resource, check.step, base)
        resources.push(expected.resource); bases.push(base); targets.push(target); actuals.push(actual)
        sameBase &&= resourceValuesEqual(actual, base)
        sameTarget &&= resourceValuesEqual(actual, target)
      }
      if (hasWriteBase && !sameBase && !sameTarget) issue(row, 'write-conflict', [check.intent.id], 'The authority differs from both the authored base and the complete intended target.', {
        resources, base: bases, local: targets, remote: actuals,
      })
    } catch (error) {
      issue(row, 'materialization-blocked', [check.intent.id], error instanceof Error ? error.message : 'The comparison domain cannot be materialized.')
    }
  }
  for (const row of rows.values()) {
    row.preview = virtual.get(row.entityId) ?? null
    if (!row.intents.length || terminal.has(row.entityId)) continue
    const policy = policyForEntity(state.policy, row.entityId), ids = row.intents.map(intent => intent.id)
    const creating = row.intents[0]!.operation.kind === 'create', deleting = row.intents.at(-1)!.operation.kind === 'delete'
    const replacing = row.intents.some(intent => intent.operation.kind === 'replace')
    const writing = row.intents.some(intent => intent.operation.kind === 'write')
    const restoration = row.intents.find(intent => intent.operation.kind === 'create' && intent.operation.restoresEntity !== undefined)?.operation
    if (restoration?.kind === 'create' && restoration.restoresEntity !== undefined
      && (!state.sourceCapabilities.restoreDeleted || !policyForEntity(state.policy, restoration.restoresEntity).replace))
      issue(row, 'policy-blocked', ids, 'Restoration still requires source support and permission to replace the deleted entity.')
    if ((creating && !state.policy.create) || (!creating && deleting && !policy.delete)
      || (!deleting && replacing && !policy.replace) || (!deleting && writing && !policy.write))
      issue(row, 'policy-blocked', ids, 'Current policy no longer permits this mutation. Its input is retained.')
    if (!deleting) {
      const readonlyPaths = [...policy.readonlyPaths, ...schema.fields.filter(field => field.readonly).map(field => field.path)]
      const readonlyWrite = row.intents.some(intent => intent.operation.kind === 'write' && intent.operation.groups.some(group => group.writes.some(patch => readonlyPaths.some(path => pathsOverlap(path, patch.path)))))
      const readonlyReplace = replacing && readonlyPaths.some(path => !resourceValuesEqual(
        resourceAtDocument(row.authority, { kind: 'path', entityId: row.entityId, path }),
        resourceAtDocument(row.preview, { kind: 'path', entityId: row.entityId, path }),
      ))
      if (readonlyWrite || readonlyReplace) issue(row, 'readonly-write', ids, 'The complete write set touches a read-only storage domain.')
      // Prefixes are intermediate evaluation states, not commit candidates.
      // Complete-document constraints apply to the final assembled candidate.
      if (row.preview && through === Infinity) {
        try {
          const validation = ownEncodedValue(schema.validate(row.preview, Object.freeze({ entityId: row.entityId, mutation: creating ? 'create' : 'update' }))) as unknown as readonly KernelIssue[]
          if (!Array.isArray(validation) || validation.some(invalid => !invalid || typeof invalid.code !== 'string' || !invalid.code || typeof invalid.message !== 'string'))
            throw new Error('A schema validator must return a list of structured issues.')
          for (const invalid of validation) row.issues.push({ ...invalid, code: 'schema-invalid', entityId: row.entityId, intentIds: ids })
        } catch (error) {
          issue(row, 'schema-validation-failed', ids, error instanceof Error ? error.message : 'The complete candidate could not be validated.')
        }
      }
    }
  }
  // Dependency and transaction closure is conservative and finite. A blocked
  // row cannot be bypassed by saving another part of an atomic action.
  const owner = new Map(active.map(intent => [intent.id, rows.get(intent.operation.entityId)!] as const))
  let changed = [...rows.values()].some(row => row.issues.length > 0)
  while (changed) {
    changed = false
    for (const row of rows.values()) {
      if (row.issues.length || terminal.has(row.entityId)) continue
      const dependencyBlocked = row.intents.some(intent => expandFrontier(state.journal.frontiers, intent.dependencies).some(id => owner.get(id)?.issues.length))
      const transactionBlocked = state.journal.actions.some(action => action.saveAtomicity === 'transaction'
        && row.intents.some(intent => intent.applicationId === action.applicationId)
        && action.intentIds.some(id => owner.get(id)?.issues.length))
      if (dependencyBlocked || transactionBlocked) {
        issue(row, 'dependency-blocked', row.intents.map(intent => intent.id), 'A required intent or another part of this atomic action is blocked.')
        changed = true
      }
    }
  }
  const projected: RowProjection[] = [], changes: RowChange[] = [], suggestions: IntentSettlement[] = []
  for (const row of rows.values()) {
    const ids = row.intents.map(intent => intent.id), first = row.intents[0], last = row.intents.at(-1)
    const terminalKind = terminal.get(row.entityId)
    const equal = row.authority === null ? row.preview === null : row.preview !== null && encodedValuesEqual(row.authority, row.preview)
    if (first && !row.reserved && !row.issues.length && (terminalKind || (equal && first.operation.kind !== 'create'))) {
      for (const intent of row.intents) suggestions.push({ kind: 'externally-satisfied', intentId: intent.id, observation: authority.observation })
    } else if (first && !row.issues.length && !row.reserved) changes.push({
      entityId: row.entityId, kind: first.operation.kind === 'create' ? 'create' : last!.operation.kind === 'delete' ? 'delete' : 'update',
      before: row.authority, after: row.preview, intentIds: ids, operations: row.intents.map(intent => intent.operation),
    })
    const deleting = last?.operation.kind === 'delete'
    projected.push({
      entityId: row.entityId, authority: row.authority,
      preview: deleting && row.issues.length ? row.authority : row.preview,
      existence: first?.operation.kind === 'create' ? 'local-create' : deleting ? 'pending-delete' : row.authority === null ? 'remote-deleted' : 'present',
      persistence: row.issues.length ? 'blocked' : row.reserved ? 'submitted' : ids.length ? 'pending' : 'clean',
      intentIds: ids, retainedInputs: row.intents.flatMap(intent => intent.inputs), issues: row.issues.map((issue, index) => ({ ...issue,
        id: JSON.stringify([state.workspace.scope, authority.observation, state.policy.version, row.entityId, ids, issue.code, index]),
      })),
    })
  }
  const order = projectOrder(state, projected, changes, effective.neutral, orderPlan)
  const settledEligible = new Set(order.rows.flatMap(row => row.issues.length ? [] : row.intentIds))
  return ownEncodedValue({ rows: order.rows, changes: order.changes, order: order.order, orderChange: order.change,
    neutralIntentIds: [...effective.neutral, ...order.neutral], suggestedSettlements: [...suggestions.filter(proof => settledEligible.has(proof.intentId)), ...order.suggestions] }) as unknown as KernelProjection
}

/** Compile the transport write set from already-declared operations. Row
 * comparison is used only to express an explicit replacement's full writes. */
export function compileChangePatches(change: RowChange): readonly Patch[] {
  if (change.kind !== 'update' || !change.before) throw new Error('Only existing-row updates have patch transport.')
  let current = change.before
  const patches: Patch[] = []
  for (const operation of change.operations) {
    if (operation.kind === 'write') {
      for (const group of operation.groups) { patches.push(...group.writes); current = applyDocumentPatches(current, group.writes) }
    } else if (operation.kind === 'replace') {
      for (const key of new Set([...Object.keys(current), ...Object.keys(operation.document)])) {
        if (!Object.hasOwn(operation.document, key)) patches.push({ kind: 'remove', path: [key] })
        else if (!Object.hasOwn(current, key) || !encodedValuesEqual(current[key]!, operation.document[key]!)) patches.push({ kind: 'set', path: [key], value: operation.document[key]! })
      }
      current = operation.document
    } else throw new Error('An update cannot contain a creation or deletion.')
  }
  return Object.freeze(patches)
}
