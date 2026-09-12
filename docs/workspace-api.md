# Public API navigation — 0.4.0

This is a navigation guide to the current public API, not a copy of every type
declaration. Use the linked source types for exact arguments and result unions.
The [migration guide](workspace-migration.md) explains the behavioral contracts.

## Package entry points

| Import | Contents |
| --- | --- |
| `data-editor-table` | Headless API plus `DataGrid`, React hooks and UI components; [exports](../src/index.ts) |
| `data-editor-table/engine` | React-free Workspace, schema/source, preparation, recovery and codec APIs; [exports](../src/engine.ts) |
| `data-editor-table/locales/zh-CN` | `workspaceZhCN`; [locale](../src/locales/workspace-zh-cn.ts) |
| `data-editor-table/styles.css` | Default structure and theme |
| `data-editor-table/structure.css` | Structural styles for a custom theme |
| `data-editor-table/theme.css` | Default theme rules |

Import from these package entry points. Paths such as `src/kernel/` below are
source-reading links, not supported npm deep imports.

## Workspace ownership

All methods in this section belong to [Workspace](../src/kernel/workspace.ts).
`WorkspaceOptions` supplies scope, schema, policy, source, and optional durable
task definitions. Keep the owner outside React render and reuse it for its views.

| API | Purpose |
| --- | --- |
| `new Workspace(options)` | Memory owner; reload requires a different recovery strategy |
| `Workspace.openDurable(...)` | Open with an exclusive storage session; choose initial creation or restore explicitly |
| `Workspace.openCheckpoint(...)` | Activate a durable checkpoint under a new lease after validating its exact storage roots |
| `Workspace.transferMemory(...)` | Transfer from a live memory owner using its reviewed close ticket |
| `getSnapshot()` / `subscribe(listener)` | Observe the owner; unsubscribe only detaches the observer |
| `getState()` / `getProjection()` | Read immutable facts and their derived row/change projection |

[`useWorkspaceSnapshot` and `useWorkspaceSelector`](../src/react/workspace-react.ts)
subscribe React to the same owner. Server rendering requires an explicit server
snapshot; it must not read a newer live snapshot or start I/O.

## Authoring, saving and recovery

| API | Contract |
| --- | --- |
| `dispatch(command)` | Submit a typed `WorkspaceCommand`; await and inspect `CommandResult` |
| `typeInput(...)` / `enqueueInput(envelope)` | Retain raw input under its exact editor lease; inspect the returned handle's completion |
| `undo()` / `redo()` | Conditional history against actual execution evidence |
| `resolve(request)` | Apply a reviewed conflict decision |
| `refresh()` | Request complete authority without replacing local intent/input ownership |
| `save()` | Freeze and save the eligible set; inspect `WorkspaceSaveResult` |
| `recover('lookup')` | Query the original unresolved save; `retry` remains tied to its original operation identity |
| `reconcileStorage()` | Resolve an uncertain local durable commit separately from a server save |
| `getRecoveryPlan()` / `recoverPendingWork()` | Inspect and reconcile retained work; inspect individual outcomes and remaining candidates |

`WorkspaceSaveResult.kind` is `committed`, `not-applied`, `unresolved`, `blocked`,
`no-changes`, or `not-started`. A `committed` result can still have `remaining`
intent IDs. Neither a disabled button nor an accepted local command proves that
all rows have been saved or that the Workspace can close.

For custom row actions, use [`prepareRowAction`](../src/kernel/prepare.ts) to
compile an atomic proposal and dispatch `prepared-action`. Inputs must retain
their complete ownership bundle. A stored task result uses `cause: 'task'` and
`taskInputRecords`; do not substitute current row positions for captured IDs.

## Source and schema

[`PersistenceSource`](../src/kernel/source.ts) defines complete `readAtLeast`,
immutable `submit`, and exact `lookupOperation` results. Capabilities are backend
guarantees, not flags that make an arbitrary REST endpoint safe. Preserve
operation IDs, authority ordering, exact coverage and row incarnation identity.

[`defineKernelSchema`](../src/kernel/schema.ts) defines fields, complete document
encoding and validation. [`PolicySnapshot`](../src/kernel/state.ts) defines
current permissions. Presentation columns cannot replace these storage contracts.

## Files and tasks

`registerResource(blob)` retains original bytes and returns an owned resource
input. `getResource` reads them; `releaseResource` must respect all retained
references. Cancellation does not imply that a file is unused.

`runTask` uses a live callback in memory mode. `runDurableTask` requires an exact
versioned [`DurableTaskDefinition`](../src/kernel/durable-task.ts).
`waitForTask` waits for runtime work; the task may still be blocked or unknown.
`recoverTask` queries/retries the same retained execution. Missing definitions
block execution while preserving material for later recovery.

## Close and checkpoint

Use `requestClose()` to obtain the assessment and current ticket, then pass the
ticket and explicit mode to `close(...)`. Inspect `CloseResult`; navigation or
resource release must follow confirmed closure, not the initial request.
Unmounting a view alone is not a close operation.

`exportCheckpoint()` captures portable checkpoint material. `encodeCheckpoint`
and `decodeCheckpoint` transport it; `Workspace.openCheckpoint` performs durable
activation. `exportIndexedDbRecoveryDatabase` instead exports original database
records without acquiring a lease. Its forensic archive is not a checkpoint.

Current recovery records use format **10**, checkpoint metadata format **2**,
and IndexedDB layout version **2**. Unsupported old records are retained, not
automatically converted or deleted. See [recovery migration](workspace-migration.md).

## React composition

[`DataGridProps`](../src/react/workspace-data-grid.tsx) takes `workspace`, a distinct
`viewId`, columns and editor definitions. `WorkspaceGridColumn` identifies display
columns and fields; `WorkspaceGridEditor` supplies codecs and optional clear input.
Use `rowScope` for presentation partitions, not authorization.

`WorkspaceCloseControls`, `WorkspaceToolbar` and the exported editor components
share the owner. Use `workspaceEn` or `workspaceZhCN` for complete locale contracts.
The [README example](../README.md) and [Quick start](../demo/src/quick-start.tsx)
show rendering and ownership together.
