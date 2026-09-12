import { useEffect, useState } from 'react'
import { canonicalEncodedValue } from '../kernel/document.js'
import type { OwnedInput, ResourceId } from '../kernel/model.js'
import type { Workspace } from '../kernel/workspace.js'
import type { WorkspaceResourceMessages } from './workspace-resource-input.js'

export function WorkspaceInputMaterial({ workspace, input, label, messages }: { workspace: Workspace; input: OwnedInput; label: string; messages: WorkspaceResourceMessages }) {
  if (input.kind === 'encoded') return <textarea aria-label={label} readOnly value={typeof input.value === 'string' ? input.value : canonicalEncodedValue(input.value)} />
  return <FileMaterial workspace={workspace} resourceId={input.id} messages={messages} />
}
function FileMaterial({ workspace, resourceId, messages }: { workspace: Workspace; resourceId: ResourceId; messages: WorkspaceResourceMessages }) {
  const [file, setFile] = useState<Readonly<{ workspace: Workspace; resourceId: ResourceId; download: Readonly<{ url: string; name: string }> | null }> | null>(null)
  useEffect(() => {
    try {
      const blob = workspace.getResource(resourceId), url = URL.createObjectURL(blob)
      setFile({ workspace, resourceId, download: { url, name: blob instanceof File ? blob.name : 'retained-input' } })
      return () => URL.revokeObjectURL(url)
    } catch { setFile({ workspace, resourceId, download: null }); return }
  }, [workspace, resourceId])
  const current = file?.workspace === workspace && file.resourceId === resourceId ? file : null
  return current?.download ? <a href={current.download.url} download={current.download.name}>{messages.download(current.download.name)}</a>
    : <p>{current ? messages.unavailable : messages.preparingDownload}</p>
}
