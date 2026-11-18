import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createFieldGridDocumentModel, createGridColumnHelper, createRemoteGridDataSource,
  createStandardCellTypeRegistry, createStringCellType, DataGrid,
} from 'data-editor-table'
import { createRowAuthority } from '../../../tests/package-consumer/browser/row-authority'

type Row = { id: string; name: string }

export function mountEditorTargetFixture(container: HTMLElement) {
  const server = createRowAuthority('editor-target', { id: 'a', name: 'Original' })
  const columns = [createGridColumnHelper<Row>().field('name', { label: 'Name', type: 'string' })]
  const source = createRemoteGridDataSource({
    columns, model: createFieldGridDocumentModel(columns), getRowKey: (row: Row) => row.id,
    scope: server.scope, source: server.source, initialAuthority: server.snapshot(), persistence: { mode: 'manual-save' },
  })
  const standard = createStringCellType().create<Row>()
  const Editor = standard.view.Editor!
  let finishFirstEdit: (() => void) | undefined
  const registry = createStandardCellTypeRegistry<Row>().replace('string', {
    ...standard, view: { ...standard.view, Editor(props) {
      useLayoutEffect(() => {
        // Model an asynchronous host editor retaining the callbacks it received on mount.
        finishFirstEdit ??= () => {
          props.setDraft('Result for the first editor')
          props.commit()
          props.cancel()
        }
      }, [props])
      return <Editor {...props} />
    } },
  })
  createRoot(container).render(<main style={{ height: 500 }}>
    <button onClick={() => source.publish(server.replaceRow('Replacement'))}>Replace row</button>
    <button onClick={() => finishFirstEdit?.()}>Finish first edit</button>
    <div style={{ height: 420 }}>
      <DataGrid ariaLabel="Editor target" dataSource={source} initial={{ registry }} />
    </div>
  </main>)
  return () => server.snapshot().rows[0]?.document.name
}
