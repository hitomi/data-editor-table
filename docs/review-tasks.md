# Legacy API review tasks (archived)

The completed checklist below applies only to the archived `react-data-grid`
implementation now stored in `src-legacy/`. Its pass counts, review rounds, and
Playwright claims are historical evidence for that implementation; they do not
describe the current native v2 implementation or its acceptance status.

Current v2 scope, open work, and verification status are tracked exclusively in
[业务数据批量编辑器 v2 设计与实施方案](native-grid-v2-plan.md).

As of 2026-08-31, that plan records M1–M4 as technically complete, M5 as a test
candidate awaiting user acceptance, and the permanent v2 regression suite in
M6 as not started. None of the archived checks below should be used to upgrade
that status.

This checklist records the contract issues found during the full API review and the regression proof required before the review goal can close.

- [x] Make the packed declarations valid under strict TypeScript `NodeNext`, and verify the actual archive from a clean consumer.
- [x] Keep CSS out of the declaration graph while preserving the documented `styles.css` subpath.
- [x] Add a React-free `react-data-grid-ext/engine` runtime and declaration entry.
- [x] Enforce `isEditable` for editors, renderer updates, actions, paste, clear and image changes.
- [x] Route context and toolbar action updates through immediate persistence in `update` mode.
- [x] Preserve partial commits: submit accepted rows while retaining validation/conflict rejections with field-level recovery.
- [x] Make persistence and draft-observer metadata stable snapshots instead of live mutable maps.
- [x] Repair explicit commit receipts for deletion, ordering, partial acceptance and edits made while a request is in flight.
- [x] Prevent deep sparse-view proxy chains, stale conflicts after field reconfiguration, and append-then-delete dirty divergence.
- [x] Replace the engine hook's unbounded strong identity cache with a component-scoped weak identity cache.
- [x] Model authoritative collection snapshots as a discriminated union so errors cannot render as empty success.
- [x] Bind cell type names to field/renderer value types and verify the packed public contract with positive and negative type cases.
- [x] Reject duplicate/empty field keys and report invalid or ambiguous select parsing.
- [x] Preserve exact dirty baseline values separately from formatted display text.
- [x] Remove the range hook's hard-coded `row.id: string` identity contract and support derived string column keys.
- [x] Honor declared bulk-operation subsets and reset bulk input only when the editing session changes.
- [x] Expose a real retry path for save failures, including falsy thrown values.
- [x] Connect registered clipboard formatting/parsing/clear behavior through the turnkey grid.
- [x] Compose the turnkey grid with frozen row indicators, range selection, selection overlays and selected row/column feedback.
- [x] Surface dirty state at cell, row and column granularity with formatted original values.
- [x] Add controlled filtering and sorting over a complete authoritative source without treating hidden rows as deleted.
- [x] Connect selected visible columns to a default registry-backed bulk editor with preserved input and atomic application.
- [x] Add product-neutral typed column filters with per-type operators, all/any conditions and controlled filter groups.
- [x] Reject mixed-validity matrix paste atomically instead of persisting a partial matrix.
- [x] Serialize/coalesce persistence attempts, reuse an idempotent operation id on retry, and retain edits made in flight.
- [x] Reject delayed receipts after a newer authoritative version, isolate attempts by data-source identity, and require secure random operation ids.
- [x] Reuse the same engine and persistence queue when a mounted grid switches away from and later returns to a data-source identity.
- [x] Bind delayed renderer/action persistence to the source that rendered the callback and switch visible-owner state only after React commits.
- [x] Keep an auto-save debounce per data-source owner so detached asynchronous edits are still persisted.
- [x] Cancel stale auto-save timers when persistence mode changes; preserve explicit-save consent and immediately flush update mode.
- [x] Freeze each attempt's transport and cancel queued automatic follow-ups when switching to explicit save.
- [x] Bind range, bulk, filter and action sessions to their source identity; preserve form input but reject cross-source apply.
- [x] Ignore invalid controlled filter conditions without letting one stale condition short-circuit an `any` group.
- [x] Verify that `commitRows` synchronously published its returned snapshot and replay edits captured immediately before receipt publication.
- [x] Make filter/sort setters synchronously publish their controlled snapshot so async completion cannot reorder view state.
- [x] Version authoritative snapshots and persistence receipts so source refreshes and in-flight saves have an explicit optimistic-concurrency contract.
- [x] Preserve explicit local structural order intent across remote rebase with a documented local-wins policy; remote-only rows retain their authority slots.
- [x] Run unit, type, lint, packed-consumer, demo-build and Playwright workflow verification.
- [x] Repeat independent full reviews through a ninth pass and resolve every reproducible P0/P1 issue before closing the goal.
- [x] Preserve bulk/filter modal input across controlled view refreshes, reject stale bulk sessions atomically, and expose dirty state to assistive technology.
- [x] Keep toolbar/context actions synchronized with keyboard navigation and clear them when the grid selection is cancelled.
- [x] Replace the relabelled single-cell multi-clear workaround with a discriminated, eligibility-aware selection action contract.
- [x] Preserve `null` and `undefined` values in repeating fill sequences instead of falling back to the active source cell.
- [x] Give registered image editors an explicit commit/cancel lifecycle so navigation cannot leave the grid trapped in edit mode.
- [x] Keep the fill handle visually centered without extending the Grid's scroll layout at the terminal row or column.
- [x] Make column-header activation select the visible column and move sorting to an explicit trailing action.
- [x] Match column-header press feedback to row selectors without flashing RDG's active-cell outline before selection.
- [x] Let header and image interaction backgrounds reach the cell borders while preserving normal content padding.
- [x] Require a double-click for pointer image uploads while preserving keyboard activation and drag-and-drop uploads.
- [x] Keep every demo image row editable so double-click and drag-and-drop examples behave consistently.
- [x] Support modifier-based row multi-selection and duplicate the selected rows as one ordered batch.
- [x] Support continuous row selection by dragging directly across the frozen row indicators.
- [x] Route cell, row and column pointer gestures through one selection controller so pointer-down selects immediately and movement only extends.
- [x] Route pointer, keyboard, context-menu, paste and select-all range writes through the same selection transition boundary.
- [x] Resolve renderer, context-menu and toolbar actions through one field runtime and update boundary.
- [x] Couple the active action target and context-menu coordinates in one action session so keyboard navigation cannot leave a stale menu open.
- [x] Route every local engine mutation through one persistence-scheduling boundary.
- [x] Share controlled sorting, global-filter and column-filter publication validation and error handling.
