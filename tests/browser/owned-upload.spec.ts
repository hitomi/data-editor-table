import { expect, test, type Page } from './test.js'
const body = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'
const image = `data:image/svg+xml;base64,${Buffer.from(body).toString('base64')}`
async function mount(page: Page, name: string) {
  await page.goto('/')
  await page.evaluate(async name => {
    document.body.replaceChildren()
    const container = document.createElement('div'); document.body.append(container)
    await (await import('/src/test-fixtures/owned-upload.tsx')).mountOwnedUploadFixture(container, name)
  }, name)
}
async function holdConversion(page: Page) {
  await page.evaluate(() => {
    const original = FileReader.prototype.readAsDataURL
    FileReader.prototype.readAsDataURL = function (blob) {
      document.documentElement.setAttribute('data-conversion-started', 'yes')
      document.addEventListener('release-photo', () => { original.call(this, blob) }, { once: true })
    }
  })
}
async function diagnostics(page: Page) { return page.evaluate(async () => (await import('/src/test-fixtures/owned-upload.tsx')).ownedUploadDiagnostics()) }
for (const cancellation of ['none', 'button', 'escape', 'api'] as const) test(`retained upload owner isolates late results after view switch (cancellation=${cancellation})`, async ({ page }) => {
  const cancelled = cancellation !== 'none'
  const name = `owned-upload-${crypto.randomUUID()}`, errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await mount(page, name)
  await holdConversion(page)
  await page.getByRole('grid', { name: 'Photos A' }).getByRole('gridcell').click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  await expect(page.getByLabel('Choose a file', { exact: true })).toBeEnabled()
  if (cancelled) await page.getByLabel('Choose a file', { exact: true }).setInputFiles({ name: 'photo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(body) })
  else await page.locator('main').evaluate((main, body) => {
    const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File([body], 'photo.svg', { type: 'image/svg+xml' }))
    main.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }))
  }, body)
  await expect(page.locator('html')).toHaveAttribute('data-conversion-started', 'yes')
  const cancel = page.getByRole('button', { name: 'Cancel task', exact: true })
  await expect(cancel).toBeEnabled()
  const initial = (await diagnostics(page))[0]!, before = initial.state
  if (cancellation === 'button') await cancel.click()
  if (cancellation === 'api') expect(await page.evaluate(async () => (await import('/src/test-fixtures/owned-upload.tsx')).cancelOwnedUploadTask('A'))).toMatchObject({ kind: 'accepted' })
  if (cancellation === 'escape') {
    await page.getByRole('textbox', { name: 'Photo', exact: true }).press('Escape')
    const task = page.getByRole('region', { name: 'Retained task 1', exact: true })
    await task.focus()
    await task.press('Control+Escape')
    await task.dispatchEvent('keydown', { key: 'Escape', repeat: true })
    await task.dispatchEvent('keydown', { key: 'Escape', isComposing: true })
    expect((await diagnostics(page))[0]!.state.tasks[0]!.kind).toBe('running')
    await task.evaluate(section => {
      section.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      section.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
  }
  if (cancelled) {
    await expect(cancel).toHaveCount(0)
    const after = (await diagnostics(page))[0]!.state
    expect(after.revision).toBe(before.revision + 1)
    expect(after.tasks[0]).toMatchObject({ kind: 'cancelled', input: before.tasks[0]!.input })
  }
  await page.getByRole('button', { name: 'View B', exact: true }).click()
  await expect(page.getByRole('grid', { name: 'Photos B' }).getByRole('gridcell')).toHaveText('Upload B')
  await page.getByRole('grid', { name: 'Photos B' }).getByRole('gridcell').click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  await page.getByRole('textbox', { name: 'Photo', exact: true }).fill('B unfinished input')
  await page.evaluate(() => document.dispatchEvent(new Event('release-photo')))
  await expect.poll(async () => (await diagnostics(page))[0]!.state.tasks[0]!.execution?.outcome?.kind).toBe('succeeded')
  await expect(page.getByRole('textbox', { name: 'Photo', exact: true })).toHaveValue('B unfinished input')
  await expect(page.getByRole('grid', { name: 'Photos B' }).getByRole('img')).toHaveCount(0)
  await page.getByRole('button', { name: 'View A', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'Photo', exact: true })
  await expect(input).toHaveValue(cancelled ? '' : image)
  if (!cancelled) {
    await page.getByRole('button', { name: 'Apply value', exact: true }).click()
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  }
  await mount(page, name)
  if (cancelled) {
    await expect(page.getByRole('grid', { name: 'Photos A' }).getByRole('img')).toHaveCount(0)
    const download = page.getByRole('link', { name: 'Download photo.svg', exact: true })
    await expect(download).toBeVisible()
    const [file] = await Promise.all([page.waitForEvent('download'), download.click()])
    const { readFile } = await import('node:fs/promises')
    expect(await readFile((await file.path())!, 'utf8')).toBe(body)
  } else await expect(page.getByRole('img', { name: 'A photo', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Unused stored files', exact: true })).toHaveCount(0)
  const state = await diagnostics(page)
  expect(state[0]!.authority.rows[0]!.document).toEqual({ name: 'A', photo: cancelled ? '' : image, hidden: 'A' })
  expect(state[1]!.authority.rows[0]!.document).toEqual({ name: 'B', photo: '', hidden: 'B' })
  expect(state[0]!.state.tasks).toHaveLength(1)
  if (cancelled) {
    expect(state[0]!.state.tasks[0]!.kind).toBe('cancelled')
    expect(state[0]!.authority.version).toEqual(initial.authority.version)
  }
  expect(state[1]!.state.session?.rawInput).toEqual({ kind: 'encoded', value: 'B unfinished input' })
  expect(errors).toEqual([])
})

test('permission-blocked file result survives IndexedDB reopening and requires explicit application', async ({ page }) => {
  const name = `permission-upload-${crypto.randomUUID()}`
  await mount(page, name); await holdConversion(page)
  await page.getByRole('grid', { name: 'Photos A' }).getByRole('gridcell').click()
  await page.getByRole('button', { name: 'Edit value', exact: true }).click()
  await page.getByLabel('Choose a file', { exact: true }).setInputFiles({ name: '原始照片.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(body) })
  await expect(page.locator('html')).toHaveAttribute('data-conversion-started', 'yes')
  const original = (await diagnostics(page))[0]!
  const content = (snapshot: typeof original.authority) => ({ scope: snapshot.scope, version: snapshot.version, rows: snapshot.rows, order: snapshot.order })
  expect(await page.evaluate(async () => (await import('/src/test-fixtures/owned-upload.tsx')).setOwnedUploadWritePermission('A', false))).toMatchObject({ kind: 'accepted' })
  await page.evaluate(() => document.dispatchEvent(new Event('release-photo')))
  await expect.poll(async () => (await diagnostics(page))[0]!.state.tasks[0]!.kind).toBe('blocked')
  const blocked = (await diagnostics(page))[0]!
  expect(content(blocked.authority)).toEqual(content(original.authority))
  expect(blocked.state.journal.intents).toEqual([])
  expect(blocked.state.session?.rawInput).toEqual(original.state.session?.rawInput)
  expect(blocked.state.tasks[0]).toMatchObject({ input: original.state.tasks[0]!.input, execution: { outcome: { kind: 'succeeded' } } })
  await mount(page, name)
  const region = page.getByRole('region', { name: 'Retained task 1', exact: true })
  await expect(region.getByText('Task result needs review.', { exact: true })).toBeVisible()
  const download = region.getByRole('link', { name: 'Download 原始照片.svg', exact: true })
  await expect(download).toBeVisible()
  const waiting = page.waitForEvent('download'); await download.click()
  const file = await waiting, { readFile } = await import('node:fs/promises')
  expect(file.suggestedFilename()).toBe('原始照片.svg')
  expect(await readFile((await file.path())!, 'utf8')).toBe(body)
  expect((await diagnostics(page))[0]!.state.tasks[0]).toEqual(blocked.state.tasks[0])
  await expect(page.getByRole('button', { name: 'Apply value', exact: true })).toHaveCount(0)
  expect(await page.evaluate(async () => (await import('/src/test-fixtures/owned-upload.tsx')).setOwnedUploadWritePermission('A', true))).toMatchObject({ kind: 'accepted' })
  await page.getByRole('button', { name: 'Resume editing', exact: true }).click()
  expect(content((await diagnostics(page))[0]!.authority)).toEqual(content(original.authority))
  await page.getByRole('button', { name: 'Use result in this edit', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Photo', exact: true })).toHaveValue(image)
  await page.getByRole('button', { name: 'Apply value', exact: true }).click()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Refresh rows', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
  await mount(page, name)
  await expect(page.getByRole('img', { name: 'A photo', exact: true })).toBeVisible()
  const final = await diagnostics(page)
  expect(final[0]!.authority.rows[0]!.document).toEqual({ name: 'A', photo: image, hidden: 'A' })
  const initialVersion = original.authority.version, finalVersion = final[0]!.authority.version
  if (initialVersion.kind !== 'ordered' || finalVersion.kind !== 'ordered') throw new Error('Fixture requires ordered authority')
  expect(BigInt(finalVersion.position)).toBe(BigInt(initialVersion.position) + 1n)
  expect(final[1]!.authority.rows[0]!.document).toEqual({ name: 'B', photo: '', hidden: 'B' })
  expect(final[0]!.state.tasks).toHaveLength(1)
  expect(final[0]!.state.tasks[0]!.execution).toEqual(blocked.state.tasks[0]!.execution)
  expect(final[0]!.state.inputs.find(record => record.ref.id === original.state.tasks[0]!.input.id)).toMatchObject({ disposition: { kind: 'settled-intents' } })
})
