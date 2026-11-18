import { createRoot } from 'react-dom/client'
import {
  createDataGridBinding, createFieldGridDocumentModel, createGridColumnHelper, createRemoteGridDataSource,
  DataGrid, selectGridActions,
} from 'data-editor-table'
import type { PersistenceSource } from 'data-editor-table/protocol'
import { createRowAuthority } from '../../../tests/package-consumer/browser/row-authority'

type Row = { id: string; name: string }
type Scenario = 'unknown' | 'dispute'

export function mountSaveActionsFixture(container: HTMLElement, scenario: Scenario) {
  const server = createRowAuthority('actions-' + scenario, { id: 'a', name: 'Initial' })
  let writes = 0
  const transport: PersistenceSource = {
    ...server.source,
    async submit(request) {
      if (++writes === 1) {
        if (scenario === 'dispute') return { kind: 'applied-without-receipt', commitToken: 'unverified-write' }
        await server.source.submit(request)
        throw new Error('Lost response')
      }
      return server.source.submit(request)
    },
  }
  const columns = [createGridColumnHelper<Row>().field('name', { type: 'string', label: 'Name' })]
  const remote = createRemoteGridDataSource({ columns, model: createFieldGridDocumentModel(columns),
    getRowKey: (row: Row) => row.id, source: transport, scope: server.scope,
    initialAuthority: server.snapshot(), persistence: { mode: 'manual-save' } })
  const writer = createDataGridBinding({ dataSource: remote })
  const peer = createDataGridBinding({ dataSource: remote })
  const shown = scenario === 'dispute' ? peer : writer
  createRoot(container).render(<main style={{ height: 650 }}>
    <DataGrid binding={shown} ariaLabel="Save actions" surfaceRenderers={scenario === 'unknown'
      ? { toolbar: props => <button disabled={!props.state.canSave} onClick={props.onSave}>Custom save</button> }
      : {}} />
  </main>)
  return {
    async firstWrite() {
      writer.controller.dispatch({ type: 'cell/set-value', cell: { columnKey: 'name', rowKey: 'a' }, value: 'First' })
      return (await writer.controller.save()).status
    },
    async save() { return (await shown.controller.save()).status },
    async verify() {
      const dispute = remote.getDispute()
      if (!dispute) throw Error('Expected a dispute')
      const verified = await server.source.lookupOperation(dispute.ref)
      if (verified.kind !== 'not-applied' && verified.kind !== 'applied') throw Error('No definitive evidence')
      remote.resolveDispute(dispute.id, verified)
    },
    state() {
      const snapshot = shown.controller.getSnapshot(), actions = selectGridActions(snapshot)
      return { save: actions.save.enabled, retry: actions.retrySave.enabled, recovery: actions.recoverSave.target?.action,
        disputed: !!snapshot.persistence.dispute, writes, persisted: server.snapshot().rows[0]?.document.name }
    },
  }
}
