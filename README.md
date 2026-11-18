# data-editor-table

[![npm version](https://img.shields.io/npm/v/data-editor-table.svg)](https://www.npmjs.com/package/data-editor-table)
[![license](https://img.shields.io/npm/l/data-editor-table.svg)](./LICENSE)

A styled React bulk editor for business data. Applications provide an authoritative data source and define columns; the grid supplies standard cell types, selection, typed editing, validation, clipboard and fill operations, filtering, sorting, dirty/conflict handling, row operations, history, and persistence.

[Try the live demo](https://hitomi.github.io/data-editor-table/) or browse the
[source on GitHub](https://github.com/hitomi/data-editor-table).

The [acceptance contract](docs/public-acceptance-contract.md) covers operation targets, save confirmation, and action availability across entry points, with eight regression scenarios.

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

The package metadata remains at the restored `0.3.1` baseline while this unreleased refactor is reviewed.

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

This branch keeps the 0.3.1 table and editors and changes the data protocol. It is an
unreleased refactor awaiting functional acceptance; the package version is not a release claim.

The host supplies a `PersistenceSource` backed by actual versioned authority, atomic writes,
and operation lookup. The complete browser example is in
[`demo/src/demo-data-source.ts`](demo/src/demo-data-source.ts) and
[`demo/src/demo-source.ts`](demo/src/demo-source.ts); its authority is IndexedDB.

```tsx
import {
  DataGrid, createGridColumnHelper, createFieldGridDocumentModel,
  createRemoteGridDataSource,
} from 'data-editor-table'
import type { PersistenceSource, ScopeIdentity } from 'data-editor-table/protocol'
import 'data-editor-table/styles.css'

type Product = { id: string; name: string }
const column = createGridColumnHelper<Product>()
const columns = [column.field('name', {
  label: 'Name', type: 'string',
  layout: { basis: 280, min: 180, flex: 1 },
  sortable: true, filterable: true, bulkEditable: true,
})]

// Call once per logical data set, outside render or in a stable host owner.
export function createProductDataSource(source: PersistenceSource, scope: ScopeIdentity) {
  return createRemoteGridDataSource({
    columns,
    getRowKey: (row: Product) => row.id,
    model: { ...createFieldGridDocumentModel(columns), identityPath: ['id'] },
    source, scope,
    persistence: { mode: 'auto-save', debounceMs: 500 },
  })
}

export function ProductEditor({ dataSource }: {
  dataSource: ReturnType<typeof createProductDataSource>
}) {
  return <div style={{ height: 480, minWidth: 0 }}>
    <DataGrid ariaLabel="Products" dataSource={dataSource} />
  </div>
}
```

`DataGrid` fills its host, so supply a height. It starts an authority read on attachment;
optional `initialAuthority` supplies already loaded, complete server evidence. Loading and
read failure never substitute an empty array for an unknown authority.

## Data-source and column contract

The data path is authority + immutable operations → derived rows → frozen submission → exact
receipt. `snapshot.draft` is a read model. It must not be used to rebuild history or acknowledge saves.

- Keep the `dataSource` identity stable for one editing instance and its creation settings.
- `scope` identifies the physical source, data scope, and epoch. Sources wrapping the same backend
  use the same source ID; independent grids use independent scopes and retain independent history.
- `getRowKey` returns a string or finite number, matching the server row identity. Internal entity
  identities survive an exact creation receipt assigning a different key. Declare `identityPath`
  only for the actual document primary-key field; it permits proven key normalization in task
  and bulk-session dependencies, not arbitrary row retargeting.
- `model.codec` owns complete rows. The plain codec accepts lossless encoded objects; custom classes,
  dates, or other special values require explicit `copy/equals/encode/decode` methods and versions.
  Callbacks must be pure; public projected rows and their nested values are read-only.
- Each writable column binds explicit storage fields. `column.field(...)` records `storagePath`;
  `createFieldGridDocumentModel` compiles those paths. Custom getters/setters need an explicit
  `GridDocumentModel`. Aliases share field IDs; composite setters declare their complete write domain.
- An ordinary `column.field('name', …)` edit compares the stored `name` field. A concurrent
  change to `count` survives that edit. A custom `planEdit` can record additional dependencies
  with `context.read(path)`. Column `validate(value)` adds no row dependency.
  `validateWithRow(value, row)`, a custom setter, or row-dependent editability requires whole-row review
  after a concurrent row change. If both column validators are present, the row validator receives the
  value accepted by the scalar validator. Commands, editors,
  paste and transactions use the same authoring rules. Refresh replays the recorded writes.
- Editor and bulk raw inputs are separate from parsed values. Custom draft structures can supply
  `inputCodec`; a custom cell value can supply the binding's `valueCodec`. Codec rejection retains
  the active input. A synchronous accepted command means local acceptance, not remote durability.
  Clipboard parsers and editor callbacks produce concrete input values. Put a business calculation
  that must stay valid through save in `planEdit` and read its source fields with `context.read`.

### Remote API and database writes

`createRemoteGridDataSource({ source, scope, model, columns, getRowKey, persistence })` binds a real
protocol. Pass the host's push subscription in the factory's optional `subscribe` option,
or call `publish(authority)` to deliver complete, versioned server snapshots.

All adapters with the same physical source ID, scope ID and epoch share one snapshot stream.
Seeds, pushes and read responses pass through the same admission checks. Each controller
calls `dataSource.subscribe(listener)` to receive the current snapshot, any outstanding
frontier and subsequent updates. This includes snapshots from its own superseded requests.
`dataSource.readAtLeast(frontier)` acknowledges the admitted version after delivery.
`dataSource.getSnapshot()` returns the last usable complete snapshot for offline display.
A response covering its original request contributes causal evidence even when another branch
arrived in flight. Concurrent branches trigger a shared covering read. A merged snapshot must
respect row incarnations retired on any of its predecessor branches. Replaying a pending branch
retries a failed read, including after all tables have been closed and reopened.

The scope also validates exact receipt versions against that same history. For example, a
receipt for C that covers B can confirm a write based on A once the scope knows that B covers A.
The intermediate snapshot may arrive before or after the receipt. With ordered versions, if
versions 1 and 3 contain the same incarnation, a late complete version 2 must also contain it.
Exact receipts pass the same row decoder and primary-key checks as snapshots before admission.
A rejected document leaves the version available for a corrected delivery. An admitted receipt
advances the required read frontier for every live subscriber. A peer can complete the covering
read over its own connection if the writer is offline. Later subscribers receive the same
requirement or a complete snapshot that already covers it.

`PersistenceSource` implements:

| Method | Required result |
| --- | --- |
| `readAtLeast(scope, frontier)` | Complete `ServerAuthority` covering the requested ordered/causal frontier |
| `submit(FrozenSubmission)` | Exact applied receipt, confirmed application without a receipt, pending/unknown, or definitive not-applied proof |
| `lookupOperation(SubmissionRef)` | Original operation outcome; an absent lookup needs a durable negative fence before claiming not-applied |

The backend atomically applies `items` with `baseAuthority`, persists the operation ID and payload
hash with its outcome, and returns the same outcome for a repeated ID/hash. Items are explicit
create/update/delete/order requests; `coverage` identifies precisely which local contributions are
included. `hashSubmission` hashes the complete frozen envelope. HTTP adapters can use
`createGridIdempotencyHeaders(submission.operationId)`, but an HTTP header alone provides no
idempotency guarantee.

Applied results contain an `ExactReceipt` with the same scope, operation ID/hash, committed version,
and exact item results including canonical documents and created identities. A receipt is not
constructed from proposed UI rows. `applied-without-receipt` retains its commit token and performs
operation lookup. Unknown outcomes retain the same frozen operation; later edits remain separate.
Read failure after a confirmed commit cannot start a new write. A definitive not-applied proof
allows a new reviewed submission. Older authority cannot replace a newer accepted version.

See [the protocol and migration guide](docs/persistence-consistency.md) for result types, lifecycle,
and the guarantees expected from the server.

A column maps a registered type to business data:

```ts
{
  key: 'quantity', storagePath: ['quantity'], label: 'Quantity', type: 'number',
  typeOptions: { minimum: 0, format: { maximumFractionDigits: 0 } },
  layout: { basis: 140, min: 100, max: 220, flex: 1 },
  sortable: true, filterable: true, bulkEditable: true,
  getValue: (row) => row.quantity,
  setValue: (row, quantity) => ({ ...row, quantity }),
  isEditable: (row) => !row.locked,
}
```

Omit `setValue` for a read-only column. `isEditable` is a per-row gate. Use `validate` for a scalar rule and `validateWithRow` for a rule that depends on row context. A flag such as `sortable` only exposes a capability implemented by that type. `typeOptions` are type-checked against the registered type.

`isEditable` checks each new edit against the row including preceding local changes,
so unlocking and editing a row can be saved together. Locking it again rejects new
edits without cancelling earlier accepted work. Permanent storage restrictions use
the document model's `fields[].readonly`; the source must enforce server permissions.

For direct fields, `createGridColumnHelper` removes `key`, `getValue`, and `setValue`. Helper fields
are editable by default; pass `editable: false` or a predicate to restrict editing. Derived columns
can continue to use the explicit form above.

## Built-in cell types

`DataGrid`, `createDataGridBinding`, and `useDataGridBinding` use
`createStandardCellTypeRegistry()` when `initial.registry` is omitted. It contains `string`, `number`,
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
| `createBooleanCellType` | `boolean` | Checkbox toggle, explicit single-cell editing, TRUE/FALSE clipboard, filters and mixed-state bulk edit |

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
  Clicking the checkbox toggles its value. Edit cell, Enter, F2, or Space opens an editor at the
  current value; only Apply commits its draft. Shift/Ctrl/Cmd selection does not toggle values.

Option catalogs are intentionally synchronous and column-scoped. Loading, caching, and invalidation
for asynchronous or row-dependent options belong in application state or a custom registered type.

Image storage and upload belong to the application:

```tsx
// Use validateWithRow(value, row) instead for a row-dependent image policy.
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

An explicit auto-save interval must be an integer from 0 to 2,147,483,647 milliseconds. Binding creation rejects an invalid interval before starting the source.

The controller can change this with `persistence/set-mode`. Local command acceptance does not
confirm a write. Await the operation that owns the frozen request:

```ts
const result = await binding.controller.save()
if (result.status === 'confirmed' || result.status === 'no-changes') {
  if (binding.controller.getCloseState().status === 'ready') navigateAway()
} else if (result.status === 'recovery-required') {
  showRecovery(result.recovery, result.issue.message)
} else if (result.status === 'partial') {
  showIssues(result.excluded)
} else {
  showError(result.issue.message)
}

// Use the descriptor for the original unresolved operation, not a new save.
const { recoverSave } = selectGridActions(binding.controller.getSnapshot())
if (recoverSave.enabled && recoverSave.target) {
  const recovered = await binding.controller.recoverSave(recoverSave.target)
  showSaveOutcome(recovered)
}

const refreshed = await binding.controller.refresh()
if (refreshed.status === 'failed' || refreshed.status === 'blocked') {
  showError(refreshed.issue.message)
}
```

`save()` returns `GridSaveResult` with `remaining` close blockers and one of:

- `no-changes`: nothing needs a write; conflicts do not count as no changes.
- `confirmed`: the original operation has an exact receipt and its required authority read has settled.
- `partial`: that operation is confirmed, with exclusions captured when the request froze.
- `blocked`: no new write started; inspect its typed issue.
- `failed`: preparation failed before sending, or a definitive not-applied proof was accepted.
- `recovery-required`: the original write is unknown, or is applied but needs receipt/read/review recovery.

Concurrent saves return `save-in-progress` before committing another active editor. Ordinary save
does not resend an unresolved operation or automatically queue another call. Changes before freeze
may join the request; changes after freeze remain local work. A confirmed result identifies that
one operation, even if a later automatic save has already started.

Pass the current recovery action’s `target` to `recoverSave`. Both its operation ID and
its action must match. **Review** acknowledges the malformed receipt. Read the next descriptor
and present **Confirm** to look up the original write, or **Refresh** to finish its read barrier.
Each step requires its own action. Only a fenced, still-unknown operation can be resubmitted,
using its original ID, hash and bytes. Contradictory accepted facts block recovery and keep the
operation available for investigation. A transport exception leaves the outcome unknown.

Custom toolbars and hosts import `selectGridActions` from the package root or engine. Render
`save.enabled`, `retrySave.enabled` and `recoverSave.enabled` and use the corresponding
`issue` for the reason. A delayed callback passes its captured `save.target` or
`retrySave.target` to `controller.save(target)`. The controller rechecks the decision before
committing the active editor. A fresh synchronous host action can call `controller.save()`.
Use `getCloseState()` for navigation.

**Disputed scope.** Queries already sent for an operation stay associated with it until they
finish in this process, including after the originating grid closes or another save starts.
Contradictory evidence blocks new writes across every adapter sharing that physical scope and
epoch. The visible `snapshot.persistence.dispute` identifies an open dispute. Subscribe with
`remote.subscribeDisputes(listener)` for the full evidence and resolution events. Existing open
disputes are replayed on subscription. The host verifies each case against its authoritative
operation ledger before explicitly resolving it:

```ts
const dispute = remote.getDispute() // or remote.getDispute(id)
if (dispute) {
  const verified = await verifyAgainstServerLedger(dispute.ref, dispute.evidence)
  remote.resolveDispute(dispute.id, verified)
}
```

Here `verifyAgainstServerLedger` is supplied by the host. It returns a verified exact applied
receipt or a fenced not-applied proof matching the scope, operation ID and payload hash.
New incompatible evidence invalidates the old dispute ID. Resolve each open dispute separately.
A decision reversing an already retained terminal fact requires a verified new authority epoch
and reconciliation of dependent local work. Refresh and remount preserve the dispute. In-process
tracking ends at restart. The backend’s `operationRetentionMs` is its own ledger retention period.

`refresh()` returns `refreshed`, `superseded`, `blocked`, or `failed`. A newer read supersedes the
earlier call; old authority cannot replace accepted newer data. Rows and input remain available
after failure. Refreshing an ambiguous creation cannot substitute for its exact write confirmation.
The [public API contract](docs/public-api-contract.md) defines result and recovery semantics.

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

`canDelete` evaluates the current local row, including accepted edits, when a new deletion is prepared. The same condition applies when confirming a conflicted deletion or preparing a physical deletion through history. The source independently enforces server permissions: if unlocking must be persisted before deletion is authorized, save the unlock first. A server rejection retains the pending deletion for recovery.

Rows displayed to review a pending deletion are excluded from transaction membership. They do not block unrelated cell transactions or appending rows. A complete order command is generated only for an explicit placement or move; such ordering can still require resolving conflicting structural changes first.

## Built-in interactions

- Drag cells to select; Shift extends and Ctrl/Command adds ranges. Row indicators, headers, and the corner select rows, columns, or all visible cells.
- A selection keeps the entities chosen at the time of the gesture. If a remote reorder inserts C
  between selected rows A and B, the grid displays separate ranges and bulk actions still affect
  only A and B. Removing or replacing a selected entity invalidates the selection.
- From an active cell, Ctrl/Command+A selects all visible cells, Shift+Space selects its row, and Ctrl/Command+Space selects its column.
- Clicking the already-active single cell, Enter, F2, or printable input edits when the type allows it.
- Copy/paste, clear, bulk edit, and fill validate every destination through its type. Fill repeats the source sequence unless the type supplies series behavior.
- Header buttons filter and sort; clicking the header selects the column.
- Dirty markers preview the original value and offer Revert. Selection/row revert, undo/redo, conflicts, and retry are available where applicable.
- The grouped context menu includes applicable toolbar, row, selection, persistence, type-specific, revert, and conflict actions. It captures the target and selected row identities when opened. If a captured row disappears or its incarnation changes, the menu closes and clears the selection.

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
    Editor: ({ ariaDescriptionId, ariaInvalid, ariaLabel, draft, setDraft, commit, cancel }) => <input
      aria-describedby={ariaDescriptionId ?? undefined}
      aria-invalid={ariaInvalid || undefined}
      aria-label={ariaLabel}
      autoFocus inputMode="numeric" value={draft}
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

Import `defineCellType` from the package root. Every definition needs `behavior.value.validate`, `behavior.text.display`, `view.Cell`, and `view.presentation`. `behavior.edit`/`view.Editor` and `behavior.bulk`/`view.BulkEditor` must appear in pairs. Optional `accessible`, `search`, `original`, `equals`, `clipboard`, `clear`, `fill`, `compare`, `filter`, `bulk`, `actions`, and cancellable `effects` add capabilities without grid special cases. Use `text.accessible` when display text is not a useful spoken name, such as an image URL.

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
  initial={{ locale: zhCN }}
/>
```

For advanced binding ownership, pass the same value to
`useDataGridBinding({ dataSource, initial: { locale: zhCN } })`; the attached binding inherits it.
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

Use `useDataGridBinding` when React host UI needs direct controller access. It returns an attachment
with `initializing`, `ready`, `switch-blocked`, or `error` status. Automatic creation happens after React commits. Detaching
a view preserves its binding while input, tasks or saves remain pending. Reattaching the same
data-source object resumes that work, including when switching between this hook and the direct
`<DataGrid dataSource={dataSource} />` form. Clean detached bindings are released.

All React forms, including `<DataGrid binding={binding} />`, keep the current table visible when
a requested source/binding switch is blocked by pending work. After that work is resolved, the
latest requested destination becomes active. During a blocked switch `attachment.binding` is the old
binding and `attachment.blockers` lists the remaining work; `attachment.requested` identifies the latest target.
Use `attachment.binding.dataSource` to identify the active source. One data-source object may have
only one automatic React binding owner at a time; use distinct stable data-source objects for
independent grids.

```tsx
function ProductGrid() {
  const attachment = useDataGridBinding({ dataSource })
  if (!attachment.binding) {
    if (attachment.status === 'error') return <div role="alert">
      {attachment.issue.message}
      {attachment.retry && <button onClick={attachment.retry}>Retry opening products</button>}
    </div>
    return <div role="status">Preparing products…</div>
  }
  return <DataGrid ariaLabel="Products" binding={attachment.binding} />
}
```

Use `createDataGridBinding({ dataSource })` only outside React lifecycle ownership and call
`binding.destroy()` after permanent disposal and inspect its `GridCloseResult`. Destruction
is refused while a command, input, task result, or unresolved save still needs ownership.
One binding drives only one mounted viewport. The host must keep an explicit binding reachable
until its pending work is resolved, detach its view before disposal, and retain it if destruction
is refused. React does not automatically destroy an explicit binding.

Destruction returns `closed`, `blocked` with typed blockers, or `cleanup-failed` with
`closed: true` and cleanup issues. Cleanup failure leaves the controller closed; repeated
destruction returns the same failure evidence without repeating cleanup. Automatic reattachment
reports failed cleanup instead of silently replacing that instance.

`binding.controller.getCloseState()` returns `ready`, `blocked` with typed blocker codes, or
`closed`. It is an immediate query; `destroy()` always checks again. Controller notifications run
inside a command, so defer final disposal until the command has returned. This is in-memory
retention, not recovery after a page reload.
`useGridSelector` subscribes host components to controller state. The simpler
`<DataGrid dataSource={dataSource} />` form owns this lifecycle automatically. Add `initial.registry` to any
of these forms only when the data source uses a custom or replaced type.

The [lifecycle contract and API design](docs/lifecycle-api-design.md) describes attachment,
awaitable persistence, retained work, and public API boundaries.

Business commands return `GridCommandResult<T>`: accepted commands contain `revision` and a
command-specific `value`; rejected commands contain `issue.code` and `issue.message`, with
optional `cell` and `domainCode`. Use the stable issue code for decisions and the message for
display. Custom validation codes remain in `domainCode`. Transaction results retain their
atomic commit and multiple-issue contract. Local acceptance does not confirm a server save.

```ts
const copied = binding.controller.dispatch({ type: 'selection/copy' })
if (copied.accepted) console.log(copied.value.text)
else showError(copied.issue.message)

const undone = binding.controller.undo() // redo() uses the same history implementation.
if (!undone.accepted) showError(undone.issue.message)
```

Creation settings belong to `initial={{ registry, locale, limits: { maxMutations, maxClipboardBytes } }}`.
Inline wrapper objects are supported; the concrete fields must remain unchanged for the same instance.
A changed creation setting reports `invalid-configuration` and preserves the existing controller,
input and history. Use a new stable data-source object or explicit binding to open a new configuration.

Geometry is live: `<DataGrid ... view={{ rowHeight: 40, headerHeight: 36, rowIndicatorWidth: 48 }} />`
updates layout, hit testing and selection overlays without recreating the controller. Omitting a view
dimension uses its default (36, 36, 48 respectively). `onAttachmentChange` reports actual connection
changes after commit; source loading remains in `controller.getSnapshot().source`.

When a candidate fails to open, automatic `DataGrid` keeps the previous table and offers a retry
in its footer. Hook consumers receive the same failure in `attachment.issue` and `attachment.retry`;
keep a non-null binding mounted and expose that retry in the host UI.

Automatic React entries update `effects` after commit. Hosts holding an explicit binding use
`binding.controller.updateEffects(port)` or `updateEffects(undefined)`. Each accepted task captures
its port; updating/removing the port preserves running work and removal rejects new host tasks.

Import React-free business data-source, resolver, selection and Controller contracts from
`data-editor-table/engine`; that subpath does not export React views, registries or hooks.
Source adapter authors import `PersistenceSource`, authority, submission, receipt, version and
identity types, plus encoding/hash helpers from `data-editor-table/protocol`. Internal journal,
checkpoint and session machinery are not public exports.

Business `dispatch` accepts selection, editing, history, conflict and task commands.
Saving, recovery and refresh use `save()`, `recoverSave()` and `refresh()`; their former synchronous
dispatch commands have been removed. A custom view adapter uses the engine's interaction port:

```ts
import { getGridInteractionPort } from 'data-editor-table/engine'

const input = getGridInteractionPort(controller)
input.send({ type: 'viewport/resized', width: 800, height: 400 })
input.send({ type: 'keyboard/command', command: 'select-all' })
```

This port delegates to the same Runtime and respects its busy and closed states. Pointer, viewport,
editor composition and editor status events are accepted only by this port. Host tasks return values for targets declared when the task starts.

Custom adapters retaining callbacks capture their target when rendering. Both
`controller.dispatch(intent, target)` and `input.send(event, target)` check that the command
addresses its target. Use `{ kind: 'edit' | 'bulk' | 'filter', id: session.id }` for session
controls and `{ kind: 'row', rowKey, entityId }` for a row command, using the captured
`snapshot.draft.entityAt(rowKey)`. Reopening a filter on the same column creates a fresh ID.
A stale callback receives `stale-target` and the active input stays available.

Atomic host imports use a synchronous transaction:

```ts
const result = binding.controller.applyTransaction((transaction) => {
  const rowKey = transaction.createRow()
  transaction.set(dataSource.columns[0]!, rowKey, 'Imported product')
}, { label: 'Import products' })
if (!result.accepted) showIssues(result.issues)
```

Successful transaction results include `applicationId`, the exact history contribution. Cross-grid
cut compensation uses `history/compensate-insertion` with that ID, and refuses to delete transferred
rows carrying later work. It never guesses the most recent undo action.

Transactions also provide `duplicateRow`, `moveRows`, `deleteRows`, and `abort`; they are all-or-nothing. Placement uses `{ beforeRowKey }` in complete draft order, never a filtered/sorted visible index.

For row drag/drop, pass `rowDropZone={{ active, onTargetChange }}`. Targets provide a canonical `{ beforeRowKey }` placement. The grid owns hit testing, marker, and optional auto-scroll; the host owns `DataTransfer`, validation, Copy/Cut, acceptance, and transaction. Disable positional gestures when `selectGridNaturalRowOrder(snapshot).eligible` is false.

Declare the host task’s entire read/write set when dispatching `controller/run-effect`.
Cell and edit owners accept `{ kind: 'value', value }`. For multiple cells, use
`owner: { kind: 'cells', write: [destinationA, destinationB], read: [source] }` and
return `{ kind: 'values', values: [valueA, valueB] }` in the declared write order.
The effect receives a captured cell context and cancellation signal. The controller rechecks
every dependency before applying any value, including on manual review. A task with a
controller, source or persistence owner completes with no value. Start a new user-authorized
operation to change the destination or selection.

Retained cell task results are available through the original context menu for explicit application
or discard. `effect/inspect-result` returns a copy of a retained task's input/result to a host;
`effect/reapply-cell-result` rechecks the original or explicitly chosen replacement target, and
`effect/discard-result` releases only the specified material.
`effect/apply-host-result` rechecks the declared read/write targets and applies their reviewed values atomically. Failed host effects are
not automatically retried, because only the host can determine their external outcome. Cancellation
revokes application permission; it cannot claim a remote upload or write was undone.

Raw sessions, files, journal and unresolved operations are retained in memory for this runtime.
This integration does not promise recovery after browser termination or a hard reload. Only the
demo's confirmed authority and operation outcomes are stored in IndexedDB.

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

`0.3.1` is an early public test release. It is suitable for integration testing, but its API may
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
