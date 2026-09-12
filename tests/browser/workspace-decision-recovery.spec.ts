import { expect, test } from './test.js'
import { SourceFixture } from '../kernel/source-fixture.js'
import { kernelId } from '../../src/kernel/model.js'
for (const cancel of [false, true]) test(`decision undo retains its complete bundle across reviewed retargeting and reload (cancel=${cancel})`, async ({ page, context }) => {
  const name = `decision-${crypto.randomUUID()}`, source = new SourceFixture({ sourceId: name, id: kernelId<'scope'>('scope'), epoch: kernelId<'scope-epoch'>('epoch') },
    { a: { value: 'Alpha', hidden: 7 }, b: { value: 'Beta', hidden: 8 } })
  await context.route('**/__kernel-source/*', async route => {
    const path = route.request().url(), body = route.request().postDataJSON()
    const result = path.endsWith('/read') ? await source.readAtLeast() : path.endsWith('/lookup') ? await source.lookupOperation(body) : await source.submit(body)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
  })
  async function mount(restore: boolean) {
    await page.goto('/')
    await page.evaluate(async ({ name, restore }) => {
      document.body.replaceChildren()
      await (await import('/src/test-fixtures/durable-workspace.ts')).startDurableWorkspace(name, restore)
      const container = document.createElement('div'); document.body.append(container)
      ;(await import('/src/test-fixtures/workspace-grid.tsx')).mountEditableWorkspaceGrid(container)
    }, { name, restore })
  }
  await mount(false)
  for (const text of ['first original', 'second original']) {
    await page.getByRole('button', { name: 'Edit value', exact: true }).click()
    await page.getByRole('textbox', { name: 'Edit value', exact: true }).fill(text)
    await page.getByRole('button', { name: 'Apply value', exact: true }).click()
    await expect(page.getByRole('gridcell').first()).toHaveText(text)
  }
  source.external({ a: { value: 'Server', hidden: 9 }, b: { value: 'Beta', hidden: 8 } })
  await page.getByRole('button', { name: 'Refresh rows', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  const resolved = await page.evaluate(async () => {
    const workspace = (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture()
    const state = workspace.getState(), row = workspace.getProjection().rows[0]!
    if (state.authority.content.kind !== 'complete') throw new Error('Missing authority')
    return workspace.resolve({ revision: state.revision, observation: state.authority.content.snapshot.observation,
      issueIds: row.issues.map(issue => issue.id), target: { kind: 'row', entityId: row.entityId }, choice: { kind: 'use-authority' } })
  })
  expect(resolved.kind, JSON.stringify(resolved)).toBe('accepted')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Recovered decision input', exact: true })
  await expect(panel.getByRole('textbox', { name: 'Original input 1', exact: true })).toHaveValue('first original')
  await expect(panel.getByRole('textbox', { name: 'Original input 2', exact: true })).toHaveValue('second original')
  await mount(true)
  await panel.getByLabel('Starting text').selectOption({ label: 'Original input 2' })
  await panel.getByRole('button', { name: 'Review recovery target', exact: true }).click()
  await page.getByRole('gridcell', { name: 'Beta', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Open reviewed recovery edit', exact: true })).toBeDisabled()
  await panel.getByRole('button', { name: 'Review recovery target', exact: true }).click()
  await expect(panel).toContainText('Beta')
  if (!cancel) await page.evaluate(async () => (await import('/src/test-fixtures/durable-workspace.ts')).loseNextWorkspaceAcknowledgement())
  await panel.getByRole('button', { name: 'Open reviewed recovery edit', exact: true }).click()
  if (!cancel) {
    await expect(panel.getByRole('textbox')).toHaveCount(2)
    await page.getByRole('button', { name: 'Check pending results', exact: true }).click()
  }
  await expect(page.getByRole('textbox', { name: 'Edit value', exact: true })).toHaveValue('second original')
  await expect(panel.getByRole('textbox')).toHaveCount(2)
  await mount(true)
  await page.getByRole('button', { name: 'Resume editing', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Edit value', exact: true })).toHaveValue('second original')
  await expect(panel.getByRole('textbox')).toHaveCount(2)
  await page.getByRole('button', { name: cancel ? 'Discard input' : 'Apply value', exact: true }).click()
  await expect(panel).toHaveCount(0)
  if (!cancel) {
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  }
  await mount(true)
  await expect(panel).toHaveCount(0)
  await expect(page.getByRole('gridcell')).toHaveText(['Server', cancel ? 'Beta' : 'second original'])
  expect(source.writes).toBe(cancel ? 0 : 1)
  expect(source.snapshot().rows.map(row => row.document)).toEqual([{ value: 'Server', hidden: 9 }, { value: cancel ? 'Beta' : 'second original', hidden: 8 }])
  const dispositions = await page.evaluate(async () => {
    const state = (await import('/src/test-fixtures/durable-workspace.ts')).workspaceForReactFixture().getState(), recovery = state.recoveries[0]!
    return recovery.inputs.map(ref => state.inputs.find(input => input.ref.id === ref.id && input.ref.version === ref.version)!.disposition.kind)
  })
  expect(dispositions).toEqual([cancel ? 'cancelled-session' : 'settled-intents', cancel ? 'cancelled-session' : 'settled-intents'])
})
