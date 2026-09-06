import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  DataGrid,
  createGridColumnHelper,
  createRemoteGridDataSource,
  type GridCommitRequest,
  type GridRemoteMutationResult,
} from 'data-editor-table'

type Row = Readonly<{ id: string; name: string }>
type Scenario = 'intermediate' | 'later' | 'reload-failure'
const column = createGridColumnHelper<Row>()
let diagnostics = { writes: 0, reads: 0, cacheAccepted: null as boolean | null }

export function persistenceConsistencyDiagnostics() { return { ...diagnostics } }

/** A controllable server keeps arrival order separate from authoritative order. */
export function mountPersistenceConsistencyFixture(container: HTMLElement, scenario: Scenario) {
  diagnostics = { writes: 0, reads: 0, cacheAccepted: null }
  let server = { rows: [{ id: 'a', name: 'Initial' }], version: 'base' }
  let request: GridCommitRequest<Row, string> | undefined
  let finish: ((result: GridRemoteMutationResult<Row, string>) => void) | undefined
  let canRead = scenario !== 'reload-failure'
  const makeSource = () => createRemoteGridDataSource({
    columns: [column.field('name', { label: 'Name', type: 'string' })],
    getRowKey: (row: Row) => row.id,
    initialSnapshot: { ...server, status: 'ready', scope: { kind: 'complete' } },
    load: async () => {
      diagnostics.reads += 1
      if (!canRead) throw new Error('Authority read unavailable')
      return server
    },
    persistence: {
      mode: 'manual-save',
      mutate: (next) => {
        diagnostics.writes += 1
        request = next
        return new Promise<GridRemoteMutationResult<Row, string>>((resolve) => { finish = resolve })
      },
    },
  })

  function Fixture() {
    const [source, setSource] = useState(makeSource)
    const [cache] = useState(() => source.beginRead())
    return <main style={{ display: 'flex', flexDirection: 'column', height: 700 }}>
      <div>
        <button type="button" onClick={() => {
          if (!request || !finish) throw new Error('No pending write')
          if (scenario === 'intermediate') source.publish({
            rows: [{ id: 'a', name: 'Initial' }], version: 'intermediate',
            status: 'ready', scope: { kind: 'complete' },
          })
          // Simulated server normalization is authoritative, independent of arrival.
          const applied = { rows: request.rows.map((row) => ({ ...row, name: row.name.trim() })), version: 'applied' }
          server = scenario === 'later'
            ? { rows: [{ id: 'a', name: 'Later server edit' }], version: 'later' }
            : applied
          if (scenario === 'later') source.publish({ ...server, status: 'ready', scope: { kind: 'complete' } })
          finish(scenario === 'reload-failure' ? { kind: 'reload' } : { kind: 'applied', authority: applied })
          finish = undefined
        }}>Deliver save response</button>
        <button type="button" onClick={() => {
          diagnostics.cacheAccepted = cache.publish({
            rows: [{ id: 'a', name: 'Initial' }], version: 'stale-cache',
            status: 'ready', scope: { kind: 'complete' },
          })
        }}>Deliver old cache read</button>
        <button type="button" onClick={() => { canRead = true }}>Restore reads</button>
        <button type="button" onClick={() => { setSource(makeSource()) }}>Reopen table</button>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <DataGrid ariaLabel="Persistence consistency" dataSource={source} />
      </div>
    </main>
  }
  createRoot(container).render(<Fixture />)
}
