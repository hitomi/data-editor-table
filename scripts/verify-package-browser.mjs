import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { chromium } from '@playwright/test'

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

let browser

try {
  browser = await chromium.launch()
  const page = await browser.newPage()
  const browserErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))
  const verifyGrid = async ({ path, structureOnly }) => {
    await page.goto(`http://127.0.0.1:${address.port}/${path}`)
    await page.getByRole('grid', { name: 'Packed package grid' }).waitFor()
    const cell = page.getByRole('gridcell').filter({ hasText: 'Packed row' })
    await cell.waitFor()
    await cell.click()
    await page.keyboard.press('Enter')
    const editor = page.locator('.data-grid-cell-editor')
    await editor.waitFor()
    const editorBounds = await editor.evaluate((element) => element.getBoundingClientRect().toJSON())
    if (editorBounds.width < 1 || editorBounds.height < 1) {
      throw new Error(`Packed editor has no layout: ${JSON.stringify(editorBounds)}`)
    }
    await editor.fill('Packed edit')
    await page.keyboard.press('Enter')
    await page.getByRole('gridcell').filter({ hasText: 'Packed edit' }).waitFor()

    const editedCell = page.getByRole('gridcell').filter({ hasText: 'Packed edit' })
    await editedCell.click({ button: 'right' })
    const menu = page.locator('.business-grid-menu')
    await menu.waitFor()
    const menuBounds = await menu.evaluate((element) => element.getBoundingClientRect().toJSON())
    if (menuBounds.width < 1 || menuBounds.height < 1) {
      throw new Error(`Packed portal menu has no layout: ${JSON.stringify(menuBounds)}`)
    }
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })

    for (const width of [1440, 1920, 2560, 3840]) {
      await page.setViewportSize({ width, height: 900 })
      const style = await page.locator('.business-grid').evaluate((element) => {
        const computed = getComputedStyle(element)
        const bounds = element.getBoundingClientRect()
        return {
          accent: computed.getPropertyValue('--grid-accent').trim(),
          borderColor: computed.borderColor,
          borderStyle: computed.borderStyle,
          display: computed.display,
          width: bounds.width,
        }
      })
      if (style.display !== 'grid' || style.borderStyle === 'none' || style.width < width - 60) {
        throw new Error(`Packed layout failed at ${width}px: ${JSON.stringify(style)}`)
      }
      if (structureOnly) {
        if (style.accent !== '' || style.borderColor !== 'rgb(124, 58, 237)') {
          throw new Error(`structure.css loaded the default theme or rejected consumer styles: ${JSON.stringify(style)}`)
        }
      } else if (style.accent === '') {
        throw new Error(`styles.css did not load the default theme: ${JSON.stringify(style)}`)
      }
    }
  }

  await verifyGrid({ path: '', structureOnly: false })
  await verifyGrid({ path: '?styles=structure', structureOnly: true })
  if (browserErrors.length > 0) {
    throw new Error(`Packed browser consumer reported errors:\n${browserErrors.join('\n')}`)
  }
  process.stdout.write('Verified packed styles.css and Tailwind-style structure.css consumers in Chromium.\n')
} finally {
  await browser?.close()
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
}
