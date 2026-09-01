# data-editor-table

[![npm version](https://img.shields.io/npm/v/data-editor-table.svg)](https://www.npmjs.com/package/data-editor-table)
[![license](https://img.shields.io/npm/l/data-editor-table.svg)](./LICENSE)

A styled React bulk editor for business data. Applications provide an authoritative data source and define columns; the grid supplies standard cell types, selection, typed editing, validation, clipboard and fill operations, filtering, sorting, dirty/conflict handling, row operations, history, and persistence.

[Try the live demo](https://hitomi.github.io/data-editor-table/) or browse the
[source on GitHub](https://github.com/hitomi/data-editor-table).

## Core capabilities

- Cell, range, row, column, additive, and select-all selection
- Keyboard navigation, matrix copy/paste, clear, and drag-to-fill
- Typed editing, filtering, sorting, validation, and bulk editing
- Six default cell types plus an image factory: string, number, ISO date, single-select, multi-select, boolean, and application-owned image upload
- Dirty markers, original-value preview, revert, undo, redo, and conflict recovery
- Add, duplicate, protect, delete, and reorder rows
- Immediate, manual, or debounced automatic saving
- Styled toolbar, footer, dialogs, grouped context menu, and feedback surfaces
- React-free controller and engine for host workflows

The initial release renders the complete row set supplied by the data source, uses fixed row heights, and is not intended as a 100k-row client-side BigTable renderer.

## Install

```sh
pnpm add data-editor-table react react-dom
```

This source release is `0.3.0`.

Import the complete default styles once:

```ts
import 'data-editor-table/styles.css'
```

Import the grid stylesheet after framework resets such as Tailwind Preflight. The package uses
cascade layers so application overrides remain possible; importing a reset after the grid can
otherwise replace its button, border, and form-control defaults.

`styles.css` is the convenience entry point for `structure.css` plus the
default `theme.css`. It is not loaded by the JavaScript entry point, so every
application makes the styling choice explicitly.

React 19 is a peer dependency.

## Quick start

This example uses the remote adapter intended for API/database-backed applications. The adapter
keeps one stable external-store identity, exposes a typed change set to the write API, and publishes
the server's actual result back to the grid.

```tsx
import {
  DataGrid,
  GridCommitError,
  createGridColumnHelper,
  createGridIdempotencyHeaders,
  createRemoteGridDataSource,
  type StandardGridCellTypeSchema,
} from 'data-editor-table'
import 'data-editor-table/styles.css'

type Product = { id: string; name: string }

const column = createGridColumnHelper<Product>()

const dataSource = createRemoteGridDataSource<Product, string, StandardGridCellTypeSchema>({
  columns: [column.field('name', {
    label: 'Name',
    type: 'string',
    layout: { basis: 280, min: 180, flex: 1 },
    sortable: true,
    filterable: true,
    bulkEditable: true,
  })],
  getRowKey: (row) => row.id,
  // Usually supplied by a route loader, server component, or query cache.
  initialSnapshot: {
    rows: [
      { id: 'product-1', name: 'Amber poster' },
      { id: 'product-2', name: 'Blue card' },
    ],
    status: 'ready',
    version: 'products:41',
    scope: { kind: 'complete' },
  },
  async load({ signal }) {
    const response = await fetch('/api/products', { signal })
    if (!response.ok) throw new Error('Products could not be loaded.')
    return response.json() as Promise<{
      rows: readonly Product[]
      version: string
    }>
  },
  persistence: {
    mode: 'auto-save',
    debounceMs: 500,
    async mutate(request) {
      let response: Response
      try {
        response = await fetch('/api/products/grid-changes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...createGridIdempotencyHeaders(request.operationId),
          },
          body: JSON.stringify({
            operationId: request.operationId,
            sourceVersion: request.sourceVersion,
            changes: request.changes,
          }),
        })
      } catch {
        throw new GridCommitError(
          'unknown-outcome',
          'The connection was lost while saving. Retry the same operation.',
        )
      }
      if (response.status === 409) {
        throw new GridCommitError(
          'source-version-conflict',
          'Products changed on the server. Refresh and review the conflicts.',
        )
      }
      if (!response.ok) {
        throw new GridCommitError(
          'unknown-outcome',
          'The server did not confirm whether the changes were saved.',
        )
      }
      const result = await response.json() as {
        rows: readonly Product[]
        version: string
        keyRemap?: readonly { from: string; to: string }[]
      }
      return {
        kind: 'applied',
        authority: { rows: result.rows, version: result.version },
        ...(result.keyRemap ? { keyRemap: result.keyRemap } : {}),
      }
    },
  },
})

export function ProductEditor() {
  return <div style={{ height: 480, minWidth: 0 }}>
    <DataGrid ariaLabel="Products" dataSource={dataSource} />
  </div>
}
```

`DataGrid` fills its host, so the host needs an explicit height or a layout that supplies one. The owned form above manages controller lifecycle automatically.

## Data-source and column contract

The data source is an external-store boundary: authoritative snapshot → local draft → commit request → published authoritative snapshot.

Practical rules:

1. Return the complete currently loaded rows from `getSnapshot`; notify subscribers for every publication.
2. Keep the `dataSource` object identity stable for one logical data set. Its registry, locale, and sizing options remain fixed for that identity. The owned `DataGrid` preserves bindings that still have edits or in-progress work when the identity changes, and releases inactive clean bindings.
3. `getRowKey` must produce a unique, stable string or number.
4. Treat every published snapshot, rows array, and row value as immutable. Setters return new rows.
5. `version` is an opaque token. Change it whenever authoritative values or persistent order change; never compare versions by magnitude.
6. A successful `commit` returns the request's exact `operationId` and the exact applied `ready` snapshot. Publish it, or a causally later snapshot, through the store.
7. Reject failed writes. The grid retains the draft and exposes retry/recovery.

Snapshots distinguish `loading`, `refreshing`, `ready`, and `error` (`error` also requires a user-facing `error` string). Optional `refresh({ signal })` starts a host refresh and publishes its result. Supply `cloneRow(row)` for class instances or other rows that cannot use structured cloning.

### Remote API and database writes

`createRemoteGridDataSource` is the standard adapter for remote state. It intentionally does not
depend on TanStack Query, SWR, GraphQL, REST, or a database client. Keep the returned object stable;
publish route/query-cache state with `dataSource.publish(snapshot)`, or provide `load` so Refresh
and post-mutation reloads can read the authority.

Every `GridCommitRequest` contains both representations of the same accepted proposal:

- `rows`: the complete proposed authority in persistent order, useful for document replacement APIs.
- `changes.inserted`: new typed rows and their temporary client keys.
- `changes.updated`: the original row, proposed row, and changed cells with before/after values.
- `changes.deleted`: deleted keys and original rows.
- `changes.order`: the before/after key order when persistent order changed.

Apply `changes` in one database transaction using `sourceVersion` for optimistic concurrency. Forward
`operationId` through every layer (the helper produces the conventional `Idempotency-Key` HTTP
header), and enforce a unique operation ID in the database or operation ledger. Repeating the same
ID must return the first operation's result instead of applying the writes again.

After a successful mutation, return one of:

- `{ kind: 'applied', authority }` when the write endpoint returns the exact stored rows and new
  version. This preserves server defaults, normalization, triggers, calculated values, and permissions.
- `{ kind: 'reload' }` when the adapter should call `load` and wait for the exact stored authority.

Do not construct a success result from `request.rows` unless those rows are literally the database
result. If the server replaces a temporary key, include `keyRemap: [{ from, to }]`; queued edits,
selection, active editing, dirty state, and history are reconciled onto the authoritative key.

A column maps a registered type to business data:

```ts
{
  key: 'quantity', label: 'Quantity', type: 'number',
  typeOptions: { minimum: 0, format: { maximumFractionDigits: 0 } },
  layout: { basis: 140, min: 100, max: 220, flex: 1 },
  sortable: true, filterable: true, bulkEditable: true,
  getValue: (row) => row.quantity,
  setValue: (row, quantity) => ({ ...row, quantity }),
  isEditable: (row) => !row.locked,
}
```

Omit `setValue` for a read-only column. `isEditable` is a per-row gate. Optional `validate` adds domain validation. A flag such as `sortable` only exposes a capability implemented by that type. `typeOptions` are type-checked against the registered type.

For direct fields, `createGridColumnHelper` removes `key`, `getValue`, and `setValue`. Helper fields
are editable by default; pass `editable: false` or a predicate to restrict editing. Derived columns
can continue to use the explicit form above.

## Built-in cell types

`DataGrid`, `createDataGridBinding`, and `useDataGridBinding` use
`createStandardCellTypeRegistry()` when `registry` is omitted. It contains `string`, `number`,
`date`, `boolean`, `singleSelect`, and `multiSelect`. Select catalogs belong to columns, so one type
supports every select field without creating names such as `status`, `category`, or `tags`.

```tsx
const column = createGridColumnHelper<Product>()

const columns = [
  column.field('status', {
    label: 'Status',
    type: 'singleSelect',
    options: [
      { value: 'draft', label: 'Draft' },
      { value: 'ready', label: 'Ready' },
      { value: 'archived', label: 'Archived', disabled: true },
    ],
    sortable: true,
    filterable: true,
  }),
  column.field('tags', {
    label: 'Tags',
    type: 'multiSelect',
    options: [
      { value: 'featured', label: 'Featured' },
      { value: 'wholesale', label: 'Wholesale' },
    ],
    bulkEditable: true,
  }),
]

const registry = createStandardCellTypeRegistry<Product>()
  .replace('boolean', createBooleanCellType({
    trueLabel: 'Active',
    falseLabel: 'Inactive',
  }))
```

You normally do not create `registry` at all. Pass the customized registry only when adding a type
or replacing a standard implementation. `register` rejects an existing name; `replace` requires an
existing name, which makes accidental overrides explicit.

| Factory | Value | Included behavior |
| --- | --- | --- |
| `createStringCellType` | `string` | Edit, clipboard, clear, sort, text filters, set/affix/replace bulk edit |
| `createNumberCellType` | `number` or `number \| null` | Edit, range validation, clipboard, clear, series fill, sort, numeric filters, bulk set |
| `createDateCellType` | ISO date string (optionally empty/null) | Edit, clipboard, clear, source-sequence repeat fill, sort, date filters, bulk set |
| `createImageCellType` | Application value or `null` | Preview, active-cell click/drag upload, clipboard format/optional parse, clear, fill, presence filters, remove action |
| `createSingleSelectCellType` | An option's `string`/`number` value, optionally `null` | Native select editing, label/value clipboard parsing, sort, choice filters, bulk set |
| `createMultiSelectCellType` | `readonly (string \| number)[]` | Responsive tags, checklist editing, CSV clipboard, set-style equality, choice filters, replace/add/remove bulk edit |
| `createBooleanCellType` | `boolean` | Checkbox display, keyboard toggle, TRUE/FALSE clipboard, filters and mixed-state bulk edit |

Choice columns receive a static option catalog. Values store option IDs rather than display objects.
The helper infers the exact option value union from the row field, so a status column cannot list an
option that its field cannot store. Multi-select values are canonicalized to catalog order, so selecting the same tags in a
different order does not create a change. A disabled option remains valid and filterable for
existing data, but cannot be newly selected or pasted; an existing disabled tag can still be
removed. Pass `emptyValue: null` to make a single-select nullable. Boolean cells expose Clear only
when `clearValue` is explicitly configured.

- Single-select stores one option ID, supports an explicitly nullable variant, and uses the option
  label for display, search, clipboard, filtering, and original-value previews.
- Multi-select stores a set-like readonly array of option IDs. Editing, paste, fill, and bulk changes
  canonicalize the array to catalog order; bulk edit can replace, add, or remove tags.
- Boolean stores a strict `boolean`, displays a checkbox, accepts `TRUE`/`FALSE` clipboard values,
  and represents mixed bulk selections only in the editor draft—not in row data.

Option catalogs are intentionally synchronous and column-scoped. Loading, caching, and invalidation
for asynchronous or row-dependent options belong in application state or a custom registered type.

Image storage and upload belong to the application:

```tsx
const imageType = createImageCellType<Product, string>({
  alt: (row) => row.name,
  label: () => 'Add or replace image',
  resolveSrc: (value) => value,
  validate: (value) => typeof value === 'string' && /^https?:\/\//.test(value)
    ? { ok: true, value }
    : { ok: false, issue: { code: 'invalid-image-url', message: 'Choose a valid uploaded image.' } },
  async upload({ file, signal }) {
    const body = new FormData()
    body.append('file', file)
    const response = await fetch('/api/uploads', { method: 'POST', body, signal })
    if (!response.ok) throw new Error('Upload failed')
    return (await response.json() as { url: string }).url
  },
  parseClipboard: (text) => /^https?:\/\//.test(text)
    ? { ok: true, value: text }
    : { ok: false, issue: { code: 'invalid-image-url', message: 'Paste a valid image URL.' } },
})

const registry = createStandardCellTypeRegistry<Product>()
  .register('image', imageType)
```

`accept` and `maxBytes` may be set on the factory or column. Upload receives an abort signal.

## Saving and errors

| Mode | Behavior |
| --- | --- |
| `'immediate'` | Schedule a commit as soon as an accepted change can persist |
| `'manual-save'` | Keep a draft until **Save changes** |
| `'auto-save'` | Commit after `debounceMs` without a newer change |

The controller can change this with `persistence/set-mode`. Use
`GridCommitError` to classify the failure and select the correct recovery path:

```ts
throw new GridCommitError('transient', 'The service is temporarily unavailable.')
```

- `transient`: a retryable transport or service failure. The grid retains the
  proposal and reuses its operation ID when retrying.
- `unknown-outcome`: the client cannot determine whether the write applied. The
  grid retains the proposal and reuses its operation ID when retrying.
- `source-version-conflict`: the write definitively did not apply because its
  source version is stale.
- `not-applied`: the write definitively did not apply for another authoritative
  reason.

Both `transient` and `unknown-outcome` require an idempotent commit implementation
because a retry uses the original operation ID. Use `source-version-conflict` or
`not-applied` only when the server guarantees non-application. Ordinary errors
also preserve the draft. Every commit contains the complete proposed rows in
persistent order, which the data source must retain. Detailed settlement and
rebase rules are in the [native grid v2 plan](docs/native-grid-v2-plan.md).

## Row operations and protected rows

```ts
rows: {
  create: () => ({ id: crypto.randomUUID(), name: 'Untitled', locked: false }),
  duplicate: (row) => ({ ...row, id: crypto.randomUUID(), name: `${row.name} copy` }),
  canDelete: (row) => !row.locked,
  ordering: 'mutable',
}
```

`create` enables Add row; `duplicate` enables single/multi-row duplication and should preserve hidden business fields; `canDelete` protects rows from deletion. Combine it with `column.isEditable` for read-only protected rows. `ordering: 'mutable'` declares that commit persists row order and enables non-append placement/movement. Multi-row operations reject atomically if any target is ineligible.

## Built-in interactions

- Drag cells to select; Shift extends and Ctrl/Command adds ranges. Row indicators, headers, and the corner select rows, columns, or all visible cells.
- Clicking the already-active single cell, Enter, F2, or printable input edits when the type allows it.
- Copy/paste, clear, bulk edit, and fill validate every destination through its type. Fill repeats the source sequence unless the type supplies series behavior.
- Header buttons filter and sort; clicking the header selects the column.
- Dirty markers preview the original value and offer Revert. Selection/row revert, undo/redo, conflicts, and retry are available where applicable.
- The grouped context menu includes applicable toolbar, row, selection, persistence, type-specific, revert, and conflict actions.

Filtering/sorting are local view changes over loaded rows and do not change persistent order.

## Custom cell types

All types use the same registry path. This minimal editable rating uses the real behavior/view pairing:

```tsx
const ratingType = defineCellType<Product, number, string>({
  behavior: {
    value: { validate: (value) => typeof value === 'number' && value >= 1 && value <= 5
      ? { ok: true, value }
      : { ok: false, issue: { code: 'invalid-rating', message: 'Rating must be from 1 to 5.' } } },
    text: { display: (value) => `${value} / 5`, original: String },
    edit: {
      begin: String,
      commit: (draft) => {
        const value = Number(draft)
        return Number.isInteger(value) && value >= 1 && value <= 5
          ? { ok: true, value }
          : { ok: false, issue: { code: 'invalid-rating', message: 'Rating must be from 1 to 5.' } }
      },
    },
    clipboard: { format: String },
    compare: (left, right) => left - right,
  },
  view: {
    Cell: ({ displayText }) => <span>{displayText}</span>,
    Editor: ({ draft, setDraft, commit, cancel }) => <input
      aria-label="Rating" autoFocus inputMode="numeric" value={draft}
      onChange={(event) => { setDraft(event.currentTarget.value) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') cancel()
      }}
    />,
    presentation: { content: 'padded', align: 'end', editActivation: ['active-cell-click', 'enter', 'f2', 'printable'] },
  },
})

const registry = createCellTypeRegistry<Product>().register('rating', ratingType)
```

Import `defineCellType` from the package root. Every definition needs `behavior.value.validate`, `behavior.text.display`, `view.Cell`, and `view.presentation`. `behavior.edit`/`view.Editor` and `behavior.bulk`/`view.BulkEditor` must appear in pairs. Optional `search`, `original`, `equals`, `clipboard`, `clear`, `fill`, `compare`, `filter`, `bulk`, `actions`, and cancellable `effects` add capabilities without grid special cases.

## Messages, surfaces, and theme

The package is i18n-library agnostic and includes complete English defaults plus the exported
`zhCN` locale. Set the locale once on `DataGrid` or a binding; it applies to the grid shell and every
standard cell type, including `Intl` collation and formatting. Function-valued messages receive
values such as row, cell, or byte counts.

```tsx
import { zhCN } from 'data-editor-table/locales/zh-CN'

<DataGrid
  ariaLabel="商品"
  dataSource={dataSource}
  locale={zhCN}
/>
```

For advanced binding ownership, pass the same value to
`useDataGridBinding({ dataSource, locale: zhCN })`; `<DataGrid binding={binding} />` then inherits it.
`DataGrid.messages` and each factory's `messages` remain typed escape hatches for partial overrides,
with explicit overrides taking precedence over the locale pack.

The exported `DataGridMessages`, `GridStringCellTypeMessages`,
`GridNumberCellTypeMessages`, `GridIsoDateCellTypeMessages`,
`GridImageCellTypeMessages`, `GridSingleSelectCellTypeMessages`,
`GridMultiSelectCellTypeMessages`, and `GridBooleanCellTypeMessages` types can be used to author
shared locale packs. Column labels, choice labels, image labels, application validation messages,
data-source errors, and custom cell-type copy remain application-owned and should use the same
locale.

`surfaceRenderers` can replace toolbar, footer, context menu, filter dialog, bulk dialog, or
feedback while receiving resolved state and safe callbacks. `toolbarActions` and
`rowHeaderActions` add host actions without replacing defaults.

Override semantic variables on the `DataGrid` root through its `className`:

```css
.inventory-grid {
  --grid-surface: #fff;
  --grid-subtle-surface: #f8fafc;
  --grid-text: #172033;
  --grid-muted: #68758a;
  --grid-border: #d8deea;
  --grid-accent: #2563eb;
  --grid-accent-soft: #dbeafe;
  --grid-dirty: #f59e0b;
  --grid-invalid: #dc2626;
  --grid-conflict: #c2410c;
  --grid-radius: 8px;
}
```

Pass `className="inventory-grid"`. If an application stylesheet must target a
grid from outside, use a descendant selector with enough specificity to override
the component defaults rather than relying on inheritance from an ordinary
ancestor. Body portals inherit the values resolved on their grid root.

### Tailwind CSS

Tailwind applications can load only the layout and interaction contract, then
own all visual styling. Import the structural stylesheet before Tailwind so the
application layers have precedence:

```css
@import 'data-editor-table/structure.css';
@import 'tailwindcss';

@layer components {
  .inventory-grid {
    @apply rounded-lg border border-slate-300 bg-white text-sm text-slate-900;
  }

  .inventory-grid :is(
    .business-grid__toolbar,
    .business-grid__footer,
    .business-grid__corner,
    .business-grid__column-header,
    .business-grid__row-indicator,
    .business-grid__cell
  ) {
    @apply border-slate-200 bg-white;
  }

  .inventory-grid :is(
    .business-grid__corner,
    .business-grid__column-header,
    .business-grid__row-indicator
  ) {
    @apply bg-slate-50;
  }

  .inventory-grid .business-grid__button {
    @apply rounded-md border-slate-300 bg-white px-2.5 hover:bg-slate-50;
  }

  .inventory-grid .business-grid__button--primary {
    @apply border-blue-600 bg-blue-600 text-white hover:bg-blue-700;
  }

  :is(
    .business-grid-menu,
    .business-grid-dialog,
    .business-grid-cell-editor-popover,
    .business-grid-dirty-popover
  ) {
    @apply rounded-lg border border-slate-200 bg-white text-slate-900 shadow-xl;
  }
}
```

The example uses Tailwind CSS v4. With v3, keep the `structure.css` import first
and place the `@tailwind base`, `components`, and `utilities` directives after it.

Pass `className="inventory-grid"` to the grid. The structural stylesheet keeps
grid geometry, scrolling, sticky headers, editor placement, hit targets, and
accessibility utilities while leaving visual appearance to the application.
Use the existing `business-grid__*` and `data-grid-*` classes for Tailwind
`@apply` rules, and
remember that menus, dialogs, and editor popovers render in a body portal and
therefore need their global component classes styled as shown above.

## Advanced integration

Use `useDataGridBinding` when React host UI needs direct controller access. It creates and destroys
the binding after React commits, including the development StrictMode setup/cleanup cycle; `null`
is returned until the binding is ready.

```tsx
function ProductGrid() {
  const binding = useDataGridBinding({ dataSource })
  if (!binding) return <div role="status">Preparing products…</div>
  return <DataGrid ariaLabel="Products" binding={binding} />
}
```

Use `createDataGridBinding({ dataSource })` only outside React lifecycle ownership and call
`binding.destroy()` after permanent disposal. One binding drives only one mounted viewport.
`useGridSelector` subscribes host components to controller state. The simpler
`<DataGrid dataSource={dataSource} />` form owns this lifecycle automatically. Add `registry` to any
of these forms only when the data source uses a custom or replaced type.

Import React-free data-source, resolver, selection, controller, and persistence contracts from `data-editor-table/engine`; that subpath does not export React views, registries, or hooks.

Atomic host imports use a synchronous transaction:

```ts
const result = binding.controller.applyTransaction((transaction) => {
  const rowKey = transaction.createRow()
  transaction.set(dataSource.columns[0]!, rowKey, 'Imported product')
}, { label: 'Import products' })
if (!result.accepted) showIssues(result.issues)
```

Transactions also provide `duplicateRow`, `moveRows`, `deleteRows`, and `abort`; they are all-or-nothing. Placement uses `{ beforeRowKey }` in complete draft order, never a filtered/sorted visible index.

For row drag/drop, pass `rowDropZone={{ active, onTargetChange }}`. Targets provide a canonical `{ beforeRowKey }` placement. The grid owns hit testing, marker, and optional auto-scroll; the host owns `DataTransfer`, validation, Copy/Cut, acceptance, and transaction. Disable positional gestures when `selectGridNaturalRowOrder(snapshot).eligible` is false.

## Demo recipes

Run `pnpm demo` and use:

- [Playground](demo/src/playground.tsx): built-in types, selection, row operations, save modes, failures, remote changes, dirty state, and conflicts
- [Multi-image import](demo/src/multi-image-import.tsx): drop multiple images, populate image/filename columns, and create rows
- [Cross-grid drag](demo/src/cross-grid-drag.tsx): Copy/Cut between grids and reorder within one grid

Demos are integration recipes, not additional API contracts.

## Entry points

- `data-editor-table`: React grid, types, registry, controller, and public contracts
- `data-editor-table/engine`: React-free engine
- `data-editor-table/locales/zh-CN`: complete Simplified Chinese messages
- `data-editor-table/styles.css`: structure plus the default theme
- `data-editor-table/structure.css`: behavior-critical layout for Tailwind or custom themes
- `data-editor-table/theme.css`: default visual theme (loaded after `structure.css`)

## Limits and status

`0.3.0` is an early public test release. It is suitable for integration testing, but its API may
still change before `1.0` as real applications exercise the data-source and editing contracts.

- Snapshots currently contain one complete loaded set; there is no pagination/window protocol or row virtualization.
- Rows have fixed height. Interactive column resize, arbitrary frozen columns, and persisted column layout are not in the initial release.
- Cross-grid Cut is two controller operations, not a globally atomic transaction.
- The native implementation is the only production path; legacy and `react-data-grid` were removed.
- The package is being exercised in real business workflows before the next public release.

See the [native grid v2 plan](docs/native-grid-v2-plan.md) for rationale, detailed concurrency rules, milestones, and acceptance notes.

## Development

This repository uses Node.js 22 or newer and pnpm.

```sh
pnpm install
pnpm demo
pnpm check
pnpm lint
pnpm build
pnpm demo:build
pnpm check:package
```

`pnpm check` validates boundaries and TypeScript. `pnpm check:package` packs the package and checks isolated headless, type, and browser consumers.

## License

MIT. See [LICENSE](./LICENSE).
