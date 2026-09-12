import { useEffect, useState } from 'react'
import { canonicalEncodedValue } from '../kernel/document.js'
import { ingressInputs, type IngressPayload } from '../kernel/ingress.js'
import type { IngressId, ResourceId } from '../kernel/model.js'
import type { Workspace, WorkspaceSnapshot } from '../kernel/workspace.js'
import { useWorkspaceSnapshot } from './workspace-react.js'

export type WorkspaceIngressRecoveryMessages = Readonly<{
  archive: string; archiveLabel: string; exportRequest: string; label: string; explanation: string; noInput: string; discard: string; changed: string; resourceUnavailable: string; preparingDownload: string
  request(index: number): string; input(index: number): string; download(name: string): string
}>

function ResourceDownload({ workspace, ingressId, resourceId, messages }: { workspace: Workspace; ingressId: IngressId; resourceId: ResourceId; messages: WorkspaceIngressRecoveryMessages }) {
  const [resource, setResource] = useState<Readonly<{ workspace: Workspace; ingressId: IngressId; resourceId: ResourceId;
    download: Readonly<{ url: string; name: string }> | null }> | null>(null)
  useEffect(() => {
    try {
      const blob = workspace.getIngressResource(ingressId, resourceId), url = URL.createObjectURL(blob)
      setResource({ workspace, ingressId, resourceId, download: { url, name: blob instanceof File ? blob.name : 'retained-input' } })
      return () => URL.revokeObjectURL(url)
    } catch { setResource({ workspace, ingressId, resourceId, download: null }); return }
  }, [workspace, ingressId, resourceId])
  const current = resource?.workspace === workspace && resource.ingressId === ingressId && resource.resourceId === resourceId ? resource : null
  return current?.download ? <a href={current.download.url} download={current.download.name}>{messages.download(current.download.name)}</a>
    : <p>{current ? messages.resourceUnavailable : messages.preparingDownload}</p>
}

function RequestArchive({ workspace, ingressId, payload, messages }: { workspace: Workspace; ingressId: IngressId; payload: IngressPayload; messages: WorkspaceIngressRecoveryMessages }) {
  const [download, setDownload] = useState<{ workspace: Workspace; ingressId: IngressId; payload: IngressPayload; url: string } | null>(null)
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([canonicalEncodedValue(payload)], { type: 'application/json' }))
    setDownload({ workspace, ingressId, payload, url })
    return () => URL.revokeObjectURL(url)
  }, [workspace, ingressId, payload])
  const current = download?.workspace === workspace && download.ingressId === ingressId && download.payload === payload ? download : null
  return current ? <a href={current.url} download={`retained-request-${ingressId}.json`}>{messages.exportRequest}</a> : <p>{messages.preparingDownload}</p>
}

/** Rejected requests are still owned work. Present their complete input bundle
 * before one explicit disposition of the reviewed set. This also includes all
 * dependent retained inputs; unresolved commits can never be disposed here. */
export function WorkspaceIngressRecovery({ workspace, messages, serverSnapshot }: Readonly<{
  workspace: Workspace; messages: WorkspaceIngressRecoveryMessages; serverSnapshot?: WorkspaceSnapshot
}>) {
  const snapshot = useWorkspaceSnapshot(workspace, serverSnapshot)
  const [failure, setFailure] = useState<Readonly<{ workspace: Workspace; generation: number }> | null>(null)
  const entries = snapshot.ingress.pending.filter(entry => entry.phase === 'rejected' || entry.phase === 'blocked')
  const archives = snapshot.ingress.receipts.filter(receipt => receipt.disposition === 'returned' && receipt.returned)
  if (!entries.length && !archives.length) return null
  const canDiscard = snapshot.capabilities.close.lifecycle === 'open' && entries.length === snapshot.ingress.pending.length
    && (!snapshot.storage || snapshot.storage.kind === 'idle') && !snapshot.recovery.running
  async function dispose(disposition: 'discarded' | 'returned') {
    try {
      await workspace.disposeIngress(entries.map(entry => entry.id), snapshot.ingress.generation, disposition)
      setFailure(null)
    } catch { setFailure({ workspace, generation: workspace.getIngress().generation }) }
  }
  return <section aria-label={messages.label}>
    {entries.length ? <p>{messages.explanation}</p> : null}
    {entries.map((entry, index) => {
      const inputs = ingressInputs({ generation: snapshot.ingress.generation, pending: [entry], receipts: [] })
      return <section key={entry.id} aria-label={messages.request(index + 1)}>
        <h3>{messages.request(index + 1)}</h3>
        {inputs.length ? inputs.map((input, inputIndex) => input.kind === 'encoded'
          ? <textarea key={inputIndex} aria-label={messages.input(inputIndex + 1)} readOnly value={typeof input.value === 'string' ? input.value : canonicalEncodedValue(input.value)} />
          : <ResourceDownload key={inputIndex} workspace={workspace} ingressId={entry.id} resourceId={input.id} messages={messages} />)
          : <p>{messages.noInput}</p>}
      </section>
    })}
    {entries.length ? <>
      <button type="button" disabled={!canDiscard} onClick={() => { void dispose('returned') }}>{messages.archive}</button>
      <button type="button" disabled={!canDiscard} onClick={() => { void dispose('discarded') }}>{messages.discard}</button>
    </> : null}
    {archives.length ? <section aria-label={messages.archiveLabel}><h3>{messages.archiveLabel}</h3>{archives.map((receipt, index) => {
      const inputs = ingressInputs({ generation: snapshot.ingress.generation, pending: [], receipts: [receipt] })
      return <section key={receipt.id} aria-label={messages.request(index + 1)}>
        <RequestArchive workspace={workspace} ingressId={receipt.id} payload={receipt.returned!} messages={messages} />
        {inputs.map((input, inputIndex) => input.kind === 'encoded'
          ? <textarea key={inputIndex} aria-label={messages.input(inputIndex + 1)} readOnly value={typeof input.value === 'string' ? input.value : canonicalEncodedValue(input.value)} />
          : <ResourceDownload key={inputIndex} workspace={workspace} ingressId={receipt.id} resourceId={input.id} messages={messages} />)}
      </section>
    })}</section> : null}
    {failure?.workspace === workspace && failure.generation === snapshot.ingress.generation ? <p role="alert">{messages.changed}</p> : null}
  </section>
}
