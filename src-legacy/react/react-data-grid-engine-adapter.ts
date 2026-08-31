import type { RowsChangeData } from 'react-data-grid'
import type { GridRowKey } from '../core/types.js'

import type { DataGridEngine } from '../core/grid-engine.js'

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
