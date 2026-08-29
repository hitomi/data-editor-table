# react-data-grid-ext

An extracted, product-neutral editing layer for `react-data-grid`. It combines the original Huifan grid implementation with the correctness and interaction work later made in Cellophane, without changing either application's current imports.

## Included

- React-free baseline/draft engine with dirty fields, validation messages, conflicts, source rebase, append/delete/reorder, bounded undo/redo and partial commit planning.
- Fine-grained row, order, metadata and dirty-state subscriptions, plus React hooks for dirty columns, rows and original values.
- React hooks and a `react-data-grid` row-change adapter.
- Operational collection states that distinguish initial loading, retained refresh, empty, filtered-empty and failure.
- Contiguous and discontinuous range selection, keyboard extension, clipboard matrices, fill handling, context targeting and viewport-synchronized overlays.
- Image cells with click/drop validation and explicit object-URL cleanup ownership.
- A dependency-free bulk editor panel for text, number, select and tag fields.
- Themeable CSS with no Huifan or Cellophane application tokens.

Application-specific image upload/storage and product bulk actions remain outside the package. The package stages files and applies row transforms; the host owns persistence, localized copy and its dialog/popover shell.

## Install and use

```sh
pnpm add react-data-grid-ext react-data-grid
```

```tsx
import {
  OperationalDataGrid,
  useDataGridEngine,
  useDataGridRangeSelection,
} from 'react-data-grid-ext'
import 'react-data-grid-ext/styles.css'
```

The host owns columns, editors, toolbar/footer content and localized state/error copy. Override `--rdg-ext-accent`, `--rdg-ext-text`, and `--rdg-ext-muted` on `.operational-data-grid-surface` to theme the surface.

## Source provenance

The initial grid engine, React adapter, field model, selection state machine and operational shell came from `../huifan/packages/ui/src/data-grid`. The extracted baseline then incorporates Cellophane's changes from `src/core/data-grid`, `src/features/data-grid`, and `src/features/data/OperationalDataGrid.tsx`, including append/delete, partial commit, cell errors, conflict recovery, stable ordering, bounded selection operations and retained refresh/error states.

The package remains `UNLICENSED` because the source repositories do not currently provide an outbound license for their own code. Choose and document a license before publishing it outside the owner-controlled repositories.
