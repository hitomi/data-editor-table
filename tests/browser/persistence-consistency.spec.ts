import { fulfillExpectedFailure, expect, test, type Page } from './test.js'
import { SourceFixture, deferred } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'

async function mount(page: Page, name: string, restore: boolean) {
  await page.goto('/')
  await page.evaluate(async ({ name, restore }) => {
    document.body.replaceChildren()
    await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, restore)
    const container = document.createElement('div'); document.body.append(container)
    ;(await import('/src/test-fixtures/persistence-consistency.tsx')).mountPersistenceConsistencyFixture(container)
  }, { name, restore })
}
for (const scenario of ['intermediate', 'later', 'reload-failure'] as const) {
  test(`saved authority survives ${scenario}, stale reads and durable reopening`, async ({ page, context }) => {
    const name = `consistency-${scenario}-${crypto.randomUUID()}`
    const source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') }, { a: { value: 'Initial', hidden: { retained: 7 } } })
    const stale = source.snapshot(), response = deferred<void>()
    source.normalize = document => ({ ...document, value: String(document.value).trim() })
    source.submitHook = async (_request, execute) => {
      const applied = execute()
      await response.promise
      return applied
    }
    let failReads = false
    await context.route('**/__kernel-source/*', async route => {
      const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON()
      if (path.endsWith('/read') && failReads) { await fulfillExpectedFailure(route, { status: 503, body: 'Authority read unavailable' }); return }
      const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
    })
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await mount(page, name, false)
    const cell = page.getByRole('grid', { name: 'Persistence consistency' }).getByRole('gridcell')
    await expect(cell).toHaveText('Initial')
    await cell.click()
    await page.getByRole('button', { name: 'Edit value', exact: true }).click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('  Submitted  ')
    await page.getByRole('button', { name: 'Apply value', exact: true }).click()
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect.poll(() => source.writes).toBe(1)
    // The backend has committed, but its exact receipt has not reached the owner.
    expect(source.snapshot().rows[0]!.document).toEqual({ value: 'Submitted', hidden: { retained: 7 } })
    if (scenario === 'later') source.external({ a: { value: 'Later server edit', hidden: { retained: 8 } } })
    if (scenario === 'intermediate') source.readHook = async () => stale
    if (scenario === 'reload-failure') failReads = true
    response.resolve()
    if (scenario !== 'later') {
      await expect(page.getByRole('button', { name: 'Check pending results', exact: true })).toBeEnabled()
      await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
      await expect(cell).not.toHaveText('Initial')
      // A crash here must retain the exact receipt and never create another write.
      source.readHook = null; failReads = false
      await mount(page, name, true)
      const check = page.getByRole('button', { name: 'Check pending results', exact: true })
      await expect(check).toBeEnabled()
      await check.click()
    }
    const expected = scenario === 'later' ? 'Later server edit' : 'Submitted'
    await expect(cell).toHaveText(expected)
    await expect.poll(() => page.evaluate(async () => {
      const snapshot = (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture().getSnapshot()
      return { candidates: snapshot.recovery.plan.candidates.map(item => item.kind), storage: snapshot.storage?.kind, read: snapshot.state.authority.read.kind }
    })).toEqual({ candidates: [], storage: 'idle', read: 'idle' })
    await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
    const authorityBeforeOldRead = await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture().getState().authority.content)
    source.readHook = async () => stale
    await page.getByRole('button', { name: 'Refresh rows', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
    await expect(cell).toHaveText(expected)
    expect(await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture().getState().authority.content)).toEqual(authorityBeforeOldRead)
    source.readHook = null
    await mount(page, name, true)
    await expect(cell).toHaveText(expected)
    await cell.click()
    await page.getByRole('button', { name: 'Edit value', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(expected)
    expect(source.requests).toHaveLength(1)
    expect(source.writes).toBe(1)
    expect(source.snapshot().rows[0]!.document.hidden).toEqual({ retained: scenario === 'later' ? 8 : 7 })
    expect(errors).toEqual([])
  })
}
