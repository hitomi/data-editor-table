/** Independent single-row structural history specification. Logical lifetimes
 * are integers, unrelated to kernel IDs or backend business keys. The model
 * intentionally covers create/delete templates, not field/order composition. */
export type StructureDocument = Readonly<Record<string, number | string>>
const copy = (document: StructureDocument): StructureDocument => ({ ...document })

export class ReferenceStructure {
  readonly stored = new Map<number, StructureDocument>()
  readonly everStored = new Set<number>()
  private serial = 0
  private applied = false
  private started = false
  private applicationLifetime: number | null = null
  private deletedDocument: StructureDocument
  private visible: { lifetime: number; document: StructureDocument } | null
  writes = 0
  constructor(readonly kind: 'create' | 'delete', readonly template: StructureDocument, readonly restoreDeleted: boolean) {
    this.deletedDocument = copy(template)
    this.visible = kind === 'delete' ? { lifetime: 0, document: copy(template) } : null
    if (kind === 'delete') { this.stored.set(0, copy(template)); this.everStored.add(0) }
  }
  project() { return this.visible ? { lifetime: this.visible.lifetime, document: copy(this.visible.document) } : null }
  begin() {
    if (this.started) throw new Error('Template already applied')
    this.started = true; this.apply()
  }
  private apply() {
    if (this.kind === 'create') {
      this.applicationLifetime = ++this.serial
      this.visible = { lifetime: this.applicationLifetime, document: copy(this.template) }
    } else {
      if (!this.visible) throw new Error('No live row to delete')
      this.applicationLifetime = this.visible.lifetime
      this.deletedDocument = copy(this.visible.document)
      this.visible = null
    }
    this.applied = true
  }
  undo() {
    if (!this.started || !this.applied) throw new Error('No structural action to undo')
    const lifetime = this.applicationLifetime!
    if (this.kind === 'create') this.visible = null
    else if (this.stored.has(lifetime)) this.visible = { lifetime, document: copy(this.stored.get(lifetime)!) }
    else if (!this.everStored.has(lifetime)) this.visible = { lifetime, document: copy(this.deletedDocument) }
    else {
      if (!this.restoreDeleted) throw new Error('The source cannot restore deleted rows')
      this.visible = { lifetime: ++this.serial, document: copy(this.deletedDocument) }
    }
    this.applied = false
  }
  redo() {
    if (!this.started || this.applied) throw new Error('No structural action to redo')
    this.apply()
  }
  changes(): readonly Readonly<{ kind: 'create' | 'delete'; lifetime: number; document: StructureDocument }>[] {
    const deletes = [...this.stored].filter(([lifetime]) => lifetime !== this.visible?.lifetime).map(([lifetime, document]) => ({ kind: 'delete' as const, lifetime, document: copy(document) }))
    const creates = this.visible && !this.stored.has(this.visible.lifetime) ? [{ kind: 'create' as const, lifetime: this.visible.lifetime, document: copy(this.visible.document) }] : []
    return [...deletes, ...creates]
  }
  commit(normalize: (document: StructureDocument) => StructureDocument) {
    const changes = this.changes()
    if (!changes.length) return
    for (const change of changes) {
      if (change.kind === 'delete') {
        // Restoration uses what was actually deleted, including canonical
        // hidden fields, rather than the first template's old snapshot.
        if (this.kind === 'delete' && change.lifetime === this.applicationLifetime) this.deletedDocument = copy(change.document)
        this.stored.delete(change.lifetime)
      } else {
        const canonical = copy(normalize(change.document))
        this.stored.set(change.lifetime, canonical); this.everStored.add(change.lifetime)
        if (this.visible?.lifetime === change.lifetime) this.visible = { lifetime: change.lifetime, document: canonical }
      }
    }
    this.writes++
  }
}
