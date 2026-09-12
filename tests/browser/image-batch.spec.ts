import { expect, test } from './test.js'

test('an image batch keeps original bytes, metadata and captured targets through Workspace recovery', async ({ page }) => {
  const name = `image-batch-${crypto.randomUUID()}`
  await page.goto('/')
  const input = await page.evaluate(async name => {
    const fixture = await import('/src/test-fixtures/durable-workspace.ts')
    await fixture.startDurableWorkspace(name, false, 'manual', false, { refresh: false })
    const { captureImageBatch } = await import('/src/image-batch.ts')
    const files = [new File([new Uint8Array([0, 255, 10, 34])], '原图 "一".png', { type: 'image/png', lastModified: 123 }),
      new File(['<svg/>'], 'two.svg', { type: 'image/svg+xml', lastModified: 456 })]
    const plan = { rows: ['original-a', 'original-b'], mode: 'overwrite-and-append' }
    const batch = captureImageBatch(files, plan)
    plan.rows.reverse(); files.reverse()
    return fixture.workspaceForReactFixture().registerResource(batch)
  }, name)
  await page.reload()
  const restored = await page.evaluate(async ({ name, input }) => {
    const fixture = await import('/src/test-fixtures/durable-workspace.ts')
    await fixture.startDurableWorkspace(name, true, 'manual', false, { refresh: false })
    if (input.kind !== 'resource') throw new Error('Expected a retained resource')
    const blob = fixture.workspaceForReactFixture().getResource(input.id)
    const { decodeImageBatch } = await import('/src/image-batch.ts')
    const batch = await decodeImageBatch(blob)
    const files = await Promise.all(batch.files.map(async file => ({ name: file.name, type: file.type, lastModified: file.lastModified, bytes: [...new Uint8Array(await file.arrayBuffer())] })))
    let truncated = false, extra = false
    try { await decodeImageBatch(blob.slice(0, blob.size - 1, blob.type)) } catch { truncated = true }
    try { await decodeImageBatch(new Blob([blob, 'extra'], { type: blob.type })) } catch { extra = true }
    return { plan: batch.plan, files, truncated, extra }
  }, { name, input })
  expect(restored.plan).toEqual({ rows: ['original-a', 'original-b'], mode: 'overwrite-and-append' })
  expect(restored.files).toEqual([
    { name: '原图 "一".png', type: 'image/png', lastModified: 123, bytes: [0, 255, 10, 34] },
    { name: 'two.svg', type: 'image/svg+xml', lastModified: 456, bytes: [60, 115, 118, 103, 47, 62] },
  ])
  expect(restored.truncated).toBe(true)
  expect(restored.extra).toBe(true)
})

test('batch capture rejects invalid files and oversized plans before accepting a resource', async ({ page }) => {
  await page.goto('/')
  const rejected = await page.evaluate(async () => {
    const { captureImageBatch } = await import('/src/image-batch.ts')
    const file = new File(['x'], 'x.png', { type: 'image/png' })
    return [() => captureImageBatch([], null), () => captureImageBatch(Array(25).fill(file), null),
      () => captureImageBatch([new File(['text'], 'x.txt', { type: 'text/plain' })], null),
      () => captureImageBatch([file], { target: 'x'.repeat(65536) }),
      () => captureImageBatch([new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })], null)]
      .map(operation => { try { operation(); return false } catch { return true } })
  })
  expect(rejected).toEqual([true, true, true, true, true])
})
