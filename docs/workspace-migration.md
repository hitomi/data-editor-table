# Workspace API migration

The public entry now uses the new state kernel. This is a breaking API change;
the old controller and data-source constructors are no longer public exports.
The migration is in progress: Quick start, Playground, multi-image import and
cross-grid drag use the new API. All browser fixtures also use the new API; the legacy state implementation has
been removed. Remaining interactions, recovery surfaces and the final acceptance
audit must complete before release. The isolated package consumer exercises the new API.

Quick start uses an IndexedDB product authority whose transactions persist both
product documents and exact operation outcomes. This is browser-local example
storage, not a remote-service adapter. It supports edits to existing products;
its policy rejects structural changes. A real service must provide its own
transactional authority and operation-lookup guarantees.

The shared demo authority can also be opened with explicit structural support
for creation, deletion, restoration and complete ordering. Its capability choice
is fixed for a Workspace scope. Quick start keeps structural support disabled
so existing browser workspaces retain their original source contract.

Playground owns its durable Workspace outside React. Row actions prepare commands
against stable entity identities; saved deletion undo restores a fresh server
incarnation. Manual, immediate and debounced save modes are Workspace state and
survive reopening. Sorting and the current Name filter change only the view query.

Its image conversion service stores the exact request and validated ArrayBuffer
bytes in IndexedDB before conversion. It retains exact outcomes; lookup can finish
the same accepted conversion after a restart. Missing executions stay unknown.
This is a local conversion example with no remote upload side effect. Remaining
filter variants, context menus and drag interactions are still migration work.

## Entry points

| Entry | API |
| --- | --- |
| `data-editor-table` | `DataGrid`, Workspace APIs, React subscriptions, toolbar and explicit close controls, value codecs, English locale |
| `data-editor-table/engine` | Workspace, source/schema contracts, action preparation, recovery/checkpoint APIs and value codecs; no React dependency |
| `data-editor-table/locales/zh-CN` | `workspaceZhCN` implementing `WorkspaceLocale` |

Import `styles.css` for the default theme. Import `structure.css` with your own
theme when you need independent styling; `DataGrid.className` accepts a host
class on the Workspace container. The built-in container is fluid, and retained
text and viewport content remain accessible when they overflow.

`DataGrid` is the Workspace-backed component. There is no `dataSource` or
`binding` prop. Create the Workspace outside render and pass the same owner to
every view of that workspace. React unmount detaches a view; it does not discard
input, cancel tasks or release the workspace.

```tsx
import {
  DataGrid, Workspace, kernelId, createStringCodec, workspaceEn,
  type WorkspaceOptions,
} from 'data-editor-table'

// options contains the application's fixed scope, schema, policy and source.
export async function openEditor(options: WorkspaceOptions) {
  const workspace = new Workspace(options)
  await workspace.refresh()
  return workspace
}

const fieldId = kernelId<'field'>('name')
const codec = createStringCodec({ invalid: workspaceEn.values.string })
const columns = [{
  id: 'name-column', fieldId, header: 'Name', label: 'Name',
  render: ({ value }: { value: Parameters<typeof codec.format>[0] }) =>
    value.kind === 'missing' ? '' : String(value.value),
}]
const editors = [{ fieldId, label: 'Name', codec }]

export function ProductEditor({ workspace }: { workspace: Workspace }) {
  return <DataGrid workspace={workspace} viewId={kernelId<'view'>('products')}
    caption="Products" columns={columns} editors={editors} />
}
```

The schema must bind the `name` FieldId to its complete document storage path.
Display columns do not define persistence behavior. Multiple display columns may
reference the same FieldId. Persisted records are complete documents, including
fields that are not displayed. Custom row codecs must preserve that completeness.

Set `sortable: true` on display columns to enable header sorting. Ordinary clicks
cycle ascending, descending and unsorted, replacing the previous sort; Shift
preserves the other sort fields and their priority. Multiple display columns for
one FieldId share one sort entry. Sorting updates the durable view query, not the
data journal, and keeps the current editor's target identities and filters.

## Source and save contract

Replace `mutate(request.rows)` with a `PersistenceSource`. It implements
`readAtLeast(scope, frontier)`, `submit(frozenSubmission)` and
`lookupOperation(submissionRef)`. Its declared capabilities are guarantees of the
actual authority: atomic scope writes, idempotent operation identity, retained
exact outcomes, authority ordering and stable row incarnation semantics.
A client cache must not invent these guarantees for an incompatible backend.

Submit immutable typed items with their exact coverage. Return canonical results
and the authority boundary for the submitted operation. An ordinary HTTP success
or a later refresh is not evidence that every submitted item was accepted.
Unknown results remain pending until exact lookup resolves them; do not retry
them under a new operation identity.

Use `workspace.save()` and inspect its discriminated result. `committed` can
still contain `remaining` intent IDs. A disabled Save button is not a completion
signal. Saving, recovery and close controls use the same Workspace observation.

## Input and lifecycle

Selection uses EntityId and display-column identity. Editing input, task input,
rejected requests and resource files belong to the Workspace. Components must
not keep a second business draft or clear raw input after an unconfirmed result.

Compose `WorkspaceCloseControls` at the host boundary with locale `close`
messages. Only enable its checkpoint option when the host can reopen the stored
workspace. Its `onClosed(owner, result)` callback follows confirmed closure;
match `owner` to the currently displayed workspace before navigating. Direct
users of `workspace.close()` must pass the ticket obtained from `requestClose()`
and inspect the result. A stale ticket requires a new review. Discard is explicit
and cannot erase an unknown external operation.

Memory mode requires the live owner for transfer. Use the durable recovery and
checkpoint APIs for reload recovery. Legacy rows-and-flags snapshots are not a
valid new checkpoint. Finish, export or explicitly dispose old in-flight work
under its existing owner before switching. Preserve unsupported stored data;
never clear it merely because opening under the new schema fails.

## Copying selected cells

Copy events on grid cells produce quoted TSV from each field codec's authoring
format, so the result can pass through the same codec when pasted. Localized
labels do not replace typed values. Aliased display columns remain separate TSV
columns. Captured selection membership and order survive filtering and sorting;
copy includes those retained members. If a member disappears or its codec cannot
represent the value, the whole copy is rejected with localized feedback.

Copy reads the projected documents and does not create a session, intent or save.
Unapplied text remains in its editor, where normal text-copy behavior applies.

Ctrl/Cmd+C on a focused grid cell writes the captured TSV with the browser
Clipboard API. Feedback distinguishes pending, completed and rejected writes;
clipboard access must be available. Browser copy events also use the same matrix
formatter. Neither path changes the Workspace journal.

## Clearing selected values

An editor opts into clearing with `clearInput`, the exact authoring text accepted
by its codec. For example, a string can use `clearInput: ''` and a multi-choice
field can use `clearInput: '[]'`. A nullable numeric codec may use an empty input
only when that codec explicitly parses it as null. There is no inferred zero,
null or property deletion. Unconfigured fields disable a mixed clear selection.

“Clear selection…”, Delete, and Backspace open the same retained input for review.
The keyboard shortcuts act only when the grid cell itself has focus: a focused
member uses the captured selection; focus outside that selection targets only
that cell. They do not handle modified keys, key repeat, IME composition, or
text deletion inside child controls. An active session is never replaced.
A single field uses its
ordinary editor; a bulk selection uses captured matrix identities and per-field
clear inputs. Apply performs normal codec/schema/policy validation and transfers
the input into the journal. Save and undo follow the same authority protocol as
other edits. Clearing does not silently discard an existing session, and opening
the review alone does not mutate the projected documents.

## Context menu commands

Right-click a grid cell, press Shift+F10, or use the Context Menu key to open its
command menu. Native menus on child controls remain available. Arrow keys and
Home/End move between enabled commands; Escape returns focus to the originating
cell. Tab or an outside pointer closes this transient chooser without cancelling
any editor input.

The menu provides editing, copying, the retained paste editor, clearing, history,
saving, refreshing and pending-result recovery. History/save commands reuse the
same toolbar execution and feedback. The target is the captured selection when
the cell belongs to it, otherwise the single originating cell. Single-cell edit
uses the field codec; bulk edit opens the captured matrix with its current values.
Paste opens a retained input for pasting rather than requesting clipboard-read
permission. No menu command implicitly applies an existing editor session.

Menus expire when the Workspace snapshot, selection, column/editor definitions
or view changes. Execution checks the current Workspace snapshot again. Menus
use the native Popover top layer and inherit grid theme variables, including
inside a transformed or scrolling host. The Chromium/Firefox/WebKit workflows
are the tested runtime scope; no legacy Popover polyfill is supplied.

Custom `WorkspaceGridMessages` now includes `menu.label` and `menu.copy`; the
built-in English and Chinese locales provide both. Row structure and conflict
decisions continue through their explicit reviewed actions. Old snapshot-based
cell/row revert operations are not part of the new menu contract; use conditional
history or a reviewed resolution as described by the kernel design.

Custom `WorkspaceToolbarMessages` must also supply `awaitingAuthority` and
`awaitingReceipt`. These describe confirmed writes waiting for updated rows or
exact save details. The toolbar derives these statuses from persistence state,
including after reopening; `unresolved` remains the unknown-outcome feedback.
Both built-in locales provide the new messages.

## Reviewing converted batches

A durable conversion service may return `TaskResult` with
`{ kind: 'action-candidate', input }`. The service returns retained data, not a
PreparedAction compiled against a client state it does not own. Workspace keeps
the candidate in `result-ready`; neither completion nor recovery writes rows.
The generic task panel displays retained candidate material without offering the
single-field reapply control for an action candidate.

The application must render and review its domain-specific target plan. It then
uses `taskInputRecords(state, taskId)` to include the complete original input
bundle in `prepareRowAction`, with `cause: 'task'`, and submits `task-reapply`
with the reviewed revision, owner and proposal. This supports one atomic action
containing both existing-row writes and new rows. Current revision, ownership,
complete input transfer, field/session write limits and policy checks still apply.
The application must not silently replace the captured plan with current visible
row positions when preparing a batch.

RecoveryRecord is now format 10. Formats 1–9 are rejected without overwriting the
stored record; this change does not provide an automatic converter for old
workspaces. Retain original storage/checkpoints for an explicit migration path.
The database store layout remains version 2.

Workspace checkpoints now use metadata format 2; format 1 is rejected. Journal
anchors, history/order frontiers and intent dependencies reference one scoped,
append-only flat node table. Prepared actions and history/decision candidates
carry the candidate table and install it atomically with their intents. Accepted
nodes cannot be rewritten. Frozen submissions retain explicit coverage and
frontier ID lists so request bytes remain independent of the journal table.
Recovery validates the complete table and reference closure, including inactive
history and fallback anchors. Old recovery databases can still be exported as
original archives; those archives are not automatically converted checkpoints.

Storage roots and semantic revisions are distinct: a successfully stored rejected
or ignored ingress outcome advances the exact storage token without advancing
the semantic revision. These records retain the complete input or receipt, have
no semantic effects, and require the same parent CAS and exact lookup as accepted
work. A semantic rejection no longer waits for a later successful edit or refresh
to persist its original input. Queue-blocked inputs and failed resolution/task
preparation use the same ownership barrier. This does not promise durable storage
when the storage transaction itself definitively fails or ownership has not yet
reached a completed receipt.

## Multi-image import example

The import route now owns one durable Workspace outside React. Files are captured
as one reversible resource before conversion, with fixed existing targets and
fresh identities for overflow rows. Conversion produces a retained candidate;
users review replacements/new rows and confirm before applying one transaction.
Changed original values block application until the user explicitly reviews new
targets. Sorting does not silently recapture the original plan.

`DataGrid.renderActionCandidate(task, input)` lets the domain render that review
inside the retained-task panel, alongside original-file access and cancellation.
The generic component still owns task status and cancellation. A cancelled late
result remains recoverable, and the import renderer disables its apply action.
Single files can be downloaded from retained previews. Route detachment does not
cancel conversion; saved changes and reviewed-input material survive reopening.

## Partitioned views of one Workspace

DataGrid and WorkspaceGridViewport accept an optional `rowScope: ViewPredicate`
for a host-defined partition. The shared query applies first, then the partition.
Counts distinguish an empty partition from a query that matches no rows in that
partition. This is presentation filtering; authority, history and recovery remain
complete in the same Workspace. It is not an authorization boundary.

Give each mounted pane its own viewId. Changing its partition resets selection
for new edits, while an already-owned input session keeps its original entities.
Sorting/filtering preferences remain the Workspace query; rowScope is fixed host
composition, not a second editable query store. New edit controls require their
complete target selection to remain visible; retained sessions and captured copy
material are preserved across visibility changes.

The cross-grid demo uses these partitions for two lists within one authority.
A move retains entity identity and updates membership and order in one transactional
action; a copy creates fresh entity and business identities. Protected originals
remain in their home partition. External drag payloads are always copied.
Checkbox selection and destination controls provide a keyboard alternative to drag.
The optional rowHeader renders host controls outside editable field cells. Transfers between different backends require a backend coordination
protocol; undoing an independently saved target draft cannot supply atomicity.

## Staged files without an input owner

DataGrid displays available files that have not been assigned to current or
historical input, task results, pending ingress or returned ingress archives.
The user can download original bytes after reopening and explicitly remove an
unused file. Removal consent belongs to the current Workspace instance and
revision; new work invalidates that consent. The kernel still rejects release
if another owner starts referencing the resource before the action is accepted.
English and Chinese locale contracts include `grid.files` labels.

Task cancellation does not make its input file unused. Such material remains in
the task recovery UI with its historical ownership intact. This panel does not
replace recovery-bundle review or returned-request archive management.

## Returned request archives

Rejected and blocked ingress can be explicitly moved into the retained archive
from DataGrid. The disposition covers the displayed dependent request set and
uses its exact ingress generation. Uncertain work must be reconciled first.
Archived requests remain available after reopening, including their full request
JSON, original text inputs and downloadable File/Blob bytes. Export does not
retry or apply a request. Returned file references continue to prevent resource
release. `grid.ingress` locale messages include archive and export labels.

This is a retained archive, not a portable Workspace checkpoint importer.
Reapplying content requires a separately reviewed new command under current
identity and policy; downloading JSON does not authorize execution.

## Input recovered by undoing a decision

DataGrid displays available decision-recovery bundles and every original input.
A user may choose one original text input or start a new edit, select a visible
target, review its current values, then open the recovery edit. Changing the
selected target or Workspace revision invalidates that review. Opening does not
write a row: the existing session protocol atomically takes ownership of the
whole bundle, and the ordinary editor still requires Apply or Discard.

All original materials remain visible while that session owns them, including
after reopening. Applying transfers the complete bundle into the new action;
cancelling terminates the current and retained session inputs. Historical proofs
are not reopened. Resource and structured inputs stay inspectable; only original
string inputs are offered directly as starting text. Hosts needing structured
reapplication must provide an appropriate reviewed editor. Locale contracts add
`grid.recovery` labels for this workflow.

## Fill selection

DataGrid exposes a draggable corner on the selected source and a keyboard
`Fill selection` action. The keyboard action captures the source, focuses the
grid, and accepts an arrow-key destination with Enter or Space; Escape cancels
the gesture. A foreign drag token cannot complete a local fill. Locale contracts
add `grid.fill` labels.

The gesture freezes visible row identities, field mappings, source text and the
Workspace revision. Completion opens a retained matrix editor; Apply and Save
remain separate reviewed operations. A changed Workspace revision rejects the
captured input into ingress instead of recapturing newer remote values. Sorting
after the editor opens does not rebind its targets. The status overlay does not
move the grid while a native drag is in progress.

Without a callback, fill repeats a literal rectangular pattern, including empty
cells and expansion above/left. A display column may now provide `fill(context)`
returning a `ResourceValue`. `WorkspaceFillContext` contains `sourceValues`,
`repeatedValue`, `sourceStartIndex` (zero), signed `targetIndex`, `direction`,
`entityId`, complete captured `document`, `columnId`, and `fieldId`. This replaces
the old cell-type callback; column options can be captured in the host's closure.
The callback must be synchronous and pure. It runs only for added cells, never
for cells inside the original source rectangle.

Source text is parsed with the destination field's captured codec, including
horizontal fills across different column types. Vertical gestures use the source
column sequence; horizontal gestures use the source row sequence. Diagonal
expansion uses the vertical sequence. Negative target indices represent extension
above or left. Context and encoded values are owned immutable copies. The target
codec formats the returned value into editable text, which is validated again
when the user applies the complete matrix. Every document exposed to a callback
is a session dependency and is carried into its row intent as a semantic read.
A later hidden-field change therefore blocks Apply or Save, including after
reload, instead of silently reusing a stale computed value. No callback is rerun on reload, Apply,
Save, undo, or redo. Hosts should replace definitions rather than mutate them.

A conversion, callback, or formatting exception rejects the whole generated
matrix and displays the fill error; existing rows and authored input remain
unchanged. No partial callback result is applied. Successful generated text is
retained through the normal session and ingress protocols, including stale
revision rejection. The playground Quantity column demonstrates arithmetic
series (two source values set the step; one source value uses a step of one).

## Keyboard task cancellation

Each retained task panel can receive keyboard focus. Escape on the panel itself
or its Cancel task button invokes the same `task-cancelled` command as clicking
the button; both controls expose `aria-keyshortcuts="Escape"`. Other controls,
including authored text and custom task preview controls, keep their own keyboard
behavior. Modified, repeated and composing Escape events do not cancel a task.

The handler checks the current Workspace and exact task execution before dispatch,
so two events before React rerenders cannot enqueue two cancellations. Pending
input/storage/recovery and inactive owners disable the UI entrance. Cancellation
still preserves retained material and does not promise that already sent external
work will stop; late results cannot update another edit. English and Chinese
`resource.cancelHelp` text describes the focused task shortcut.

## Exporting incompatible IndexedDB records

`exportIndexedDbRecoveryDatabase(databaseName)` is exported from the root and
headless entry points. It returns an `application/json` Blob containing all
records from every object store in that existing database, including all
Workspaces stored there. It does not require a current schema, acquire a recovery
lease, upgrade the database, replace its head, or create a missing database.
A single readonly transaction captures the entries before encoding them.

This is a forensic archive for recovery/conversion tooling, not a Workspace
checkpoint accepted by `decodeCheckpoint`. The envelope has format
`data-editor-table-indexeddb-archive`, version `1`, the database name/version,
and tagged `stores`. Objects encode key/value pairs; arrays encode tagged values;
numbers encode strings to preserve negative zero/non-finite values; null and
undefined have separate tags. ArrayBuffers encode base64. Blob/File entries also
preserve MIME and File name/lastModified. Dates and bigint have explicit tags.
Unsupported object types and cycles reject the whole export rather than silently
omitting data. Current adapter records use the supported plain-data/byte types.

The exporter holds the snapshot in memory while preparing the Blob. It is not
streaming, does not restore the database, and does not claim to preserve engine
internals or unrecorded auto-increment counters. Store names, keyPath,
autoIncrement configuration and entry keys/values are included. Applications
must provide a download action in their recovery-open error UI; opening a new
Workspace must not overwrite an old root just because restore rejected it.

The four durable demo pages now provide this action in their opening-error
surface. “Prepare retained work download” creates the archive, then exposes a
download link; preparation failures remain retryable. Navigation releases the
temporary object URLs, and late preparation results cannot update an unmounted
surface. The download does not clear stored work or make an incompatible
Workspace editable.
