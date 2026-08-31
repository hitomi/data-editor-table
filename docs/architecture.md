# Legacy architecture archive

This page records only the archived `react-data-grid` implementation. It is
not the architecture or API contract for the current package. New integrations
must use the native v2 API in the [README](../README.md); the current design,
milestones, and verification status live in the
[native grid v2 plan](native-grid-v2-plan.md).

## Archived source tree

The former implementation is isolated under `src-legacy/`:

- `src-legacy/core/` — draft engine, fields, dirty state, ranges, clipboard,
  transforms, and collection-state helpers;
- `src-legacy/react/` — React subscriptions and the `react-data-grid` adapter;
- `src-legacy/ui/` — the former editor, range overlay, bulk editor, image cell,
  and operational grid surfaces;
- `src-legacy/data-source/` — the former registry, data-source contract, actions,
  filter panel, and turnkey `DataSourceDataGrid`;
- `src-legacy/index.ts`, `engine.ts`, `styles.css`, and build entries — archived
  package boundaries used only by the legacy demo.

Its runnable fixture is in `demo-legacy/`; its original unit and browser checks
are in `src-legacy/**/*.test.*` and `tests-legacy/e2e/`. The dedicated legacy
Vite, TypeScript, Vitest, and Playwright configs keep those imports out of the
native v2 declaration and runtime graphs.

## How to run the archive

```sh
pnpm demo:legacy
pnpm demo:legacy:build
pnpm test:legacy
pnpm demo:legacy:test
```

The archive remains available for behavior comparison during M1–M6. It is not
a compatibility promise and must not receive new product features. M7 removes
it together with the `react-data-grid` development dependency after the v2 API
and confirmed interactions have permanent regression coverage.
