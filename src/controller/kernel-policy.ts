import { kernelId } from '../kernel/model.js'
import type { PolicySnapshot } from '../kernel/state.js'
import type { GridRowCapabilities } from '../data/data-source.js'

export function gridKernelPolicy<Row>(rows: GridRowCapabilities<Row> | undefined,
  version: string): PolicySnapshot {
  const base = { write: true, replace: true, delete: rows?.canDelete !== undefined, readonlyPaths: [] }
  // Column isEditable and row canDelete gate new commands against their staged local row in
  // kernel-authoring. Its captured row dependency protects subsequent replay.
  // Turning that UI condition into an authority-derived storage restriction
  // would reject edits after a local unlock, or block earlier valid writes
  // after a later lock. Permanent storage restrictions belong to schema.fields.
  return { version: kernelId<'policy-version'>(version), create: Boolean(rows?.create || rows?.duplicate), order: rows?.ordering === 'mutable', defaultEntity: base, entities: [] }
}
