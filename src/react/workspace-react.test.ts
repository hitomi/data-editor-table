import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { permissivePolicy, permissiveSchema } from '../../tests/kernel/fixtures.js'
import { kernelId } from '../kernel/model.js'
import { Workspace, type WorkspaceSnapshot } from '../kernel/workspace.js'
import { useWorkspaceSelector, useWorkspaceSnapshot } from './workspace-react.js'

function Observer({ workspace, snapshot }: { workspace: Workspace; snapshot?: WorkspaceSnapshot }) {
  return createElement('span', null, useWorkspaceSnapshot(workspace, snapshot).state.revision)
}
function setup() {
  const scope = { sourceId: crypto.randomUUID(), id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }
  const source = new SourceFixture(scope, {})
  return { source, workspace: new Workspace({ scope, source, schema: permissiveSchema, policy: permissivePolicy }) }
}

describe('Workspace React server observation', () => {
  it('renders the supplied observation without reading a newer state or starting I/O', async () => {
    const { workspace, source } = setup(), snapshot = workspace.getSnapshot()
    await workspace.refresh()
    const reads = source.reads
    expect(workspace.getState().revision).toBeGreaterThan(snapshot.state.revision)
    expect(renderToString(createElement(Observer, { workspace, snapshot }))).toBe('<span>0</span>')
    expect(source.reads).toBe(reads); expect(source.writes).toBe(0)
    expect(workspace.requestClose().lifecycle).toBe('open')
  })
  it('requires the host to supply its SSR observation', () => {
    const { workspace } = setup()
    expect(() => renderToString(createElement(Observer, { workspace }))).toThrow('getServerSnapshot')
  })
})

it('selects from the explicit server snapshot without introducing a live-state mirror', async () => {
  const { workspace } = setup(), snapshot = workspace.getSnapshot()
  await workspace.refresh()
  function Selected() {
    const selected = useWorkspaceSelector(workspace, snapshot => ({ revision: snapshot.state.revision }), {
      serverSnapshot: snapshot, isEqual: (left, right) => left.revision === right.revision,
    })
    return createElement('span', null, selected.revision)
  }
  expect(renderToString(createElement(Selected))).toBe('<span>0</span>')
})
