import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { canonicalEncodedValue } from './document.js'
import type { EncodedValue, ExactReceipt, ServerIdentity } from './model.js'
import { serverIdentityKey } from './protocol.js'
import type { ServerAuthority } from './source.js'

const digest = (value: EncodedValue) => bytesToHex(sha256(new TextEncoder().encode(canonicalEncodedValue(value))))

/** Complete reads and exact receipts can both constrain a version's rows.
 * An order result attests all members, even when it has no canonical documents
 * for the untouched rows. Digests allow decoded documents to be collected. */
export type VersionContent = Readonly<{
  members?: ReadonlySet<string>
  order?: string
  documents: ReadonlyMap<string, string | null>
}>

export function contentEvidence(observation: ServerAuthority | ExactReceipt) {
  let order: readonly ServerIdentity[] | undefined
  const documents = new Map<string, string | null>(), identities: ServerIdentity[] = []
  const row = (identity: ServerIdentity, value: string | null) => {
    identities.push(identity)
    documents.set(serverIdentityKey(identity), value)
  }
  if ('rows' in observation) {
    order = observation.order
    for (const entry of observation.rows) row(entry.identity, digest(entry.document))
  } else for (const item of observation.results) {
    if (item.kind === 'ordered') order = item.canonicalOrder
    else row(item.identity, item.kind === 'deleted' ? null : digest(item.canonical))
  }
  const ids = order?.map(serverIdentityKey)
  const content: VersionContent = { documents, ...(ids ? { members: new Set(ids), order: digest(ids) } : {}) }
  return { identities: order ? [...identities, ...order] : identities, content }
}

export class VersionContentConflict extends Error {}

export function joinContent(known: VersionContent | undefined, incoming: VersionContent): VersionContent {
  const members = known?.members ?? incoming.members
  const contradicts = () => { throw new VersionContentConflict('The source returned inconsistent row content or order that contradicts prior evidence for this version.') }
  if (known?.order && incoming.order && known.order !== incoming.order) contradicts()
  const novel = new Map<string, string | null>()
  for (const [id, value] of incoming.documents) {
    if (members && members.has(id) !== (value !== null)) contradicts()
    const prior = known?.documents.get(id)
    if (prior !== undefined && value !== prior) contradicts()
    if (prior === undefined) novel.set(id, value)
  }
  if (!known) return incoming
  if (!known.members && members) for (const [id, value] of known.documents) {
    if (members.has(id) !== (value !== null)) contradicts()
  }
  if (!novel.size && members === known.members) return known
  return { ...known, ...(incoming.order ? { order: incoming.order } : {}), ...(members ? { members } : {}),
    documents: novel.size ? new Map([...known.documents, ...novel]) : known.documents }
}
