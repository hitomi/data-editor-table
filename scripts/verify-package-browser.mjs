import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { chromium, firefox, webkit, expect } from '@playwright/test'
import { SourceFixture } from '../tests/kernel/source-fixture.ts'

const outputRoot = resolve(process.argv[2] ?? '')
if (!process.argv[2] || !existsSync(resolve(outputRoot, 'index.html'))) {
  throw new Error('Expected the built isolated browser-consumer directory.')
}

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
])

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
  const candidate = resolve(outputRoot, pathname === '/' ? 'index.html' : `.${pathname}`)
  const pathFromRoot = relative(outputRoot, candidate)
  if (
    pathFromRoot === '..'
    || pathFromRoot.startsWith(`..${sep}`)
    || isAbsolute(pathFromRoot)
    || !existsSync(candidate)
    || !statSync(candidate).isFile()
  ) {
    response.writeHead(404).end('Not found')
    return
  }
  response.writeHead(200, {
    'content-type': mimeTypes.get(extname(candidate)) ?? 'application/octet-stream',
  })
  createReadStream(candidate).pipe(response)
})

await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen)
  server.listen(0, '127.0.0.1', resolveListen)
})

const address = server.address()
if (!address || typeof address === 'string') throw new Error('Could not allocate the package-consumer server.')

try {
  for (const [name, browserType] of [
    ['Chromium', chromium],
    ['Firefox', firefox],
    ['WebKit', webkit],
  ]) {
    await verifyBrowser(name, browserType)
  }
} finally {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
}

async function verifyBrowser(name, browserType) {
  const browser = await browserType.launch()
  try {
    const page = await browser.newPage()
    const browserErrors = []
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
    page.on('pageerror', (error) => browserErrors.push(error.message))
    const verifyGrid = async ({ path, structureOnly }) => {
      const sourceId = structureOnly ? 'packed-structure' : 'packed-theme'
      const source = new SourceFixture({ sourceId, id: 'products', epoch: 'v1' }, { a: { name: 'Packed row', hidden: { retained: 7 } } })
      source.normalize = document => ({ ...document, name: String(document.name).trim().toUpperCase() })
      let loseReply = true
      await page.route('**/__packed-source/*', async route => {
        const operation = new URL(route.request().url()).pathname.split('/').at(-1)
        const body = route.request().postDataJSON()
        const result = operation === 'read' ? await source.readAtLeast() : operation === 'lookup' ? await source.lookupOperation(body) : await source.submit(body)
        if (operation === 'submit' && loseReply) {
          loseReply = false
          // Successful authority write, but the transport has no exact result.
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ kind: 'unknown', issue: { code: 'lost-reply', message: 'Reply unavailable' } }) })
        } else await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
      })
      await page.goto(`http://127.0.0.1:${address.port}/${path}`)
      const grid = page.getByRole('grid', { name: '打包产物表格' })
      const save = page.getByRole('button', { name: '保存更改', exact: true })
      await expect(grid.getByRole('gridcell')).toHaveText('Packed row')
      await expect(save).toBeDisabled()
      await page.getByRole('button', { name: '编辑值', exact: true }).click()
      const editor = page.getByRole('textbox', { name: 'Name', exact: true })
      await expect(editor).toHaveValue('Packed row')
      const editorBounds = await editor.boundingBox()
      if (!editorBounds || editorBounds.width < 1 || editorBounds.height < 1) throw new Error('Packed editor has no layout.')
      await editor.fill('Packed edit')
      await page.getByRole('button', { name: '应用编辑', exact: true }).click()
      await expect(grid.getByRole('gridcell')).toHaveText('Packed edit')
      await save.click()
      await expect(page.getByRole('button', { name: '查询待确认结果', exact: true })).toBeEnabled()
      expect(source.writes).toBe(1)
      await page.getByRole('button', { name: '查询待确认结果', exact: true }).click()
      await expect(grid.getByRole('gridcell')).toHaveText('PACKED EDIT')
      await expect(page.getByRole('button', { name: '刷新数据', exact: true })).toBeEnabled()
      expect(source.requests).toHaveLength(1)
      expect(source.snapshot().rows[0].document).toEqual({ name: 'PACKED EDIT', hidden: { retained: 7 } })
      await page.reload()
      await expect(grid.getByRole('gridcell')).toHaveText('PACKED EDIT')
      await expect(save).toBeDisabled()

      for (const width of [1440, 1920, 2560, 3840]) {
        await page.setViewportSize({ width, height: 900 })
        const style = await page.locator('.business-grid__workspace').evaluate(element => {
          const computed = getComputedStyle(element)
          return { accent: computed.getPropertyValue('--grid-accent').trim(), borderColor: computed.borderColor,
            borderStyle: computed.borderStyle, display: computed.display, width: element.getBoundingClientRect().width }
        })
        if (style.display !== 'grid' || style.borderStyle === 'none' || style.width < width - 60) throw new Error(`Packed layout failed at ${width}px: ${JSON.stringify(style)}`)
        const overflow = await page.evaluate(() => ({ horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight }))
        if (overflow.horizontal > 0 || overflow.vertical > 0) throw new Error(`Packed page overflowed at ${width}px: ${JSON.stringify(overflow)}`)
        if (structureOnly ? style.accent !== '' || style.borderColor !== 'rgb(124, 58, 237)' : style.accent === '')
          throw new Error(`Packed theme isolation failed: ${JSON.stringify(style)}`)
      }
      // Close is explicit, reviewed, and acknowledged before the host leaves.
      await page.getByRole('button', { name: '检查关闭条件', exact: true }).click()
      await page.getByRole('button', { name: '关闭工作区', exact: true }).click()
      await expect(page.locator('body')).toHaveAttribute('data-closed', 'confirmed')
      await page.reload()
      await expect(grid.getByRole('gridcell')).toHaveText('PACKED EDIT')
      expect(source.writes).toBe(1)
      await page.unroute('**/__packed-source/*')
    }

    await verifyGrid({ path: '', structureOnly: false })
    await verifyGrid({ path: '?styles=structure', structureOnly: true })
    if (browserErrors.length > 0) {
      throw new Error(`Packed browser consumer reported errors in ${name}:\n${browserErrors.join('\n')}`)
    }
    process.stdout.write(`Verified packed Workspace editing, exact save recovery, reopening, zh-CN locale, styles.css, and structure.css consumers in ${name}.\n`)
  } finally {
    await browser.close()
  }
}
