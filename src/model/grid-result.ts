import type { GridPoint, GridRowKey, GridValueResult } from './grid-model.js'

export type GridIssueCode =
  | 'busy' | 'closed' | 'invalid-input' | 'session-open' | 'permission-denied'
  | 'conflict' | 'stale-target' | 'source-unavailable' | 'save-in-progress'
  | 'save-unresolved' | 'no-changes' | 'no-recovery' | 'invalid-configuration' | 'limit-exceeded'
  | 'adapter-error'

export type GridIssue = Readonly<{
  code: GridIssueCode
  message: string
  cell?: GridPoint<GridRowKey>
  target?: Readonly<{ kind: 'row'; rowKey: GridRowKey }> | Readonly<{ kind: 'order' }>
  domainCode?: string
}>

export type GridCommandResult<Value = unknown> =
  | Readonly<{ accepted: true; revision: number; value: Value }>
  | Readonly<{ accepted: false; revision: number; issue: GridIssue }>

/** Carries an admission issue through synchronous preparation. */
export class GridIssueError extends Error {
  readonly issue: GridIssue
  constructor(issue: GridIssue, options?: ErrorOptions) {
    super(issue.message, options)
    this.issue = Object.freeze({ ...issue })
  }
}

export function gridValueIssue(issue: Extract<GridValueResult<unknown>, { ok: false }>['issue'], code: GridIssueCode = 'invalid-input'): GridIssue {
  return Object.freeze({ code: issue.code === 'exception' ? 'adapter-error' : code, message: issue.message, domainCode: issue.code })
}

export function gridExceptionIssue(error: unknown): GridIssue {
  return error instanceof GridIssueError ? error.issue : Object.freeze({
    code: 'adapter-error', message: error instanceof Error ? error.message : String(error),
  })
}

/** Internal construction failure; React exposes its issue without guessing
 * error codes from exception text. Headless construction still throws. */
export class GridConfigurationError extends GridIssueError {
  constructor(message: string, options?: ErrorOptions) {
    super({ code: 'invalid-configuration', message }, options)
  }
}
