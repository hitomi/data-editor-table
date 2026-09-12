import { expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

test('React shows retained ingress during unknown storage and remounts the same owner without losing input', async ({ page, context }) => {
  const databaseName = `workspace-react-${crypto.randomUUID()}`
  const source = new SourceFixture({ sourceId: databaseName, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial', hidden: 7 } })
  await context.route('**/__kernel-source/*', async route => {
    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto('/')
  await page.evaluate(async databaseName => {
    const fixture = await import('/src/test-fixtures/durable-workspace.ts')
    await fixture.startDurableWorkspace(databaseName, false)
    await fixture.retainRejectedWorkspaceFile()
    document.body.replaceChildren()
    const container = document.createElement('div'); container.id = 'workspace-view'; document.body.append(container)
    const view = await import('/src/test-fixtures/workspace-view.tsx')
    view.captureWorkspaceViewOwner('original'); view.mountWorkspaceView(container)
  }, databaseName)
  const input = page.getByRole('textbox', { name: 'Workspace input' })
  await expect(input).toHaveValue('original')
  const initialRenders = await page.evaluate(async () => (await import('/src/test-fixtures/workspace-view.tsx')).workspaceViewOwner('original').renders)
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).loseNextWorkspaceAcknowledgement())
  await input.fill('retained original')
  await expect(page.getByLabel('Storage state')).toHaveText('unknown')
  await expect(input).toHaveValue('retained original')
  await expect(page.getByLabel('Published input')).toHaveText('original')
  expect(await page.evaluate(async () => (await import('/src/test-fixtures/workspace-view.tsx')).workspaceViewOwner('original').renders)).toBe(initialRenders)
  await page.evaluate(async () => (await import('/src/test-fixtures/workspace-view.tsx')).unmountWorkspaceView())
  await expect(input).toHaveCount(0)
  expect(await page.evaluate(async () => (await import('/src/test-fixtures/workspace-view.tsx')).workspaceViewOwner('original').subscriptions)).toBe(0)
  const owner = await page.evaluate(async () => {
    const workspace = (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture()
    return { lifecycle: workspace.requestClose().lifecycle, raw: workspace.getSnapshot().editorInput?.input }
  })
  expect(owner).toEqual({ lifecycle: 'open', raw: { kind: 'encoded', value: 'retained original' } })
  await page.evaluate(async () => (await import('/src/test-fixtures/workspace-view.tsx')).mountWorkspaceView(document.getElementById('workspace-view')!))
  await expect(input).toHaveValue('retained original')
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).reconcileWorkspaceInput())
  await expect(page.getByLabel('Published input')).toHaveText('retained original')
  await expect(page.getByLabel('Storage state')).toHaveText('idle')
  await input.fill('next edit')
  await expect(page.getByLabel('Published input')).toHaveText('next edit')
  expect(source.writes).toBe(0); expect(errors).toEqual([])
})


test('switching the same React view between owners preserves both inputs and isolates later updates', async ({ page, context }) => {
  const names = [crypto.randomUUID(), crypto.randomUUID()]
  const sources = new Map(names.map(name => [name, new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial', hidden: 7 } })]))
  await context.route('**/__kernel-source/*', async route => {
    const body = route.request().postDataJSON(), source = sources.get(body.scope.sourceId)!
    const path = new URL(route.request().url()).pathname
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto('/')
  await page.evaluate(async names => {
    const fixture = await import('/src/test-fixtures/durable-workspace.ts'), view = await import('/src/test-fixtures/workspace-view.tsx')
    await fixture.startDurableWorkspace(names[0]!, false); await fixture.retainRejectedWorkspaceFile()
    view.captureWorkspaceViewOwner('A'); await view.typeIntoWorkspaceViewOwner('A', 'A input')
    await fixture.startDurableWorkspace(names[1]!, false); await fixture.retainRejectedWorkspaceFile()
    view.captureWorkspaceViewOwner('B'); await view.typeIntoWorkspaceViewOwner('B', 'B input')
    document.body.replaceChildren()
    const container = document.createElement('div'); document.body.append(container)
    view.mountWorkspaceView(container); view.selectWorkspaceViewOwner('A')
  }, names)
  const input = page.getByRole('textbox', { name: 'Workspace input' })
  await expect(input).toHaveValue('A input')
  await page.evaluate(async () => (await import('/src/test-fixtures/workspace-view.tsx')).selectWorkspaceViewOwner('B'))
  await expect(input).toHaveValue('B input')
  await expect(page.getByLabel('Published input')).toHaveText('B input')
  await expect.poll(() => page.evaluate(async () => {
    const view = await import('/src/test-fixtures/workspace-view.tsx')
    return ['A', 'B'].map(name => view.workspaceViewOwner(name).subscriptions)
  })).toEqual([0, 2])
  await page.evaluate(async () => (await import('/src/test-fixtures/workspace-view.tsx')).typeIntoWorkspaceViewOwner('A', 'A later'))
  await expect(input).toHaveValue('B input')
  await input.fill('B edited')
  await expect(page.getByLabel('Published input')).toHaveText('B edited')
  await page.evaluate(async () => (await import('/src/test-fixtures/workspace-view.tsx')).selectWorkspaceViewOwner('A'))
  await expect(input).toHaveValue('A later')
  const owners = await page.evaluate(async () => {
    const fixture = await import('/src/test-fixtures/workspace-view.tsx')
    return ['A', 'B'].map(name => fixture.workspaceViewOwner(name))
  })
  expect(owners.map(owner => [owner.lifecycle, owner.raw])).toEqual([
    ['open', { kind: 'encoded', value: 'A later' }], ['open', { kind: 'encoded', value: 'B edited' }],
  ])
  expect([...sources.values()].map(source => source.writes)).toEqual([0, 0])
  expect(errors).toEqual([])
})
