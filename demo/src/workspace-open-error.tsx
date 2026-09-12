import { useEffect, useRef, useState } from 'react'
import { exportIndexedDbRecoveryDatabase } from '../../src/index.js'

export function WorkspaceOpenError({ databaseName, message, retryLabel, retry }: {
  databaseName: string; message: string; retryLabel: string; retry: () => void
}) {
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false)
  const [download, setDownload] = useState<{ database: string; url: string } | null>(null)
  const epoch = useRef(0), urls = useRef(new Set<string>())
  useEffect(() => {
    epoch.current++
    const owned = urls.current
    return () => { epoch.current++; for (const url of owned) URL.revokeObjectURL(url); owned.clear() }
  }, [databaseName])
  async function prepare() {
    if (busy) return
    const generation = epoch.current
    setBusy(true); setFailed(false)
    try {
      const blob = await exportIndexedDbRecoveryDatabase(databaseName)
      if (generation !== epoch.current) return
      const url = URL.createObjectURL(blob); urls.current.add(url)
      setDownload({ database: databaseName, url })
    } catch { if (generation === epoch.current) setFailed(true) }
    finally { if (generation === epoch.current) setBusy(false) }
  }
  return <section aria-label="Workspace recovery">
    <p role="alert">{message}</p>
    <p>Download the stored records and files before asking for help recovering this workspace.</p>
    <button type="button" disabled={busy} onClick={retry}>{retryLabel}</button>{' '}
    {download?.database === databaseName ? <a href={download.url} download={`${databaseName}-recovery.json`}>Download retained work</a>
      : <button type="button" disabled={busy} onClick={() => { void prepare() }}>{busy ? 'Preparing retained work…' : 'Prepare retained work download'}</button>}
    {failed ? <p role="alert">The download could not be prepared. Your stored work has not been changed. Try preparing it again.</p> : null}
  </section>
}
