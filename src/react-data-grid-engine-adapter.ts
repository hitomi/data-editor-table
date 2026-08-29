import type { RowsChangeData } from 'react-data-grid'
import type { GridRowKey } from './types'

import type { DataGridEngine } from './grid-engine'

export function applyReactDataGridRowsChange<Row, RowKey extends GridRowKey>(
  engine: DataGridEngine<Row, RowKey>,
  rows: readonly Row[],
  { indexes }: Pick<RowsChangeData<Row>, 'indexes'>,
) {
  engine.applyRows(
    indexes.flatMap((index) => {
      const row = rows[index]
      return row ? [row] : []
    }),
  )
}
