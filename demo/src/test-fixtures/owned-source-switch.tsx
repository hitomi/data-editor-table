import { useState } from 'react'
import { createRoot } from 'react-dom/client'

import {
  DataGrid,
  createGridColumnHelper,
  type GridDataSource,
  type StandardGridCellTypeSchema,
} from 'data-editor-table'

type Row = Readonly<{ id: string; name: string }>
type SourceName = 'a' | 'b'

const subscriptions: Record<SourceName, number> = { a: 0, b: 0 }
const column = createGridColumnHelper<Row>()
const columns = [column.field('name', {
  label: 'Name',
  type: 'string',
  filterable: true,
})]

function fixtureDataSource(
  name: SourceName,
): GridDataSource<Row, string, StandardGridCellTypeSchema> {
  const row = { id: `row-${name}`, name: `Source ${name.toUpperCase()} row` }
  return {
    columns,
    getRowKey: (candidate) => candidate.id,
    getSnapshot: () => ({
      rows: [row],
      status: 'ready',
      version: `version-${name}`,
      scope: { kind: 'complete' },
    }),
    subscribe: () => {
      subscriptions[name] += 1
      return () => { subscriptions[name] -= 1 }
    },
    persistence: {
      mode: 'manual-save',
      commit: async (request) => ({
        operationId: request.operationId,
        applied: {
          rows: request.rows,
          status: 'ready',
          version: `${name}-saved`,
          scope: { kind: 'complete' },
        },
      }),
    },
  }
}

export function mountOwnedSourceSwitchFixture(container: HTMLElement) {
  subscriptions.a = 0
  subscriptions.b = 0
  const sourceA = fixtureDataSource('a')
  const sourceB = fixtureDataSource('b')

  function Fixture() {
    const [dataSource, setDataSource] = useState(sourceA)
    return <main style={{ display: 'flex', flexDirection: 'column', height: 700 }}>
      <button type="button" onClick={() => setDataSource(sourceB)}>
        Switch data source
      </button>
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <DataGrid ariaLabel="Owned source switch" dataSource={dataSource} />
      </div>
    </main>
  }

  createRoot(container).render(<Fixture />)
}

export function ownedSourceSwitchSubscriptions() {
  return { ...subscriptions }
}
