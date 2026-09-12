import { expect, test } from './test.js'

test('staged bytes and retired identities survive successive IndexedDB roots and page reloads', async ({ page }) => {
  const databaseName = `durable-staged-${crypto.randomUUID()}`
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-recovery.ts')).startDurableFixture(databaseName, false), databaseName)
  const expected = { file: { name: '暂存.txt', lastModified: 456, text: 'staged bytes' }, reuseRejected: true, semanticallyRegistered: false }
  expect(await page.evaluate(async () => (await import('/src/test-fixtures/durable-recovery.ts')).stageDurableFile())).toEqual(expected)
  for (let iteration = 0; iteration < 2; iteration++) {
    await page.reload()
    // Restoration itself commits detach and attach under the new epoch.
    await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-recovery.ts')).startDurableFixture(databaseName, true), databaseName)
    expect(await page.evaluate(async () => (await import('/src/test-fixtures/durable-recovery.ts')).stagedDurableDiagnostics())).toEqual(expected)
  }
})

test('a missing-token lookup permanently fences a later IndexedDB write without advancing the root', async ({ page }) => {
  const databaseName = `durable-negative-${crypto.randomUUID()}`
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-recovery.ts')).startDurableFixture(databaseName, false), databaseName)
  const result = await page.evaluate(async () => (await import('/src/test-fixtures/durable-recovery.ts')).verifyDurableNegativeFence())
  expect(result.proof).toBe('not-committed'); expect(result.late).toBe('not-committed')
  expect(result.after).toEqual(result.before); expect(result.phase).toBe('idle')
})

test('durable input and file bytes survive a page reload with a new fenced lease', async ({ page }) => {
  const databaseName = `durable-reload-${crypto.randomUUID()}`
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-recovery.ts')).startDurableFixture(databaseName, false), databaseName)
  const before = await page.evaluate(async () => (await import('/src/test-fixtures/durable-recovery.ts')).typeDurableInput(['a', 'ab', 'abc']))
  expect(before.rawInput).toEqual({ kind: 'encoded', value: 'abc' }); expect(before.pending).toBe(0)
  await page.reload()
  const after = await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-recovery.ts')).startDurableFixture(databaseName, true), databaseName)
  expect(after.rawInput).toEqual(before.rawInput); expect(after.inputCount).toBe(before.inputCount)
  expect(after.file).toEqual({ name: '恢复.txt', lastModified: 123, text: 'preserved bytes' })
  expect(after.leaseEpoch).not.toBe(before.leaseEpoch)
  expect(after.revision).toBe(before.revision + 2)
})

test('a second tab cannot restore a live owner, and explicit release fences the old runtime', async ({ page, context }) => {
  const databaseName = `durable-exclusive-${crypto.randomUUID()}`
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-recovery.ts')).startDurableFixture(databaseName, false), databaseName)
  await page.evaluate(async () => (await import('/src/test-fixtures/durable-recovery.ts')).typeDurableInput(['owned text']))
  const second = await context.newPage(); await second.goto('/')
  const rejected = await second.evaluate(async databaseName => {
    try { await (await import('/src/test-fixtures/durable-recovery.ts')).startDurableFixture(databaseName, true); return '' }
    catch (error) { return (error as Error).message }
  }, databaseName)
  expect(rejected).toContain('active owner')
  const released = await page.evaluate(async () => (await import('/src/test-fixtures/durable-recovery.ts')).releaseDurableFixture())
  expect(released.phase).toBe('fenced')
  const recovered = await second.evaluate(async databaseName => (await import('/src/test-fixtures/durable-recovery.ts')).startDurableFixture(databaseName, true), databaseName)
  expect(recovered.rawInput).toEqual({ kind: 'encoded', value: 'owned text' })
  expect(recovered.leaseEpoch).not.toBe(released.leaseEpoch)
})

test('a lost IndexedDB commit receipt keeps old published input until the original token is reconciled', async ({ page }) => {
  const databaseName = `durable-unknown-${crypto.randomUUID()}`
  await page.goto('/')
  await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-recovery.ts')).startDurableFixture(databaseName, false), databaseName)
  const unknown = await page.evaluate(async () => (await import('/src/test-fixtures/durable-recovery.ts')).typeDurableInput(['durably stored'], true))
  expect(unknown.phase).toBe('unknown'); expect(unknown.pending).toBe(1)
  expect(unknown.rawInput?.kind).toBe('resource')
  const resolved = await page.evaluate(async () => (await import('/src/test-fixtures/durable-recovery.ts')).reconcileDurableInput())
  expect(resolved.rawInput).toEqual({ kind: 'encoded', value: 'durably stored' })
  expect(resolved.revision).toBe(unknown.revision + 1); expect(resolved.pending).toBe(0)
  await page.reload()
  const recovered = await page.evaluate(async databaseName => (await import('/src/test-fixtures/durable-recovery.ts')).startDurableFixture(databaseName, true), databaseName)
  expect(recovered.rawInput).toEqual(resolved.rawInput); expect(recovered.inputCount).toBe(resolved.inputCount)
})
