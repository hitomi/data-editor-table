# data-editor-table

A React table editor with an explicit Workspace that owns edits, history,
persistence, file tasks and recovery independently of mounted views.

Version 0.4.0 introduces a **breaking Workspace API**. The previous controller,
data-source adapter, binding and cell-type registry APIs have been removed.
The implementation is still completing its interaction and recovery audit;
see the [progress record](./docs/state-kernel-progress.md) for remaining work.
Users upgrading from 0.3.x should follow the [migration guide](./docs/workspace-migration.md).

## Install and render

```sh
pnpm add data-editor-table react react-dom
```

React 19 is required. Import the default styles once in the application entry.
The host creates and retains a Workspace, then passes that owner into each view:

```tsx
import {
  DataGrid, createStringCodec, kernelId,
  type Workspace, type WorkspaceGridColumn, type WorkspaceGridEditor,
} from 'data-editor-table'
import 'data-editor-table/styles.css'

const name = kernelId<'field'>('name')
const codec = createStringCodec({ invalid: 'Enter a name.' })
const columns: readonly WorkspaceGridColumn[] = [{
  id: 'name', fieldId: name, header: 'Name', label: 'Name', sortable: true,
  render: ({ value }) => codec.format(value),
}]
const editors: readonly WorkspaceGridEditor[] = [{
  fieldId: name, label: 'Name', codec, clearInput: '',
}]

export function Products({ workspace }: { workspace: Workspace }) {
  return <DataGrid
    workspace={workspace}
    viewId={kernelId<'view'>('products')}
    columns={columns}
    editors={editors}
    caption="Products"
  />
}
```

The Workspace schema must declare the `name` field and its storage path.
Columns identify presentation positions; fields identify stored values; entity
IDs identify row lifetimes. Visible indices and business keys are not write
identities. See the [migration guide](./docs/workspace-migration.md) for schema,
source, lifecycle and recovery integration.

## Ownership and persistence

Create the owner outside React render. `new Workspace(options)` provides a
memory owner; `Workspace.openDurable(...)` uses an exclusive recovery-store
session and persists accepted input before publishing it. The host decides how
to reopen existing roots and checkpoints. Unmounting a view does not cancel
work or close the Workspace.

A `PersistenceSource` must implement complete authoritative reads, atomic writes
and durable exact operation lookup. Reads carry ordered or causal versions;
rows carry stable server identities with incarnation semantics. Successful
writes return exact item receipts, including canonical values. Unknown results
remain reserved until their original operation is resolved. A rows array from a
cache is not proof that an operation succeeded.

`workspace.save()` reports commitment only after receipt settlement and the
required authority barrier. Manual, immediate and debounced save scheduling
share this protocol. Undo/redo produce conditional new contributions, including
authoritative undo after saving; they do not restore an old whole-table snapshot.

Use `WorkspaceCloseControls` or the headless close ticket API for explicit
closing. Clean close, checkpoint close, discard and retaining a live owner are
different dispositions. Navigation must respect the confirmed result.

## Editing and host composition

- Cell and range selection, typed and bulk editing, matrix copy/paste and
  opt-in clearing retain original input until it is applied or discarded.
- String, decimal number, ISO date, boolean, single-choice and multi-choice
  codecs separate authoring text, validation and stored values.
- Sorting and filters are view queries. `rowScope` renders separate partitions
  of one complete Workspace without splitting persistence or history.
- `prepareRowAction` prepares field writes, replacement, creation, deletion and
  complete ordering against a specific revision. Row controls belong to host
  workflows, with explicit review for destructive actions.
- Conflict resolution requires the reviewed revision, observation, issues and
  target. Adopting an existing row is an explicit identity decision.
- File inputs enter the Workspace resource store before a task starts. Durable
  tasks use versioned definitions and exact outcome lookup. Cancelling writeback
  does not erase a file or pretend already-started work never happened.

Context menus, remaining drag interactions, richer recovery surfaces and large
row-set performance are still under audit. Current views render their complete
visible row set; do not assume virtualized rendering or automatic pagination.

## Examples

Run `pnpm demo` to inspect the current branch:

| Example | Workflow |
| --- | --- |
| [Quick start](./demo/src/quick-start.tsx) | Durable editing and saving existing products |
| [Playground](./demo/src/playground.tsx) | Value codecs, row actions, save modes, filtering and file conversion |
| [Multi-image import](./demo/src/multi-image-import.tsx) | Retained batch preview and reviewed atomic replacement/append |
| [Cross-grid transfer](./demo/src/cross-grid-drag.tsx) | Copy/move between partitions of one atomic authority |

The demos use a browser-local IndexedDB authority. They do not implement a remote
backend or cross-backend transactions. Their image tasks perform local conversion,
not remote upload. A server integration must provide its own source and task
contracts.

## Exports and styling

| Entry | Purpose |
| --- | --- |
| `data-editor-table` | Workspace API, DataGrid, React components, codecs and English locale |
| `data-editor-table/engine` | Headless Workspace, protocols, preparation and recovery; no React dependency |
| `data-editor-table/locales/zh-CN` | `workspaceZhCN` locale |
| `data-editor-table/styles.css` | Default structure and theme |
| `data-editor-table/structure.css` | Structural rules for a custom theme |
| `data-editor-table/theme.css` | Default theme rules |

## Documentation

Start with the [documentation index](./docs/README.md),
[0.4.0 migration guide](./docs/workspace-migration.md), and
[public API navigation](./docs/workspace-api.md). Historical controller designs
are archived and do not describe the current API.

## Development and verification

Use the repository package manager and configured Node.js version.

```sh
pnpm check
pnpm test
pnpm test:coverage
pnpm test:mutations
pnpm lint
pnpm demo:build
pnpm test:browser
pnpm check:package
```

The boundary check rejects dependencies on the removed implementation and React
imports from headless modules. Kernel tests include independent semantic models; `test:mutations` verifies that
selected semantic faults are detected in an isolated source copy and writes its
evidence to `kernel-mutation-results/summary.json`;
browser tests exercise IndexedDB, lost responses, navigation and reopening in
Chromium, Firefox and WebKit. Package checks build and install an isolated tarball
consumer rather than testing only source aliases.

`pnpm test:coverage` measures the Vitest suite against all production TypeScript
files under `src`, including files the tests never import. It excludes test files
and declaration files, and writes an HTML report to `coverage/index.html` plus
machine-readable JSON reports. Browser-test coverage is not included in these
figures; they are not combined unit and browser coverage.

Architecture and acceptance criteria are in the
[state kernel design](./docs/state-kernel-redesign.md). Recovery format and API
breaking changes are documented in the [migration guide](./docs/workspace-migration.md).

Licensed under [MIT](./LICENSE).
