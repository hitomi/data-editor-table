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

Conflict requests bind the current `revision`, authority `observation`, and the
complete `issueIds` for the reviewed target. Targets may be a row, order, or
`{ kind: 'field', entityId, fieldId }`. Field targets support `use-authority` and
`keep-local`; they preserve other fields' captured comparisons, even when a
single input wrote multiple fields. Undo and redo retain this scope. Whole-row
comparisons and writes crossing the field boundary require a complete-domain
review. Business reads and current permissions remain enforced.

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

Current recovery writes use format **16** (formats **10–15** remain readable), checkpoint metadata format **2**,
and IndexedDB layout version **2**. Unsupported old records are retained, not
automatically converted or deleted. See [recovery migration](workspace-migration.md).

## React composition

[`DataGridProps`](../src/react/workspace-data-grid.tsx) takes `workspace`, a distinct
`viewId`, columns and editor definitions. `WorkspaceGridColumn` identifies display
columns and fields; `WorkspaceGridEditor` supplies codecs and optional clear input.
Standard field codecs provide multi-condition column filters automatically. Host-supplied
`filters` override the corresponding column. `createStandardFilterCodec` is also
available for explicit composition. Filter drafts use versioned retained input;
applying changes only the query, and **Clear filter** removes only that column.
Unsupported host predicates stay intact until explicitly cleared or edited by a
compatible host codec.

Use `rowScope` for presentation partitions, not authorization. Display columns accept
positive `width` and `minWidth` values in pixels and expose pointer/keyboard resizing.
Optional nonnegative `flex` weights distribute unused viewport space proportionally;
narrow viewports scroll instead of shrinking columns below their base widths.
A manually resized column keeps its chosen width while other flexible columns adjust.
Use `align: "start" | "center" | "end"` for cell content; numeric columns can use `"end"`.
An optional `rowHeader` renders host controls beside the row number; set its positive
`width` when those controls require more than the default 44px row-number column.

Ordinary scalar cell editors validate and apply before switching selection. Invalid
input stays at its original target. Use **Review grid** to keep an input session while
inspecting other targets; applying or retargeting still requires the captured session
and its input version. Multi-value, resource and matrix inputs retain explicit
confirmation workflows.

Changed fields expose an original-value marker. Hover, click or keyboard activation
opens the authority value; **Restore original value** creates an undoable write using
the original encoded type, including missing fields. It does not remove journal
history or save to the source. Pending input, read-only and conflicted fields prevent
restoration. Customize this UI through `messages.dirty` or the locale's `grid.dirty`.
Newly created rows have no authority value to restore through a field marker.
The context menu also restores the clicked cell or the selected fields. Disjoint
selection holes are preserved and aliases are deduplicated. Restoration validates
the complete write set and creates one atomic action, so Undo restores the whole
operation. Clean fields and newly created rows are left intact.
**Restore original row** restores the full authority document, including fields not
shown by the grid, and the original row position. For an unsaved new row it removes
the creation. Content and ordering belong to one undoable transaction; current
replace/delete/order permissions and conflict checks still apply.

`WorkspaceCloseControls`, `WorkspaceToolbar` and the exported editor components
share the owner. Use `workspaceEn` or `workspaceZhCN` for complete locale contracts.
The [README example](../README.md) and [Quick start](../demo/src/quick-start.tsx)
show rendering and ownership together.

### Independent view queries

`DataGrid` uses its `viewId` for filtering and sorting. Two grids sharing one
Workspace and distinct view IDs retain independent queries, while edits, saves
and undo still share the Workspace. Use `workspace.getView(viewId)` for matching
host controls, such as a row-action selector. `getSnapshot().view` and `getView()`
without an argument expose the default query, not the last grid that changed.

Headless `view-query-set` accepts `viewId`; its `expectedVersion` belongs to that
view. A filter session captures the destination in `target.viewId`; attaching the
editor from another view does not retarget the query. Applied input dispositions
identify both `viewId` and `queryVersion`, backed by `state.viewHistory`.

For existing hosts and recovery records, an uninitialized named view inherits the
unscoped default query. Its first scoped mutation forks a complete query version;
later default-query changes cannot overwrite it. Use a scoped command to change
an already initialized grid. Legacy filter sessions without a destination keep
their original default-query destination through recovery.


The built-in **Filter rows** search applies immediately and combines with column
filters. It trims only for matching and preserves the original text. Matching is
case-insensitive within the explicitly stored locale; standard choice fields
include both catalog labels and encoded scalar values. Missing/null values do
not contribute text. Search is independent per view and never creates a data edit.

`view-search-set` accepts `{ viewId, search: { text, locale, fields } }`. Each field
has a `fieldId` and optional encoded-value/text `labels`. It patches only search
against the query current at execution, preserving queued sort and column-filter
changes. `view-query-set` likewise preserves search; use `view-search-set` with
empty text to clear it. Pending input is owned by ingress and the accepted text
and definitions are recorded in query history, so new/refreshed rows are matched
without freezing the set of matching row identities.


Bulk multi-choice editing supports replacement, addition and removal. Mixed source
sets start with **Keep existing tags** and require choosing an operation. Equal
sets start with replacement of their existing values. Disabled catalog entries
may be retained or removed, but cannot be introduced into a cell that lacks them.
All target results are validated before one transaction is prepared.
`workspace-choice-bulk:1` retains both the operation and typed authoring tokens
through reopening, including rejected input. Bulk labels are supplied through
`locale.grid.editor.choiceBulk`.


Fill handles use pointer capture, lock the expansion axis when leaving the source
selection, and preview the destination without editing data. Release applies the
captured matrix through the ordinary retained-input validation and commit path;
it does not save to the source directly. Keyboard fill supports Escape to cancel
and Enter to apply. A gesture that stays within its source creates no operation.
The expanded range is selected after successful application. Uncertain input
confirmation stops automatic application and preserves the original matrix for
explicit recovery; callback document dependencies continue to guard both Apply
and Save.


### Resource cell activation

Resource editors may set `resourceTask.accept` to a file type filter
and `resourceTask.pickOnEdit: true` to open that picker directly from cell
activation. The picker opens within the user gesture, before asynchronous
storage work. Selecting a file uses the same fixed-target upload flow as dropping
onto a resource cell; successful results auto-apply only while their exact input
version still owns the editor. Empty selection leaves the cell unchanged.
The same accept rules (MIME types, MIME wildcards and filename extensions) are
checked before picker files, cell drops and replacement files enter the upload
flow. Optional `resourceTask.maxBytes` must be a positive safe integer and
rejects oversized files at the same boundary. Rejection leaves an existing
session and its running task intact. Tasks must still validate file contents;
the preflight checks declared type/name and size, not the actual encoding.

Set `resourceTask.applyOnUpload: true` when successful file selection or
replacement should finish the cell edit automatically. The automatic action is
bound to that result's Workspace, session and input version. Later typing or
retargeting prevents it from applying the newer input. The default keeps the
result in the editor for explicit Apply. Selecting another file while a task is
running cancels the previous session tasks before starting the replacement;
their original files and late outcomes remain recoverable.

### Paste that creates rows

`DataGrid` and `WorkspaceTextEditor` accept `maxClipboardBytes` (default
2,000,000 UTF-8 bytes) and `maxMutations` (default 10,000), each a positive safe
integer. The grid checks clipboard size before parsing a paste and before
publishing copied text. Paste cost includes every supplied cell plus each new
row; overflow is rejected before invoking the row factory. Field editor Apply
checks the limits again, including after recovery or a host configuration change.
Rejected input already owned by an editor remains available for correction.
These UI limits do not impose a global limit on direct Workspace API commands
or host-owned row actions.

`DataGrid` accepts `createRow: () => ({ document, proposedKey? })` for sources that
support row creation. The synchronous factory supplies a complete default row;
Workspace allocates its entity identity. Keep the factory free of external I/O.
The same defaults should be used by the host's Add row action.

Overflow paste retains its raw text before calling the factory. New row defaults
and identities become `SessionTarget.creations` on a bulk session, separate from
the authoritative rows. Apply validates every pasted value, creates the declared
rows and writes all fields in one transaction. Invalid values or conflicting
keys retain the input without inserting partial rows. Opening, target and apply
acknowledgement loss can be recovered after reopening; a recorded factory result
is reused. An interrupted opening exposes an explicit “Prepare new rows for
paste” action after the input is recovered.

Rows in a paste may have different widths. Omitted trailing cells keep their
existing values (or new-row defaults); explicit empty cells still go through
their field codecs. Recovery retains each original row width with the raw text.
Changing the matrix shape in the editor requires a new paste operation, so an
input correction cannot silently expand its captured targets.

Runtime ownership precedes the asynchronous storage commit. While requests are
queued, committing or uncertain, the mounted grid requests the browser's native
leave-page confirmation. Cancel leaving to let storage finish. A forced exit or
browser crash before the first commit can still lose that input; receiving a
paste event is not evidence that recovery storage has accepted it. Hosts remain
responsible for in-app navigation and Workspace lifecycle handling.

`createIsoDateCodec({ invalid, allowEmpty: true })` supports an optional date
stored as an empty string. This cannot be combined with an empty policy that
represents null or a missing field.

Opening an editing session captures its logical read context at Workspace admission
when the supplied revision is current. Queued changes to save settings or stored-file
registration do not invalidate that opening. Changed target/read values, permissions,
editor generation or filter context still reject the request; stale callers are not
silently refreshed. This applies equally to direct dispatch and beginEditing.

Multi-choice codecs render compact tags with a width-dependent overflow count.
The full ordered label list remains the cell's accessible name and tooltip;
collapsing labels never changes the values used for copy, editing or saving.

The footer reports visible rows against the current view or partition total, and
counts the visible union of selected display cells. Filtering hides members from
this visible count without changing the captured editing target. Counts appear
only after the authority has complete content. Summary labels are localized.

### Interaction messages and save feedback

The locale contract includes `grid.editor.bulk` for text bulk operations and
validation, choice/dialog action labels, `grid.resource.unsupportedType` and
`tooLarge`, plus `grid.summary` issue labels and `grid.toolbar` save progress.
Custom message objects must supply these fields; the English and Chinese
locales provide complete defaults.

Save feedback follows the Workspace persistence state for both manual and
automatic saves. A server rejection remains visible while its changes are
outstanding. Summary counts distinguish rows failing validation, rows with
conflicts, and other blocked rows; search does not hide their outstanding work.
