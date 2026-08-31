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
  await page.goto(`http://127.0.0.1:${address.port}/`)
  await page.getByRole('grid', { name: 'Packed package grid' }).waitFor()
  await page.getByRole('gridcell').filter({ hasText: 'Packed row' }).waitFor()
  const style = await page.locator('.business-grid').evaluate((element) => {
    const computed = getComputedStyle(element)
    return {
      accent: computed.getPropertyValue('--grid-accent').trim(),
      borderStyle: computed.borderStyle,
      display: computed.display,
    }
  })
  if (style.display !== 'grid' || style.borderStyle === 'none' || style.accent === '') {
    throw new Error(`Packed styles were not applied: ${JSON.stringify(style)}`)
  }
  if (browserErrors.length > 0) {
    throw new Error(`Packed browser consumer reported errors:\n${browserErrors.join('\n')}`)
  }
  process.stdout.write('Verified packed root runtime and styles.css in Chromium.\n')
} finally {
  await browser?.close()
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
}
