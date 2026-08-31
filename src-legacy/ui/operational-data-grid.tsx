import type { CSSProperties, Key, ReactNode, Ref } from 'react'
import { DataGrid, type DataGridHandle, type DataGridProps } from 'react-data-grid'
import { classNames } from './class-names.js'
import type { DataGridCollectionState } from '../core/view-state.js'

// Extracted from Huifan's neutral OperationalDataGrid shell. Cellophane owns
// the visual tokens and dataset adapter; no Huifan business module is imported.
export function OperationalDataGrid<Row, SummaryRow = unknown, RowKey extends Key = Key>({
  ariaLabel,
  className,
  emptyContent,
  errorContent,
  filteredEmptyContent,
  footer,
  gridRef,
  loading = false,
  loadingContent,
  collectionState,
  overlay,
  rows,
  sourceRowCount = rows.length,
  toolbar,
  viewportRef,
  ...props
}: Omit<DataGridProps<Row, SummaryRow, RowKey>, 'className' | 'ref'> & {
  ariaLabel: string
  className?: string
  emptyContent?: ReactNode
  errorContent?: ReactNode
  filteredEmptyContent?: ReactNode
  footer?: ReactNode
  gridRef?: Ref<DataGridHandle>
  loading?: boolean
  loadingContent?: ReactNode
  collectionState?: DataGridCollectionState
  overlay?: ReactNode
  sourceRowCount?: number
  toolbar?: ReactNode
  viewportRef?: Ref<HTMLDivElement>
}) {
  const headerHeight = props.headerRowHeight ?? 42
  const state = collectionState ?? (rows.length > 0 ? 'ready' : loading ? 'initial-loading' : sourceRowCount > 0 ? 'filtered-empty' : 'ready-empty')
  const stateContent = state === 'initial-loading' ? loadingContent
    : state === 'failed-empty' ? errorContent
      : state === 'filtered-empty' ? filteredEmptyContent
        : state === 'ready-empty' ? emptyContent
          : null
  const retainedStatus = state === 'refreshing-with-data' ? loadingContent : state === 'failed-with-data' ? errorContent : null
  return <div className={classNames('operational-data-grid-surface', className)} style={{ '--operational-grid-header-height': `${headerHeight}px` } as CSSProperties}>
    {toolbar}
    {retainedStatus && <div className="operational-data-grid-retained-status" role={state === 'failed-with-data' ? 'alert' : 'status'}>{retainedStatus}</div>}
    <div ref={viewportRef} className="operational-data-grid-viewport">
      <DataGrid {...props} ref={gridRef} aria-label={ariaLabel} className="operational-data-grid rdg-light" rows={rows} rowHeight={props.rowHeight ?? 44} headerRowHeight={headerHeight} />
      {stateContent && <div className="operational-data-grid-state" role={state === 'failed-empty' ? 'alert' : state === 'initial-loading' ? 'status' : undefined} aria-live="polite">{stateContent}</div>}
      {overlay}
    </div>
    {footer}
  </div>
}
