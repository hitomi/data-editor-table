/** Deliberately small business specification, independent of all src code.
 * Mutable dictionaries and explicit user requirements favor auditability over
 * the production journal's representation/performance. Server keys are entity
 * incarnations here; a reused business key must get a different dictionary ID.
 */
export type SpecValue = string | number | boolean | null
export type SpecRow = Readonly<Record<string, SpecValue>>
export type SpecRows = Readonly<Record<string, SpecRow>>
export type SpecRequirement = {
  id: number
  position: number
  undoPosition: number | null
  entity: string
  kind: 'write' | 'delete' | 'create'
  base: SpecRow | null
  values: SpecRow
  semanticReads: SpecRow
  undo: boolean
  state: 'pending' | 'submitted' | 'settled' | 'satisfied' | 'discarded'
}
export type SpecRequest = Readonly<{
  id: string
  version: number
  items: readonly Readonly<{ entity: string; value: SpecRow | null }>[]
  coverage: readonly number[]
}>
export type SpecReceipt = Readonly<{
  id: string
  version: number
  outputs: readonly Readonly<{ entity: string; value: SpecRow | null }>[]
}>
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const same = (a: SpecRow | null | undefined, b: SpecRow | null | undefined) => {
  if (a == null || b == null) return a == null && b == null
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && a[key] === b[key])
}

export class ReferenceServer {
  rows: Record<string, SpecRow>
  version = 0
  writes = 0
  readonly receipts = new Map<string, { request: string; receipt: SpecReceipt }>()
  readonly rejected = new Set<string>()
  constructor(initial: SpecRows) { this.rows = copy(initial) }
  external(rows: SpecRows) { this.rows = copy(rows); this.version++ }
  apply(request: SpecRequest, normalize: (entity: string, row: SpecRow) => SpecRow = (_entity, row) => row): SpecReceipt {
    const previous = this.receipts.get(request.id)
    if (previous) {
      if (previous.request !== JSON.stringify(request)) throw new Error('Id reused for another request')
      return copy(previous.receipt)
    }
    if (this.rejected.has(request.id) || request.version !== this.version) {
      this.rejected.add(request.id)
      throw new Error('Definitely not applied')
    }
    const next = copy(this.rows)
    const outputs = request.items.map(item => {
      const value = item.value === null ? null : copy(normalize(item.entity, copy(item.value)))
      if (value === null) delete next[item.entity]
      else next[item.entity] = value
      return { entity: item.entity, value }
    })
    // Business transformation completes for all rows before committing any.
    this.rows = next; this.version++; this.writes++
    const receipt = { id: request.id, version: this.version, outputs }
    this.receipts.set(request.id, { request: JSON.stringify(request), receipt: copy(receipt) })
    return receipt
  }
}

export class ReferenceEditor {
  private position = 0
  authority: Record<string, SpecRow>
  version = 0
  readonly requirements: SpecRequirement[] = []
  readonly applied = new Map<number, SpecRow | null>()
  request: SpecRequest | null = null
  receipt: SpecReceipt | null = null
  outcome: 'idle' | 'sending' | 'unknown' | 'awaiting-authority' = 'idle'
  constructor(initial: SpecRows) { this.authority = copy(initial) }

  write(entity: string, values: SpecRow, semanticReads: SpecRow = {}) {
    const base = this.preview()[entity]
    if (!base) throw new Error('Cannot edit an absent entity')
    return this.add(entity, 'write', base, values, semanticReads)
  }
  delete(entity: string) {
    const base = this.preview()[entity]
    if (!base) throw new Error('Cannot delete an absent entity')
    return this.add(entity, 'delete', base, {}, {})
  }
  create(entity: string, values: SpecRow) {
    if (this.preview()[entity]) throw new Error('Entity already exists')
    return this.add(entity, 'create', null, values, {})
  }
  private add(entity: string, kind: SpecRequirement['kind'], base: SpecRow | null, values: SpecRow, semanticReads: SpecRow, position = ++this.position) {
    const requirement: SpecRequirement = { id: this.requirements.length + 1, position, undoPosition: null, entity, kind, base: copy(base), values: copy(values), semanticReads: copy(semanticReads), undo: false, state: 'pending' }
    this.requirements.push(requirement)
    this.requirements.sort((a, b) => a.position - b.position)
    return requirement.id
  }

  undo(id: number) {
    const requirement = this.requirements.find(item => item.id === id)
    if (!requirement) throw new Error('Unknown action')
    if (requirement.undo) throw new Error('Action already undone')
    requirement.undo = true
    requirement.undoPosition = ++this.position
    if (requirement.state === 'settled') {
      this.compensate(requirement, this.applied.get(id) ?? null)
    } else if (requirement.state !== 'submitted') requirement.state = 'discarded'
    this.satisfyCurrentAuthority()
  }

  /** Redo is a new application of the original business request against the
   * current preview. It never clears the old undo or settlement evidence. */
  redo(id: number) {
    const original = this.requirements.find(item => item.id === id)
    if (!original?.undo) throw new Error('Only an undone requirement can be reapplied')
    if (original.kind !== 'write') throw new Error('This reference redo model currently covers field writes only')
    const current = this.preview()[original.entity]
    if (!current || Object.keys(original.semanticReads).some(key => current[key] !== original.semanticReads[key]))
      throw new Error('The original computation input is no longer valid')
    const replay = this.write(original.entity, copy(original.values), copy(original.semanticReads))
    this.satisfyCurrentAuthority()
    return replay
  }

  private compensate(requirement: SpecRequirement, canonical: SpecRow | null) {
    // A second undo follows the existing unsent compensation, rather than
    // pretending that each covered action had its own server intermediate.
    const position = requirement.undoPosition!
    const pending = this.requirements.some(item => item.position < position && item.entity === requirement.entity && item.state === 'pending' && !item.undo)
    const base = pending ? this.preview(position)[requirement.entity] ?? null : canonical
    if (requirement.kind === 'create') this.add(requirement.entity, 'delete', base, {}, {}, position)
    else if (requirement.kind === 'write') this.add(requirement.entity, 'write', base,
      Object.fromEntries(Object.keys(requirement.values).map(key => [key, requirement.base![key]!])), {}, position)
    else if (requirement.base) this.add(`${requirement.entity}:restored:${requirement.id}`, 'create', null, requirement.base, {}, position)
  }

  neutralIds(before = Infinity): ReadonlySet<number> {
    const neutral = new Set<number>()
    for (const entity of new Set(this.requirements.map(requirement => requirement.entity))) {
      const active = this.requirements.filter(requirement => requirement.position < before && requirement.entity === entity && !requirement.undo && (requirement.state === 'pending' || requirement.state === 'submitted'))
      if (active.some(requirement => requirement.state === 'submitted')) continue
      let prefix: SpecRequirement[] = [], initial: SpecRow | null = null, result: SpecRow | null = null
      for (const requirement of active) {
        if (!prefix.length) { initial = copy(requirement.base); result = copy(initial) }
        prefix.push(requirement)
        result = requirement.kind === 'delete' ? null : requirement.kind === 'create' ? copy(requirement.values) : { ...(result ?? {}), ...requirement.values }
        if (same(initial, result)) { prefix.forEach(requirement => neutral.add(requirement.id)); prefix = [] }
      }
    }
    return neutral
  }

  preview(before = Infinity): Record<string, SpecRow> {
    const rows = copy(this.authority)
    const neutral = this.neutralIds(before)
    // A submitted action is still a real reserved contribution. Its control
    // occurs when the user undid it, not at the old edit's position. Applying
    // controls in original edit order reverses two consecutive undos.
    const events = this.requirements.flatMap(requirement => {
      if (neutral.has(requirement.id) || (requirement.state !== 'pending' && requirement.state !== 'submitted')) return []
      return [{ requirement, position: requirement.position, undo: false },
        ...(requirement.undo ? [{ requirement, position: requirement.undoPosition!, undo: true }] : [])]
    }).filter(event => event.position < before).sort((a, b) => a.position - b.position)
    for (const { requirement, undo } of events) {
      const row = rows[requirement.entity] ?? requirement.base ?? {}
      if (undo) {
        if (requirement.base === null) delete rows[requirement.entity]
        else if (requirement.kind === 'write') rows[requirement.entity] = { ...row, ...Object.fromEntries(Object.keys(requirement.values).map(key => [key, requirement.base![key]!])) }
        else rows[requirement.entity] = copy(requirement.base)
      } else if (requirement.kind === 'delete') delete rows[requirement.entity]
      else rows[requirement.entity] = requirement.kind === 'create' ? copy(requirement.values) : { ...row, ...requirement.values }
    }
    return rows
  }

  blockedEntities(): string[] {
    const blocked = new Set<string>()
    const effective = copy(this.authority)
    const final = this.preview()
    const neutral = this.neutralIds()
    for (const requirement of this.requirements) {
      if (neutral.has(requirement.id)) continue
      if (requirement.state !== 'pending' && requirement.state !== 'submitted') continue
      if (requirement.undo) continue
      const row = effective[requirement.entity]
      if (requirement.kind === 'create') {
        if (row) blocked.add(requirement.entity)
        effective[requirement.entity] = requirement.values
      } else if (requirement.kind === 'delete') {
        if (row && !same(row, requirement.base)) blocked.add(requirement.entity)
        delete effective[requirement.entity]
      } else {
        if (!row || Object.keys(requirement.semanticReads).some(key => row[key] !== requirement.semanticReads[key])
          || Object.keys(requirement.values).some(key => row[key] !== requirement.base?.[key]
            && row[key] !== final[requirement.entity]?.[key])) blocked.add(requirement.entity)
        effective[requirement.entity] = { ...(row ?? requirement.base ?? {}), ...requirement.values }
      }
    }
    return [...blocked]
  }

  observe(rows: SpecRows, version: number) {
    if (version < this.version) return
    if (version === this.version && !sameRows(rows, this.authority)) throw new Error('Version reused')
    this.authority = copy(rows); this.version = version
    if (this.receipt && version >= this.receipt.version) this.settle()
    this.satisfyCurrentAuthority()
  }

  private satisfyCurrentAuthority() {
    // User controls can expose an existing authoritative value too. This is
    // satisfaction, not a new server write or a fabricated intermediate value.
    // Existence satisfaction is based on complete authority, never preview.
    const blocked = new Set(this.blockedEntities()), final = this.preview()
    for (const entity of new Set(this.requirements.map(item => item.entity))) {
      const neutral = this.neutralIds()
      const active = this.requirements.filter(item => item.entity === entity && !neutral.has(item.id) && (item.state === 'pending' || item.state === 'submitted'))
      if (blocked.has(entity) || active.some(item => item.state === 'submitted') || !same(final[entity], this.authority[entity])) continue
      for (const requirement of active) if (!requirement.undo) requirement.state = 'satisfied'
    }
  }

  freeze(id: string): SpecRequest {
    if (this.request) throw new Error('Previous outcome is unresolved')
    const blocked = new Set(this.blockedEntities())
    const neutral = this.neutralIds()
    const selected = this.requirements.filter(item => item.state === 'pending' && !neutral.has(item.id) && !item.undo && !blocked.has(item.entity))
    if (!selected.length) throw new Error('Nothing can be saved')
    const rows = this.preview()
    const request: SpecRequest = { id, version: this.version, coverage: selected.map(item => item.id),
      items: [...new Set(selected.map(item => item.entity))].map(entity => ({ entity, value: rows[entity] ?? null })) }
    this.request = copy(request); this.outcome = 'sending'
    for (const item of selected) item.state = 'submitted'
    return copy(request)
  }

  unknown() {
    if (!this.request) throw new Error('No request')
    this.outcome = 'unknown'
  }
  retry() {
    if (this.outcome !== 'unknown' || !this.request) throw new Error('Only unknown writes may be retried')
    return copy(this.request)
  }
  notApplied() {
    if (!this.request || this.receipt) throw new Error('Cannot reject an applied request')
    for (const item of this.requirements) if (this.request.coverage.includes(item.id)) item.state = item.undo ? 'discarded' : 'pending'
    this.request = null; this.outcome = 'idle'
  }
  receive(receipt: SpecReceipt) {
    if (!this.request || receipt.id !== this.request.id) throw new Error('Unrelated receipt')
    this.receipt = copy(receipt); this.outcome = 'awaiting-authority'
    if (this.version >= receipt.version) this.settle()
  }
  private settle() {
    const receipt = this.receipt!, request = this.request!
    for (const item of this.requirements) if (request.coverage.includes(item.id)) {
      item.state = 'settled'
      this.applied.set(item.id, copy(receipt.outputs.find(output => output.entity === item.entity)!.value))
    }
    for (const output of receipt.outputs) {
      const covered = this.requirements.filter(item => request.coverage.includes(item.id) && item.entity === output.entity)
      // A delayed receipt materializes compensation at the original undo's
      // place in user order, ahead of any redo that was authored meanwhile.
      for (const undone of covered.filter(item => item.undo).reverse()) this.compensate(undone, output.value)
      let base = copy(output.value)
      for (const pending of this.requirements) {
        if (pending.entity !== output.entity || pending.state !== 'pending' || pending.undo) continue
        if (pending.kind === 'write') {
          pending.base = copy(base)
          base = { ...(base ?? {}), ...pending.values }
        } else base = pending.kind === 'delete' ? null : copy(pending.values)
      }
    }
    this.request = null; this.receipt = null; this.outcome = 'idle'
  }
}
function sameRows(a: SpecRows, b: SpecRows) {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => same(a[key], b[key]))
}
