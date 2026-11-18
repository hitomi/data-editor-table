import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DataGrid, createFieldGridDocumentModel, createGridColumnHelper, createRemoteGridDataSource } from 'data-editor-table'
import type { PersistenceSource, ServerAuthority } from 'data-editor-table/protocol'
import { createRowAuthority } from '../../../tests/package-consumer/browser/row-authority'

type Row = Readonly<{ id: string; name: string }>
type Scenario = 'intermediate' | 'later' | 'reload-failure' | 'malformed-receipt'
const columns = [createGridColumnHelper<Row>().field('name', { label: 'Name', type: 'string' })]
let diagnostics = { writes: 0, reads: 0, lookups: 0, cacheAccepted: null as boolean | null }

export function persistenceConsistencyDiagnostics() { return { ...diagnostics } }

export function mountPersistenceConsistencyFixture(container: HTMLElement, scenario: Scenario) {
  diagnostics = { writes: 0, reads: 0, lookups: 0, cacheAccepted: null }
  const server = createRowAuthority(`consistency-${scenario}`, { id: 'a', name: 'Initial' })
  const oldCacheRead = server.snapshot()
  const intermediate = server.changeName('Initial')
  let deliver: (() => void) | null = null
  let canRead = true

  function makeSource(initialAuthority: ServerAuthority) {
    const source: PersistenceSource = {
      ...server.source,
      async readAtLeast(scope, frontier) {
        diagnostics.reads++
        if (!canRead) throw new Error('Authority read unavailable')
        return server.source.readAtLeast(scope, frontier)
      },
      async lookupOperation(ref) {
        diagnostics.lookups++
        return server.source.lookupOperation(ref)
      },
      async submit(submission) {
        const result = await server.source.submit(submission)
        if (result.kind !== 'applied') return result
        diagnostics.writes++
        // The server has committed, but the response is still in transit.
        await new Promise<void>(resolve => { deliver = resolve })
        if (scenario === 'intermediate') adapter.publish(intermediate)
        if (scenario === 'later') adapter.publish(server.changeName('Later server edit'))
        if (scenario === 'malformed-receipt') return { kind: 'applied', receipt: { ...result.receipt, results: [] } }
        if (scenario === 'reload-failure') {
          canRead = false
          return { kind: 'applied-without-receipt', commitToken: result.receipt.operationId }
        }
        return result
      },
    }
    const adapter = createRemoteGridDataSource({
      columns, getRowKey: (row: Row) => row.id, model: createFieldGridDocumentModel(columns),
      scope: server.scope, source, initialAuthority, persistence: { mode: 'manual-save' },
    })
    return adapter
  }

  function Fixture() {
    const [source, setSource] = useState(() => makeSource(oldCacheRead))
    return <main style={{ display: 'flex', flexDirection: 'column', height: 700 }}>
      <div>
        <button type="button" onClick={() => {
          if (!deliver) throw new Error('No pending save response')
          deliver()
          deliver = null
        }}>Deliver save response</button>
        <button type="button" onClick={() => {
          source.publish(oldCacheRead)
          diagnostics.cacheAccepted = source.getSnapshot()?.observation === oldCacheRead.observation
        }}>Deliver old cache read</button>
        <button type="button" onClick={() => source.publish(server.replaceRow('Replacement'))}>Replace row</button>
        <button type="button" onClick={() => { canRead = true }}>Restore reads</button>
        <button type="button" onClick={() => {
          // Reopen from the adapter cache while offline. A network round trip
          // must not hide a regressed cache before the browser can observe it.
          canRead = false
          setSource(makeSource(source.getSnapshot()!))
        }}>Reopen table</button>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <DataGrid ariaLabel="Persistence consistency" dataSource={source} />
      </div>
    </main>
  }
  createRoot(container).render(<Fixture />)
}
