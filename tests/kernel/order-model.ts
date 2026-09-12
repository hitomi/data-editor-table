/** Small independent behavioral oracle for explicit full-scope permutations.
 * It deliberately has no kernel types, reducers, dependency code or helpers.
 * Structural mutation and transport remain separate model work. */
export class ReferenceOrder {
  authority: string[]
  private requirement: { original: string[]; desired: string[] } | null = null
  constructor(initial: readonly string[]) { this.authority = [...initial] }
  request(desired: readonly string[]) {
    const original = this.requirement?.original ?? this.authority
    this.requirement = desired.join('\0') === original.join('\0') ? null : { original: [...original], desired: [...desired] }
  }
  observe(authority: readonly string[]) {
    this.authority = [...authority]
    if (this.requirement?.desired.join('\0') === this.authority.join('\0')) this.requirement = null
  }
  project() {
    const desired = this.requirement?.desired ?? this.authority
    const remaining = new Set(this.authority)
    const visible = desired.filter(id => remaining.delete(id))
    visible.push(...remaining)
    return {
      visible,
      blocked: this.requirement !== null && this.requirement.original.join('\0') !== this.authority.join('\0'),
      save: this.requirement && this.requirement.original.join('\0') === this.authority.join('\0') ? [...this.requirement.desired] : null,
    }
  }
}

/** Independent single-action undo oracle. It reasons from the server's actual
 * write and the original user order, not from production journal controls or
 * the order the client happened to receive network messages in. */
export function referenceOrderCompensation(before: readonly string[], canonical: readonly string[] | null, authority: readonly string[]) {
  const equal = (left: readonly string[], right: readonly string[]) => JSON.stringify(left) === JSON.stringify(right)
  // Rejection means this workspace has no write to reverse. A canonical no-op
  // likewise gives undo no outstanding order requirement, even after refresh.
  const required = canonical !== null && !equal(canonical, before) && !equal(authority, before)
  const desired = required ? before : authority
  const visible = desired.filter(id => authority.includes(id))
  for (const id of authority) if (!visible.includes(id)) visible.push(id)
  const blocked = required && !equal(authority, canonical!)
  return { visible, blocked, save: required && !blocked ? [...before] : null }
}
