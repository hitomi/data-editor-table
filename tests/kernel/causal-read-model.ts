type Value = number | readonly string[]
type Read = Readonly<{ resource: string; expected: Value }> | Requirement
type Requirement = Readonly<{ resource: string; base: Value; target: Value; reads: readonly Read[] }>
const copy = <T>(value: T): T => structuredClone(value)
const same = (left: Value, right: Value) => JSON.stringify(left) === JSON.stringify(right)

/** Independent expression model: readers hold the expression they consumed.
 * Cancelling a resource's final write removes it from the active requirements,
 * but never changes expressions already held by other readers. No kernel
 * journal, prefix projector, settlement code or production helper is used. */
export class ReferenceCausalReads {
  private authority: Record<string, Value>
  private readonly active = new Map<string, Requirement>()
  constructor(initial: Record<string, Value>) { this.authority = copy(initial) }
  write(resource: string, target: Value, reads: readonly string[] = []) {
    const predecessor = this.active.get(resource)
    const captured = reads.map(name => this.active.get(name) ?? { resource: name, expected: copy(this.authority[name]!) })
    const base = predecessor?.base ?? this.authority[resource]!
    if (same(base, target)) this.active.delete(resource)
    else this.active.set(resource, { resource, base: copy(base), target: copy(target), reads: [...(predecessor?.reads ?? []), ...captured] })
  }
  observe(authority: Record<string, Value>) { this.authority = copy(authority) }
  project() {
    const valid = (read: Read): boolean => 'expected' in read ? same(this.authority[read.resource]!, read.expected)
      : (same(this.authority[read.resource]!, read.base) || same(this.authority[read.resource]!, read.target)) && read.reads.every(valid)
    return Object.fromEntries(Object.entries(this.authority).map(([resource, authority]) => {
      const requirement = this.active.get(resource)
      return [resource, { value: copy(requirement?.target ?? authority), blocked: requirement !== undefined && !valid(requirement),
        save: requirement && valid(requirement) && !same(authority, requirement.target) ? copy(requirement.target) : null }]
    }))
  }
}
