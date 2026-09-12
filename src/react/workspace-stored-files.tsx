import { useEffect, useState } from 'react'
import { referencedResources, inputResources } from '../kernel/resource-ownership.js'
import { ingressInputs } from '../kernel/ingress.js'
import type { ResourceId } from '../kernel/model.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'

export type WorkspaceStoredFileMessages = Readonly<{ label: string; review: string; release: string; failed: string; preparing: string; unavailable: string; download(name: string): string }>
function File({ workspace, resourceId, snapshot, messages }: { workspace: Workspace; resourceId: ResourceId; snapshot: WorkspaceSnapshot; messages: WorkspaceStoredFileMessages }) {
  const [download, setDownload] = useState<{ workspace: Workspace; resourceId: ResourceId; url: string; name: string } | null>(null)
  const [unavailable, setUnavailable] = useState(false), [review, setReview] = useState<{ workspace: Workspace; revision: number } | null>(null), [pending, setPending] = useState(false), [failed, setFailed] = useState(false)
  useEffect(() => {
    try {
      const blob = workspace.getResource(resourceId), url = URL.createObjectURL(blob)
      setDownload({ workspace, resourceId, url, name: blob instanceof globalThis.File ? blob.name : 'retained-file' }); setUnavailable(false)
      return () => URL.revokeObjectURL(url)
    } catch { setUnavailable(true); return }
  }, [workspace, resourceId])
  const current = download?.workspace === workspace && download.resourceId === resourceId ? download : null
  const ready = snapshot.capabilities.close.lifecycle === 'open' && !snapshot.ingress.pending.length && !snapshot.recovery.running
    && (!snapshot.storage || snapshot.storage.kind === 'idle') && review?.workspace === workspace && review.revision === snapshot.state.revision
  async function release() {
    if (!ready || pending) return
    setPending(true); setFailed(false)
    try { setFailed((await workspace.releaseResource(resourceId)).kind !== 'accepted') }
    catch { setFailed(true) }
    finally { setPending(false); setReview(null) }
  }
  return <li>
    {current ? <a href={current.url} download={current.name}>{messages.download(current.name)}</a> : <p>{unavailable ? messages.unavailable : messages.preparing}</p>}
    <label><input type="checkbox" checked={review?.workspace === workspace && review.revision === snapshot.state.revision} disabled={pending} onChange={event => setReview(event.target.checked ? { workspace, revision: snapshot.state.revision } : null)} />{messages.review}</label>
    <button disabled={!ready || pending} onClick={() => { void release() }}>{messages.release}</button>
    {failed ? <p role="alert">{messages.failed}</p> : null}
  </li>
}
/** Staged bytes can outlive registration without ever reaching a session/task.
 * Historical and retained-request references continue to pin their files. */
export function WorkspaceStoredFiles({ workspace, snapshot, messages }: { workspace: Workspace; snapshot: WorkspaceSnapshot; messages: WorkspaceStoredFileMessages }) {
  const referenced = referencedResources(snapshot.state), retained = inputResources(ingressInputs(snapshot.ingress))
  const files = snapshot.state.resources.filter(record => record.status === 'available' && !referenced.has(record.descriptor.id) && !retained.has(record.descriptor.id))
  if (!files.length) return null
  return <section aria-label={messages.label}><h3>{messages.label}</h3><ul>{files.map(file => <File key={`${snapshot.state.workspace.id}:${file.descriptor.id}`} workspace={workspace} resourceId={file.descriptor.id} snapshot={snapshot} messages={messages} />)}</ul></section>
}
