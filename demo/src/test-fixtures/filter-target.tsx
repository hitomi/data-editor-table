import { createRoot } from 'react-dom/client'
import {
  createDataGridBinding, createFieldGridDocumentModel, createGridColumnHelper,
  createRemoteGridDataSource, DataGrid, type GridFilterDialogProps,
} from 'data-editor-table'
import { createRowAuthority } from '../../../tests/package-consumer/browser/row-authority'

type Row = { id: string; name: string }

export function mountFilterTargetFixture(container: HTMLElement) {
  const server = createRowAuthority('filter-target', { id: 'a', name: 'Original' })
  const helper = createGridColumnHelper<Row>()
  const columns = (['id', 'name'] as const).map(key => helper.field(key, { label: key, type: 'string', filterable: true }))
  const source = createRemoteGridDataSource({
    columns, model: createFieldGridDocumentModel(columns), getRowKey: (row: Row) => row.id,
    scope: server.scope, source: server.source, initialAuthority: server.snapshot(), persistence: { mode: 'manual-save' },
  })
  const binding = createDataGridBinding({ dataSource: source })
  let first: GridFilterDialogProps | undefined
  const renderFilter = (props: GridFilterDialogProps) => {
    first ??= props
    return <section aria-label="Filter draft">
      <label>{props.draft.columnLabel}<input value={props.draft.conditions[0]?.value ?? ''}
        onChange={event => props.onValueChange(0, event.target.value)} /></label>
      <button onClick={props.onCancel}>Cancel current filter</button>
      <button onClick={props.onApply}>Apply current filter</button>
    </section>
  }
  createRoot(container).render(<main style={{ height: 500 }}>
    <button onClick={() => {
      first?.onValueChange(0, 'stale')
      first?.onApply()
      first?.onCancel()
    }}>Finish first filter</button>
    <DataGrid binding={binding} ariaLabel="Filter target" surfaceRenderers={{ filterDialog: renderFilter }} />
  </main>)
  return () => binding.controller.getSnapshot().view.columnFilters
}
