import { canonicalEncodedValue, encodedValuesEqual, ownEncodedValue, readDocument } from './document.js'
import type { Document, ResourceValue, ViewFilter, ViewPredicate, ViewQuery, ViewSort } from './model.js'
import { projectKernel, type KernelProjection } from './projection.js'
import type { KernelSchema } from './schema.js'
import type { KernelState } from './state.js'

export type ViewEvent = Readonly<{ kind: 'view-query-set'; expectedVersion: number; filters: readonly ViewFilter[]; sort: readonly ViewSort[] }>

function validatePredicate(predicate: ViewPredicate, schema: KernelSchema): void {
  switch (predicate.kind) {
    case 'all': case 'any': predicate.predicates.forEach(child => validatePredicate(child, schema)); return
    case 'not': validatePredicate(predicate.predicate, schema); return
    case 'missing': case 'compare':
      if (!schema.fields.some(field => field.id === predicate.fieldId)) throw new Error('A view predicate requires a known storage field.')
      if (predicate.kind === 'missing') return
      if (!['equals', 'contains', 'less-than', 'greater-than'].includes(predicate.operator) || !('value' in predicate)) throw new Error('Unknown view comparison.')
      if (predicate.operator === 'contains' && typeof predicate.value !== 'string') throw new Error('Text containment requires a string.')
      if ((predicate.operator === 'less-than' || predicate.operator === 'greater-than') && typeof predicate.value !== 'number' && typeof predicate.value !== 'string')
        throw new Error('Ordered comparisons require a number or string.')
      return
    default: throw new Error('Unknown view predicate.')
  }
}

/** Append the exact query version before any input can cite it as its terminal
 * destination. Query history is recovery evidence, separate from data undo. */
export function setViewQuery(state: KernelState, raw: ViewEvent, schema: KernelSchema): KernelState {
  const event = ownEncodedValue(raw) as unknown as ViewEvent
  if (event.expectedVersion !== state.view.version || !Number.isSafeInteger(state.view.version + 1)) throw new Error('The view query changed; prepare against its current version.')
  const columns = new Set<string>(), fields = new Set<string>()
  for (const filter of event.filters) {
    if (!filter.columnId || columns.has(filter.columnId)) throw new Error('View filters require unique column identities.')
    columns.add(filter.columnId); validatePredicate(filter.predicate, schema)
  }
  for (const sort of event.sort) {
    if (!schema.fields.some(field => field.id === sort.fieldId) || fields.has(sort.fieldId) || !['asc', 'desc'].includes(sort.direction)) throw new Error('View sort requires unique known fields and explicit directions.')
    fields.add(sort.fieldId)
  }
  const view: ViewQuery = Object.freeze({ version: state.view.version + 1, filters: event.filters, sort: event.sort })
  return Object.freeze({ ...state, view, viewHistory: Object.freeze([...state.viewHistory, view]) })
}

function matches(document: Document, predicate: ViewPredicate, schema: KernelSchema): boolean {
  switch (predicate.kind) {
    case 'all': return predicate.predicates.every(child => matches(document, child, schema))
    case 'any': return predicate.predicates.some(child => matches(document, child, schema))
    case 'not': return !matches(document, predicate.predicate, schema)
    case 'missing': return readDocument(document, schema.fields.find(field => field.id === predicate.fieldId)!.path).kind === 'missing'
    case 'compare': {
      const resource = readDocument(document, schema.fields.find(field => field.id === predicate.fieldId)!.path)
      if (resource.kind === 'missing') return false
      const value = resource.value, expected = predicate.value
      if (predicate.operator === 'equals') return encodedValuesEqual(value, expected)
      if (predicate.operator === 'contains') return typeof value === 'string' && value.includes(expected as string)
      if (typeof value !== typeof expected || (typeof value !== 'number' && typeof value !== 'string')) return false
      if (typeof value === 'number' && typeof expected === 'number') return predicate.operator === 'less-than' ? value < expected : value > expected
      if (typeof value === 'string' && typeof expected === 'string') return predicate.operator === 'less-than' ? value < expected : value > expected
      return false
    }
  }
}

/** A deterministic total display order: missing, null, boolean, number, text,
 * then compound encoded values. Equal keys retain the persistent row order. */
function compare(left: ResourceValue, right: ResourceValue): number {
  const rank = (resource: ResourceValue) => resource.kind === 'missing' ? 0 : resource.value === null ? 1
    : typeof resource.value === 'boolean' ? 2 : typeof resource.value === 'number' ? 3 : typeof resource.value === 'string' ? 4 : 5
  const difference = rank(left) - rank(right)
  if (difference) return difference
  if (left.kind === 'missing' || right.kind === 'missing' || encodedValuesEqual(left.value, right.value)) return 0
  if (typeof left.value === 'number' && typeof right.value === 'number') return left.value < right.value ? -1 : 1
  if (typeof left.value === 'string' && typeof right.value === 'string') return left.value < right.value ? -1 : 1
  return canonicalEncodedValue(left.value) < canonicalEncodedValue(right.value) ? -1 : 1
}

/** Display selection cannot remove data, history, pending writes or recovery
 * from the kernel projection. Consumers retain both complete and visible rows. */
export function projectView(state: KernelState, schema: KernelSchema, projection: KernelProjection = projectKernel(state, schema)) {
  const rows = new Map(projection.rows.map(row => [row.entityId, row] as const))
  const visible = projection.order.preview.flatMap(id => {
    const row = rows.get(id)
    return row?.preview && row.existence !== 'pending-delete' && state.view.filters.every(filter => matches(row.preview!, filter.predicate, schema)) ? [row] : []
  })
  const sorts = state.view.sort.map(sort => ({ ...sort, path: schema.fields.find(field => field.id === sort.fieldId)!.path }))
  visible.sort((left, right) => {
    for (const sort of sorts) {
      const comparison = compare(readDocument(left.preview!, sort.path), readDocument(right.preview!, sort.path))
      if (comparison) return sort.direction === 'asc' ? comparison : -comparison
    }
    return 0
  })
  return Object.freeze({ query: state.view, rows: Object.freeze(visible), total: projection.rows.filter(row => row.preview && row.existence !== 'pending-delete').length })
}

/** A host-owned partition of one Workspace, applied after the shared query.
 * It changes presentation only; all authority, intents and recovery stay in the
 * same owner. Empty-partition counts exclude unrelated partitions. */
export function scopeView(view: ReturnType<typeof projectView>, projection: KernelProjection, schema: KernelSchema, raw: ViewPredicate) {
  const predicate = ownEncodedValue(raw) as unknown as ViewPredicate
  validatePredicate(predicate, schema)
  const includes = (row: KernelProjection['rows'][number]) => !!row.preview && row.existence !== 'pending-delete' && matches(row.preview, predicate, schema)
  return Object.freeze({ query: view.query, rows: Object.freeze(view.rows.filter(includes)), total: projection.rows.filter(includes).length })
}
