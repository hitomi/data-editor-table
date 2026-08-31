export type DataGridCollectionState =
  | 'initial-loading'
  | 'refreshing-with-data'
  | 'ready'
  | 'ready-empty'
  | 'filtered-empty'
  | 'failed-with-data'
  | 'failed-empty'

export function resolveDataGridCollectionState(input: {
  readonly loading: boolean
  readonly refreshing: boolean
  readonly error: string | null
  readonly sourceRowCount: number
  readonly visibleRowCount: number
}): DataGridCollectionState {
  if (input.error !== null) return input.sourceRowCount > 0 ? 'failed-with-data' : 'failed-empty'
  if (input.loading && input.sourceRowCount === 0) return 'initial-loading'
  if (input.refreshing && input.sourceRowCount > 0) return 'refreshing-with-data'
  if (input.sourceRowCount === 0) return 'ready-empty'
  if (input.visibleRowCount === 0) return 'filtered-empty'
  return 'ready'
}
