import { persistenceGateway, type DefinitiveResult, type ScopeDisputeEvent } from '../kernel/gateway.js'
import type { ScopeIdentity } from '../kernel/model.js'
import type { DocumentCodec } from '../kernel/schema.js'
import type { PersistenceSource, ServerAuthority } from '../kernel/source.js'
import type { GridRowKey } from '../model/grid-model.js'
import { validateAuthorityRows } from './grid-document.js'
import type { GridAuthorityReader } from './kernel-data-source.js'

/** An adapter owns its row decoder, feed connection and a strong reference to
 * the shared view for offline reopening. Its physical scope owns admission. */
export function createGridAuthoritySync<Row>(options: {
  scope: ScopeIdentity
  source: PersistenceSource
  model: { codec: DocumentCodec<Row> }
  getRowKey(row: Row): GridRowKey
  initialAuthority?: ServerAuthority
  subscribe?: (listener: (snapshot: ServerAuthority) => void) => () => void
}) {
  const gateway = persistenceGateway(options.source), scope = gateway.authority(options.scope)
  const getSnapshot = scope.retainSnapshot()
  const validate = (rows: ServerAuthority['rows']) => validateAuthorityRows(rows, options.model.codec, options.getRowKey)
  const publish = (snapshot: ServerAuthority) => { scope.publish(snapshot, validate) }
  if (options.initialAuthority) publish(options.initialAuthority)
  const current = getSnapshot()
  if (current) validate(current.rows)
  let readers = 0
  let disconnect: (() => void) | undefined
  const reader: GridAuthorityReader = {
    readAtLeast: async required => (await gateway.readAtLeast(options.scope, required, validate)).version,
    subscribe(notify) {
      const release = scope.subscribe({ notify, validate })
      if (++readers === 1 && options.subscribe) {
        let active = true
        try {
          const stop = options.subscribe(snapshot => { if (active) publish(snapshot) })
          disconnect = () => { active = false; stop() }
        } catch (error) {
          active = false
          readers--
          release()
          throw error
        }
      }
      let closed = false
      return () => {
        if (closed) return
        closed = true
        release()
        if (--readers === 0) {
          const stop = disconnect
          disconnect = undefined
          stop?.()
        }
      }
    },
  }
  return { ...reader, getSnapshot, publish,
    getDispute: (id?: string) => gateway.getDispute(options.scope, id),
    subscribeDisputes: (listen: (event: ScopeDisputeEvent) => void) => gateway.subscribeDisputes(options.scope, listen),
    resolveDispute: (id: string, result: DefinitiveResult) => gateway.resolveDispute(options.scope, id, result, validate),
  }
}
