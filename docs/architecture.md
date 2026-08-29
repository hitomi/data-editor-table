# Extensibility contract

## Design goal

An application should render a working editable table by supplying two stable objects:

1. a `DataGridDataSource`, which owns authoritative rows, persistence, and server-side capabilities;
2. a `DataGridCellTypeRegistry`, which owns value-specific rendering, editing, clipboard behavior, clearing, and actions.

The Grid Engine remains internal draft infrastructure. Applications may still use its low-level exports, but the normal integration should not reconstruct dirty tracking, save orchestration, or `react-data-grid` columns.

## Ownership boundaries

### Data source

The data source publishes a stable external-store snapshot through `getSnapshot` and `subscribe`. It also declares exactly one persistence mode:

- `update`: every edit is handed to the data source immediately;
- `save-dirty`: the Grid presents an explicit save action;
- `auto-save`: the Grid sends a debounced dirty proposal.

Persistence requests contain the complete proposed row order, accepted keys, deleted keys, field-level dirty originals, and an abort signal. A successful callback does not optimistically clear dirty state. The data source must publish its new authoritative snapshot, after which the engine rebases and clears only confirmed changes.

`observeDraft` is a projection hook for devtools, patch previews, navigation guards, and other non-authoritative consumers. It must not become another writer.

Server-controlled behaviors live under `capabilities`. Sorting currently follows this contract: the Grid reports `SortColumn[]`; the source performs local or remote ordering and publishes both rows and the accepted sort state. Filtering, pagination, grouping, and row commands should be added as sibling capabilities instead of unrelated top-level callbacks.

### Cell type registry

A field names a `type`. The matching registry entry supplies:

- display renderer;
- optional editor;
- clipboard formatting/parsing;
- clear semantics;
- type-specific actions.

Image upload is one registry entry created by `createDataGridImageCellTypeRenderer`. Its upload and URL resolution are injected by the application. The main Grid has no image branch.

Registration is intentionally explicit and rejects duplicate names. Applications can create separate registries when different workspaces need different behavior for the same conceptual value.

### Actions and surfaces

An action describes capability, not placement. It receives the current typed cell context and can update the value. `DataGridActionSurfaces` decides presentation:

- `renderCell` for hover or always-visible cell controls;
- `renderContext` for right-click, long-press, or command-palette presentation;
- `renderToolbar` for a top or floating toolbar tied to the active cell.

The package supplies a small default context menu when type actions exist and no context presenter is injected. Hosts may replace it without reimplementing action eligibility or execution. Action errors are routed through `onActionError`.

Selection-wide and column-wide actions should extend the same model with distinct typed contexts; they should not overload the cell context with nullable fields.

## Extension rules

- Add a new value behavior through the type registry, not a conditional in `DataSourceDataGrid`.
- Add a new backend/view behavior through a data-source capability, not an uncontrolled Grid prop.
- Add a new action placement through an action surface, not a duplicate action definition.
- Keep authoritative state in the data source and transient edits in the engine.
- Keep application storage, upload APIs, localization, dialogs, and business commands outside this package.
