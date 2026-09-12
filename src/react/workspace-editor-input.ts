import { encodedValuesEqual } from '../kernel/document.js'
import type { EditorLease, OwnedInput, Session } from '../kernel/model.js'
import type { Workspace } from '../kernel/workspace.js'

/** Browser composition/input events can describe the same update twice. Compare
 * against the owner's latest pending input, not a React render or raw draft copy.
 * Explicit Workspace commands still retain every request, including old leases. */
export function writeBrowserEditorInput(workspace: Workspace, lease: EditorLease, input: OwnedInput, composition: Session['composition']) {
  const snapshot = workspace.getSnapshot()
  const projection = workspace.getInputProjection(lease)
  if (snapshot.capabilities.close.lifecycle === 'open' && projection && projection.status !== 'blocked' && projection.status !== 'rejected') {
    const pending = snapshot.ingress.pending.find(entry => entry.id === projection.ingressId)
    const currentComposition = pending?.payload.kind === 'input' ? pending.payload.envelope.composition : projection.session.composition
    const sameInput = input.kind === 'encoded' && projection.input.kind === 'encoded' ? encodedValuesEqual(input.value, projection.input.value)
      : input.kind === 'resource' && projection.input.kind === 'resource' && input.id === projection.input.id
    if (sameInput && composition === currentComposition) return false
  }
  workspace.typeInput(lease, input, composition)
  return true
}
