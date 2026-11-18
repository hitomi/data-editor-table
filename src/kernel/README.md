# Kernel source provenance

The initial 39 TypeScript files were copied from commit
`7f873a95ae9747e16b65c302090977fbc78701c4` on
`codex/state-kernel-rewrite-backup-20260912`: the relative-import dependency
closure of `transition.ts`, `history-command.ts`, `schema.ts`, `prepare.ts`,
`submission.ts`, and `resolution.ts`, including type dependencies.

The original authority, journal, contribution history, exact receipt and
projection algorithms remain together. Integration changes are:

- `gateway.ts` also comes from that backup, with its recovery reservation type
  local to the gateway instead of importing the durable scanner. It serializes
  physical source/scope writes and retains uncertain-operation ownership.
- `submission.ts` permits drafting while waiting with a gateway reservation, so
  asynchronous hashing can prepare and then freeze the same reviewed revision.
- `resolution.ts` adds explicit contribution restoration without requiring a
  conflict, and atomic multi-row restoration under one undoable application.
- `transition.ts` accepts that restoration event and settles projection evidence
  through the same reduction boundary.

Some type dependencies retain ingress, checkpoint, resource-store and durable
task definitions and implementations. They are not enabled by this integration.
The original Controller owns sessions and task permissions; its Runtime publishes
one `KernelState` through synchronous `controller/data-backend.ts`. There is no
Workspace, durable storage barrier or second writable rows state.

No backup tests, Workspace facade, React components, CSS or replacement demo UI
were copied. The original four demo UIs use a source adapter whose IndexedDB
transaction implementation is adapted from the backup demo source; it persists
only authority and operation outcomes, not Controller sessions or journal.

The product is wired to this kernel. Code status, inspected workflows and
functional acceptance limits are recorded in
`docs/state-kernel-refactor-plan.md` and `docs/state-kernel-entrypoints.md`.
Controller, kernel and adapter regression tests run with `pnpm test`. The
browser suites and packed consumer checks also run under `pnpm run prepublishOnly`.
