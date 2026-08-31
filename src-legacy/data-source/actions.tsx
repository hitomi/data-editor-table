import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { DataGridSourceField } from './cell-type-registry.js'

export type DataGridCellActionContext<Row, Value = unknown> = {
  editable: boolean
  field: DataGridSourceField<Row, Value>
  row: Row
  value: Value
  update: (value: Value) => void
}

export type DataGridCellAction<Row, Value = unknown> = {
  id: string
  label: ReactNode
  group?: string
  destructive?: boolean
  /** Defaults to true. Set false only for actions without edit side effects. */
  requiresEditable?: boolean
  hidden?: (context: DataGridCellActionContext<Row, Value>) => boolean
  disabled?: (context: DataGridCellActionContext<Row, Value>) => boolean
  run: (context: DataGridCellActionContext<Row, Value>) => void | Promise<void>
}

export type ResolvedDataGridCellAction<Row> = {
  scope: 'cell'
  id: string
  label: ReactNode
  group?: string
  destructive: boolean
  disabled: boolean
  run: () => void | Promise<void>
  context: DataGridCellActionContext<Row, unknown>
}

export type DataGridSelectionActionContext<Row> = {
  cells: readonly { clearable: boolean; columnKey: string; editable: boolean; row: Row }[]
  cellCount: number
  clearableCellCount: number
  columnCount: number
  operationBlocked: boolean
  rowCount: number
}

export type ResolvedDataGridSelectionAction<Row> = {
  scope: 'selection'
  id: string
  label: ReactNode
  destructive: boolean
  disabled: boolean
  run: () => void | Promise<void>
  context: DataGridSelectionActionContext<Row>
}

export type DataGridCellActionSurfaceProps<Row> = {
  scope: 'cell'
  actions: readonly ResolvedDataGridCellAction<Row>[]
  context: DataGridCellActionContext<Row, unknown>
}

export type DataGridSelectionActionSurfaceProps<Row> = {
  scope: 'selection'
  actions: readonly ResolvedDataGridSelectionAction<Row>[]
  context: DataGridSelectionActionContext<Row>
}

export type DataGridActionSurfaceProps<Row> = (DataGridCellActionSurfaceProps<Row> | DataGridSelectionActionSurfaceProps<Row>) & {
  close: () => void
}

/** Presentation is independent from capability: use any combination of surfaces. */
export type DataGridActionSurfaces<Row> = {
  renderCell?: (props: DataGridCellActionSurfaceProps<Row>) => ReactNode
  renderContext?: (props: DataGridActionSurfaceProps<Row> & { x: number; y: number }) => ReactNode
  renderToolbar?: (props: DataGridCellActionSurfaceProps<Row> | DataGridSelectionActionSurfaceProps<Row>) => ReactNode
}

export function resolveDataGridCellActions<Row>(
  context: DataGridCellActionContext<Row, unknown>,
  actions: readonly DataGridCellAction<Row, unknown>[],
): readonly ResolvedDataGridCellAction<Row>[] {
  return actions.flatMap((action) => {
    if (action.hidden?.(context)) return []
    const disabled = (!context.editable && (action.requiresEditable ?? true)) || (action.disabled?.(context) ?? false)
    return [{
      scope: 'cell' as const,
      id: action.id,
      label: action.label,
      ...(action.group === undefined ? {} : { group: action.group }),
      destructive: action.destructive ?? false,
      disabled,
      run: () => disabled ? undefined : action.run(context),
      context,
    }]
  })
}

export function DefaultDataGridContextActions<Row>({ actions, close, x, y }: DataGridActionSurfaceProps<Row> & { x: number; y: number }) {
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest('.operational-data-grid-action-menu')) close()
    }
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('pointerdown', pointer)
    window.addEventListener('keydown', keyboard)
    return () => { window.removeEventListener('pointerdown', pointer); window.removeEventListener('keydown', keyboard) }
  }, [close])
  const menu = <div className="operational-data-grid-action-menu" data-grid-selection-action="true" role="menu" style={{ left: x, top: y }}>
    {actions.map((action) => <button
      key={action.id} type="button" role="menuitem" disabled={action.disabled}
      data-destructive={action.destructive || undefined}
      onClick={() => { void Promise.resolve(action.run()).finally(close) }}
    >{action.label}</button>)}
  </div>
  return typeof document === 'undefined' ? menu : createPortal(menu, document.body)
}
