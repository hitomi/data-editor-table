import { useEffect, type ReactNode } from 'react'

import type { DataGridSourceField } from './cell-type-registry'

export type DataGridCellActionContext<Row, Value = unknown> = {
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
  hidden?: (context: DataGridCellActionContext<Row, Value>) => boolean
  disabled?: (context: DataGridCellActionContext<Row, Value>) => boolean
  run: (context: DataGridCellActionContext<Row, Value>) => void | Promise<void>
}

export type ResolvedDataGridCellAction<Row> = {
  id: string
  label: ReactNode
  group?: string
  destructive: boolean
  disabled: boolean
  run: () => void | Promise<void>
  context: DataGridCellActionContext<Row, unknown>
}

export type DataGridActionSurfaceProps<Row> = {
  actions: readonly ResolvedDataGridCellAction<Row>[]
  close: () => void
  context: DataGridCellActionContext<Row, unknown>
}

/** Presentation is independent from capability: use any combination of surfaces. */
export type DataGridActionSurfaces<Row> = {
  renderCell?: (props: Omit<DataGridActionSurfaceProps<Row>, 'close'>) => ReactNode
  renderContext?: (props: DataGridActionSurfaceProps<Row> & { x: number; y: number }) => ReactNode
  renderToolbar?: (props: Omit<DataGridActionSurfaceProps<Row>, 'close'>) => ReactNode
}

export function resolveDataGridCellActions<Row>(
  context: DataGridCellActionContext<Row, unknown>,
  actions: readonly DataGridCellAction<Row, unknown>[],
): readonly ResolvedDataGridCellAction<Row>[] {
  return actions.flatMap((action) => action.hidden?.(context) ? [] : [{
    id: action.id,
    label: action.label,
    ...(action.group === undefined ? {} : { group: action.group }),
    destructive: action.destructive ?? false,
    disabled: action.disabled?.(context) ?? false,
    run: () => action.run(context),
    context,
  }])
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
  return <div className="operational-data-grid-action-menu" role="menu" style={{ left: x, top: y }}>
    {actions.map((action) => <button
      key={action.id} type="button" role="menuitem" disabled={action.disabled}
      data-destructive={action.destructive || undefined}
      onClick={() => { void Promise.resolve(action.run()).finally(close) }}
    >{action.label}</button>)}
  </div>
}
