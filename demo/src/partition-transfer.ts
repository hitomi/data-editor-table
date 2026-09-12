import { encodedValuesEqual, kernelId, ownEncodedValue, prepareRowAction, type Document, type EntityId, type RowCommand, type Workspace } from 'data-editor-table'
export type Side = 'left' | 'right'
export type Transfer = Readonly<{ format: 'partition-rows:1'; workspaceId: string; token: string; source: Side; mode: 'copy' | 'move'; rows: readonly Readonly<{ entityId: EntityId; document: Document }>[] }>
export const transferMime = 'application/x-data-editor-partition-rows'
const own = <T,>(value: T): T => ownEncodedValue(value) as unknown as T
export function captureTransfer(workspace: Workspace, ids: readonly EntityId[], source: Side, mode: 'copy' | 'move'): string {
  const projection = workspace.getProjection(), rows = new Map(projection.rows.map(row => [row.entityId, row]))
  if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length) throw new Error('Select between 1 and 50 distinct rows.')
  const transfer: Transfer = { format: 'partition-rows:1', workspaceId: workspace.getState().workspace.id, token: crypto.randomUUID(), source, mode,
    rows: ids.map(entityId => { const row = rows.get(entityId)
      if (!row?.preview || row.existence === 'pending-delete' || row.issues.length || row.preview.side !== source) throw new Error('A selected row changed. Select the rows again.')
      return { entityId, document: row.preview }
    }) }
  const text = JSON.stringify(transfer)
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error('The selected rows exceed the 2 MiB transfer limit.')
  return text
}
function decode(text: string): Transfer {
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error('The row transfer exceeds 2 MiB.')
  const value = own(JSON.parse(text)) as Transfer
  if (!value || value.format !== 'partition-rows:1' || typeof value.workspaceId !== 'string' || typeof value.token !== 'string'
    || !['left', 'right'].includes(value.source) || !['copy', 'move'].includes(value.mode) || !Array.isArray(value.rows)
    || !value.rows.length || value.rows.length > 50 || new Set(value.rows.map(row => row?.entityId)).size !== value.rows.length) throw new Error('Unsupported row transfer.')
  for (const row of value.rows) if (!row || typeof row.entityId !== 'string' || !row.entityId || !row.document || typeof row.document !== 'object' || Array.isArray(row.document)) throw new Error('Invalid transferred row.')
  return value
}
export async function transferRows(workspace: Workspace, text: string, target: Side, before: EntityId | null, trusted: boolean) {
  const transfer = decode(text), snapshot = workspace.getSnapshot(), state = snapshot.state, fresh = () => crypto.randomUUID()
  const move = trusted && transfer.workspaceId === state.workspace.id && transfer.mode === 'move'
  const rows = new Map(snapshot.projection.rows.filter(row => row.preview && row.existence !== 'pending-delete').map(row => [row.entityId, row]))
  if (before && (!rows.has(before) || rows.get(before)!.preview!.side !== target)) throw new Error('The destination changed. Choose its position again.')
  if (trusted) for (const original of transfer.rows) {
    const row = rows.get(original.entityId)
    if (!row?.preview || row.issues.length || !encodedValuesEqual(row.preview, original.document)) throw new Error('A dragged row changed. Select the rows again.')
  }
  if (move && transfer.rows.some(row => row.document.deleteProtected === true && row.document.side !== target)) throw new Error('Protected rows can be copied or reordered, but cannot move to another list.')
  const moving = new Set(move ? transfer.rows.map(row => row.entityId) : [])
  if (before && moving.has(before)) return false
  const commands: RowCommand[] = [], inserted: EntityId[] = []
  for (const original of transfer.rows) {
    if (move) {
      inserted.push(original.entityId)
      if (original.document.side !== target) commands.push({ kind: 'write', entityId: original.entityId, groups: [{ id: kernelId<'write-group'>(fresh()), comparison: 'entity', reads: [], writes: [{ kind: 'set', path: ['side'], value: target }] }] })
    } else {
      const entityId = kernelId<'entity'>(fresh()); inserted.push(entityId)
      commands.push({ kind: 'create', entityId, document: { ...original.document, id: fresh(), side: target, homeSide: target, deleteProtected: false } })
    }
  }
  const desired = snapshot.projection.order.preview.filter(id => !moving.has(id))
  desired.splice(before ? desired.indexOf(before) : desired.length, 0, ...inserted)
  const afterCreates = [...snapshot.projection.order.preview, ...(move ? [] : inserted)]
  if (!encodedValuesEqual(desired, afterCreates)) commands.push({ kind: 'order', desired })
  if (!commands.length) return false
  const input = { ref: { id: kernelId<'input'>(fresh()), version: 0 }, input: { kind: 'encoded' as const, value: own({ text, target, before, move }) } }
  const prepared = prepareRowAction(state, { cause: 'user', inputs: [input],
    action: { id: kernelId<'action'>(fresh()), applicationId: kernelId<'application'>(fresh()), label: `${move ? 'Move' : 'Copy'} ${inserted.length} rows`, saveAtomicity: 'transaction' },
    commands: commands.map(command => ({ id: kernelId<'intent'>(fresh()), inputs: [input.ref], dependencies: [], command })),
  }, workspace.schema)
  const result = await workspace.dispatch({ kind: 'prepared-action', prepared })
  if (result.kind !== 'accepted') throw new Error('The transfer was not confirmed. Review retained work before retrying.')
  return true
}
