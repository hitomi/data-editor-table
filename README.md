# react-data-grid-ext

A turnkey React bulk editor for real business data. It provides range, row,
column and select-all selection; registered cell rendering and editing; matrix
copy, paste, clear and fill; bulk editing; filtering and sorting; dirty and
conflict feedback; row operations; undo/redo; and manual or automatic saving.

The native grid owns its fixed-row layout and interactions. It does not depend
on `react-data-grid`, does not virtualize the initial release, and keeps its
controller, data source and cell behaviors usable without React. The rationale,
milestones and tracked limits are in
[the native grid v2 plan](docs/native-grid-v2-plan.md).

## Install

```sh
pnpm add react-data-grid-ext react react-dom
```

Import the bundled styles once; the component is fully styled by default.

```tsx
import {
  DataGrid,
  createCellTypeRegistry,
  createStringCellType,
  type GridCellTypeSchemaOf,
  type GridDataSource,
} from 'react-data-grid-ext'
import 'react-data-grid-ext/styles.css'

type Row = { id: string; title: string }

const registry = createCellTypeRegistry<Row>()
  .register('string', createStringCellType())

type CellTypes = GridCellTypeSchemaOf<typeof registry>

const dataSource: GridDataSource<Row, string, CellTypes> = {
  columns: [{
    key: 'title',
    label: 'Title',
    type: 'string',
    sortable: true,
    filterable: true,
    bulkEditable: true,
    getValue: (row) => row.title,
    setValue: (row, title) => ({ ...row, title }),
  }],
  getRowKey: (row) => row.id,
  // Supply cloneRow when Row is a class instance or needs custom cloning.
  // Plain structured-cloneable business objects use the built-in default.
  getSnapshot: () => store.getSnapshot(),
  subscribe: (listener) => store.subscribe(listener),
  async refresh({ signal }) {
    await store.refresh({ signal })
    // refresh publishes refreshing/ready/error snapshots through store
  },
  persistence: {
    mode: 'auto-save',
    debounceMs: 700,
    async commit(request) {
      const snapshot = await api.saveRows(request)
      store.publish(snapshot)
      return { operationId: request.operationId, applied: snapshot }
    },
  },
}

export function Editor() {
  return <DataGrid
    ariaLabel="Content"
    dataSource={dataSource}
    registry={registry}
  />
}
```

Every data-source snapshot is complete and versioned. A successful `commit`
must return a receipt containing the exact request operation ID and the
authoritative `ready` snapshot that applied that proposal. `getSnapshot()` may
still expose the request's source version while publication catches up, may
expose the receipt's applied version, or may already expose a causally later
authority. A third opaque version returned at receipt settlement is therefore a
data-source promise that it was published after `applied`; opaque version values
are never ordered by the controller. The controller acknowledges the receipt
first, ignores an exact stale request base, then rebases onto a causally later
snapshot when present. If settlement observed that stale base, the data source's
next publication must be `applied` or a causally later snapshot; it must not
publish the superseded base again. Reject with
`GridCommitError('source-version-conflict', message)` or
`GridCommitError('not-applied', message)` only when the write definitely did
not apply; transient and unknown-outcome failures retain the original operation
ID for an idempotent retry. The optional `refresh({ signal })` capability must
publish its own source snapshots and is aborted when the controller is
destroyed. Failed saves keep the draft. Cell types are explicitly registered, so value type,
column options, clipboard codecs, editor, filter, bulk and fill behaviors remain
one coherent capability. The package includes string, number, ISO-date and image
types, but none is special-cased by the grid.

`version` is an opaque authority token, not a row count or display revision. It
must change whenever authoritative row values or row order change; reusing one
version is allowed only for status/error metadata transitions over exactly the
same rows. Treat every published snapshot, its rows array, and the row values for
one version as immutable: mutating a previously published row in place while
reusing its version cannot be detected reliably. Rows are cloned before a setter
runs so an adapter cannot mutate the authoritative snapshot or history in place.
The default clone supports plain, structured-cloneable business data. Provide
`cloneRow(row)` for class instances or other rows whose runtime semantics require
a custom clone.

`DataGrid` keeps one controller per `dataSource` object while mounted. Switching
to another source and back preserves each source's draft, automatic save, and
in-flight write. For one source identity, keep `registry`, `rowHeight`,
`headerHeight`, and `rowIndicatorWidth` stable; changing those structural values
requires a new data-source identity. The optional `effects` port may change and
the existing controller always calls its latest implementation.

`maxMutations` and `maxClipboardBytes` are also fixed controller options on both
`createDataGridBinding(...)` and the owned `DataGrid` form. They default to
10,000 mutations per command and 2,000,000 clipboard bytes. Keep them stable for
one data-source identity; reopen the grid with a new identity to change them.

Host workflows that need to create rows and update multiple typed columns use
the React-free synchronous transaction boundary instead of dispatching a series
of cell commands:

```ts
const result = controller.applyTransaction((transaction) => {
  const rowKey = transaction.createRow()
  transaction.set(dataSource.columns[0]!, rowKey, 'Imported title')
}, { label: 'Import items' })

if (!result.accepted) {
  showIssues(result.issues)
}
```

`transaction.base` is the controller snapshot captured before the builder ran.
`createRow(position?)` stages a candidate from `dataSource.rows.create`;
`duplicateRow(sourceRowKey, position?)` uses `dataSource.rows.duplicate` so
hidden and read-only business fields are preserved; `moveRows(rowKeys,
position?)` packs the rows into one group in their current draft order; and
`deleteRows(rowKeys)` applies the data-source deletion policy to every target
before staging any deletion. Positions use `{ beforeRowKey }` in complete draft
order, never a filtered or sorted visible index; omission or `null` means append.
Moving and non-append creation/duplication require the data source to declare
`rows.ordering: 'mutable'`. Hosts should disable positional gestures while a
sorted or filtered view is active rather than infer persistence order from that
view. `set()` infers the value type from the configured column definition. A
cell may be set only once in one transaction. `transaction.abort(issue)` stops
the builder immediately. Builders must be synchronous; returning a Promise is
rejected.
Validation, row-key invariants, edit/filter/bulk session gates, mutation limits,
dirty tracking, history, and persistence all run before the staged draft is
published. Rejection publishes none of the staged rows or values; acceptance
creates at most one history entry and schedules persistence once. Row factories
should therefore be pure candidate factories: they may run before a later value
fails validation, even though that candidate is never published by the grid.
Atomicity is scoped to one controller. A cross-grid cut is two authoritative
operations: the host should accept the target insertion before deleting the
source, surface a partial outcome if the second controller rejects, and apply
domain-specific compensation when global all-or-nothing behavior is required.

For host-owned HTML row drag and drop, pass `rowDropZone` to `DataGrid`:

```tsx
const naturalOrder = selectGridNaturalRowOrder(controller.getSnapshot())

<DataGrid
  binding={binding}
  rowDropZone={{
    active: dragging && naturalOrder.eligible,
    onTargetChange(target) {
      dropTarget.current = target
    },
  }}
/>
```

`selectGridNaturalRowOrder(snapshot)` is eligible only when global filtering,
column filtering, and sorting are inactive; its `rowKeys` then follow complete
draft order. An active drop zone reports a `DataGridRowDropTarget` with
`visibleRowIndex`, `edge: 'before' | 'after' | 'end'`, and the canonical
`placement: { beforeRowKey }` accepted by a transaction. The grid owns only
scrollport hit testing, the default insertion marker, and optional vertical
auto-scroll (`autoScroll` defaults to `true`). It does not inspect or write
`DataTransfer`, call `preventDefault()`, accept a drop, validate a payload, or
choose Copy versus Cut. The host owns those decisions and may replace the
marker contents with `renderIndicator(target)`.

Every commit request contains the complete proposed rows in exact persistent
order. `orderChanged` reports persistent order intent relative to the current
authority/baseline. It can remain false when only pending appended inserts are
reordered, because those rows have no authoritative order yet. Regardless of
the flag, the data source must retain `request.rows` order while applying
append/delete/value changes. During ordinary remote rebase, explicit local
structural order is local-wins among surviving locally known rows, while
remote-only rows retain their authoritative slots. This first contract does
not invent an order conflict that the cell-oriented conflict UI cannot resolve.

Use `messages` for typed overrides of the built-in grid chrome, and
`surfaceRenderers` to replace the toolbar, footer, context menu, filter dialog,
bulk dialog, or feedback surface. Each renderer receives the already resolved
capability and eligibility model plus dispatch-safe callbacks; hosts do not
need to duplicate command rules. These overrides intentionally do not localize
domain validation, cell-type, or data-source messages, which remain owned by
their respective adapters. `messages.rejectedAction(reason)` is the single
React presentation boundary for rejected controller dispatches and defaults to
returning the reason unchanged. It presents the complete reason; it does not
translate fine-grained core codes. Context-menu actions also carry a stable
`group` value for custom surfaces. The built-in menu exposes that value through
`data-grid-menu-group` without adding visual separators or changing layout.
Default menu and dialog portals stay mounted under `document.body` to avoid
clipping, while inheriting the resolved `--grid-*` theme tokens from their grid
root.

When passing an external `binding`, the caller owns it and must call
`binding.destroy()` after the grid is permanently unmounted. One binding (and
therefore one controller) may drive only one mounted viewport at a time; create
separate bindings for simultaneous grids, even when they read the same source.
The owned `dataSource`/`registry` form manages this lifecycle automatically.

Import `react-data-grid-ext/engine` for the React-free data-source, cell behavior,
resolver, controller, state, selection, and persistence contracts. That subpath
does not export React components, views, registry factories, or hooks.

## Development

- `pnpm demo` — native v2 playground
- `pnpm demo:legacy` — archived `react-data-grid` implementation
- `pnpm check` — boundaries and TypeScript
- `pnpm check:package` — packed, isolated headless/type/browser consumers
- `pnpm test` — archived legacy regression suite during M1–M5 (`test:legacy` is an alias)
- `pnpm demo:legacy:test` — archived legacy browser regression
- `pnpm build` — package build and declarations

As of 2026-08-31, M1–M4 are technically complete and M5 is a test candidate
awaiting user acceptance. This status does not mean the M5 experience has been
accepted. Permanent v2 unit, integration and E2E regression work has not begun;
it remains intentionally deferred to M6 until the behavior is confirmed.

The current candidate has passed the repository boundary/type/lint/build checks,
an isolated packed-consumer check, an independent disposable core
counterexample audit, and a 13/13-group exploratory Chromium Playwright audit at
1440, 1920, 2560 and 3840 pixels on the latest stable snapshot before the final
chooser-session patch. The affected chooser and detached-edit surfaces then
passed a targeted 3/3 Chromium regression at 1440 with no console warning,
console error or page error; the other 12 groups and full width matrix were not
rerun after that patch. Safari, Firefox and real touch devices have not yet been
verified. See the dated evidence and exact milestone boundary in
[the v2 plan](docs/native-grid-v2-plan.md#2026-08-31-技术候选快照).

The legacy implementation remains under `src-legacy` only for comparison and
migration. Permanent v2 regression tests begin after interaction acceptance in
M6; until then v2 is verified with type/build/package checks and disposable
Playwright exploration. New consumers should use the API above.

The package is currently `UNLICENSED`; choose and document a license before
publishing it outside owner-controlled repositories.
