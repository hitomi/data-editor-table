import assert from 'node:assert/strict'
import { webkit } from '@playwright/test'

// Reproduce the native navigation diagnostic without loading project code.
// Every read rejection is caught; actual error/unhandledrejection events fail.
const browser = await webkit.launch()
const records = []
try {
  for (const continueReading of [false, true]) {
    const page = await browser.newPage(), observed = { continueReading, caught: 0, nativeDiagnostics: [], scriptErrors: [] }
    await page.route('http://127.0.0.1:55599/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Blob navigation probe</title>' }))
    page.on('pageerror', error => observed.nativeDiagnostics.push(error.stack ?? error.message))
    page.on('console', message => {
      if (message.text() === 'read rejection caught') observed.caught++
      if (message.text().startsWith('script failure:')) observed.scriptErrors.push(message.text())
    })
    await page.goto('http://127.0.0.1:55599/')
    await Promise.all([page.waitForEvent('load'), page.evaluate(continueReading => {
      window.addEventListener('unhandledrejection', () => console.log('script failure:unhandledrejection'))
      window.addEventListener('error', () => console.log('script failure:error'))
      const blob = new Blob(['original bytes'])
      const reading = (async () => {
        for (let index = 0; index < 10; index++) {
          try { await blob.slice().arrayBuffer() }
          catch { console.log('read rejection caught'); if (!continueReading) break }
        }
      })()
      reading.catch(() => console.log('script failure:outer operation'))
      location.reload()
    }, continueReading)])
    assert.equal(observed.scriptErrors.length, 0)
    assert.ok(observed.caught > 0, 'The probe must actually interrupt a read.')
    assert.ok(observed.nativeDiagnostics.every(text => /^Cannot load blob:http:\/\/127\.0\.0\.1:55599\/.+ due to access control checks\./.test(text)))
    records.push(observed)
    await page.close()
  }
  console.log(JSON.stringify({ browser: await browser.version(), records }, null, 2))
} finally { await browser.close() }
