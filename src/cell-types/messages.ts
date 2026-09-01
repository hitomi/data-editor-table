export function resolveCellTypeMessages<Messages extends object>(
  defaults: Messages,
  overrides: Partial<Messages> | undefined,
): Readonly<Messages> {
  return Object.freeze({ ...defaults, ...overrides })
}

export function formatDefaultApplyToCells(count: number): string {
  return count === 1 ? 'Apply to 1 cell' : `Apply to ${count} cells`
}
