# react-data-grid-ext

An extracted, product-neutral, data-source-driven editing layer for `react-data-grid`. It combines the original Huifan grid implementation with the correctness and interaction work later made in Cellophane, without changing either application's current imports.

## Included

- React-free baseline/draft engine with dirty fields, validation messages, conflicts, source rebase, append/delete/reorder, bounded undo/redo and partial commit planning.
- Fine-grained row, order, metadata and dirty-state subscriptions, plus React hooks for dirty columns, rows and original values.
- React hooks and a `react-data-grid` row-change adapter.
- Operational collection states that distinguish initial loading, retained refresh, empty, filtered-empty and failure.
- Contiguous and discontinuous range selection, keyboard extension, clipboard matrices, fill handling, context targeting and viewport-synchronized overlays.
- Image cells with click/drop validation and explicit object-URL cleanup ownership.
- A dependency-free bulk editor panel for text, number, select and tag fields.
- A turnkey `DataSourceDataGrid`: supply one reactive data source and a cell type registry.
- Three persistence contracts: immediate `update`, explicit `save-dirty`, and debounced `auto-save`.
- Extensible cell types; image upload is supplied as a normal registered renderer.
- Themeable CSS with no Huifan or Cellophane application tokens.

Application-specific image upload/storage and product bulk actions remain outside the package. The package stages files and applies row transforms; the host owns persistence, localized copy and its dialog/popover shell.

## Install and use

```sh
pnpm add react-data-grid-ext react-data-grid
```

```tsx
import {
  DataSourceDataGrid,
  createDataGridCellTypeRegistry,
  registerDataGridBuiltinCellTypes,
} from 'react-data-grid-ext'
import 'react-data-grid-ext/styles.css'

type Row = { id: string; title: string }

const cellTypes = registerDataGridBuiltinCellTypes(
  createDataGridCellTypeRegistry<Row>(),
)

const dataSource = {
  fields: [{
    key: 'title', label: 'Title', type: 'text',
    getValue: (row: Row) => row.title,
    setValue: (row: Row, title: unknown) => ({ ...row, title: String(title) }),
  }],
  getRowKey: (row: Row) => row.id,
  getSnapshot: () => store.snapshot,
  subscribe: store.subscribe,
  persistence: {
    mode: 'auto-save' as const,
    debounceMs: 500,
    async saveDirty(request) {
      const rows = await api.saveRows(request.rows, request.signal)
      store.publish({ rows, state: 'ready' })
    },
  },
}

<DataSourceDataGrid ariaLabel="Content" dataSource={dataSource} cellTypes={cellTypes} />
```

Saving does not clear dirty state optimistically. After persistence succeeds, the data source publishes a new authoritative snapshot; the engine rebases drafts against it. Failed saves retain edited rows and expose a recoverable error state.

Register application types with `registry.register(type, renderer)`. `createDataGridImageCellTypeRenderer` is the bundled image implementation: the host supplies upload and URL resolution, while the renderer owns validation, cancellation and temporary object-URL cleanup. Image is not special-cased in `DataSourceDataGrid`.

Type actions are registered beside their renderer. `DataGridActionSurfaces` can present the same resolved actions in a context menu, inside the cell, or in a top/floating toolbar. Sorting is a controlled data-source capability; the source receives the requested sort state and publishes authoritative ordered rows. See [the extensibility contract](docs/architecture.md).

Run `pnpm demo` for the development page: the table is on the left and authoritative JSON, dirty originals, and patch preview are on the right. It exercises auto-save, custom actions, source-controlled sorting, and the registered image renderer.

The host owns its reactive store, persistence, localized copy and application-specific actions. Override `--rdg-ext-accent`, `--rdg-ext-text`, and `--rdg-ext-muted` on `.operational-data-grid-surface` to theme the surface.

## Source provenance

The initial grid engine, React adapter, field model, selection state machine and operational shell came from `../huifan/packages/ui/src/data-grid`. The extracted baseline then incorporates Cellophane's changes from `src/core/data-grid`, `src/features/data-grid`, and `src/features/data/OperationalDataGrid.tsx`, including append/delete, partial commit, cell errors, conflict recovery, stable ordering, bounded selection operations and retained refresh/error states.

The package remains `UNLICENSED` because the source repositories do not currently provide an outbound license for their own code. Choose and document a license before publishing it outside the owner-controlled repositories.
