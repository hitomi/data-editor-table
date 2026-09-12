import { writeFile } from 'node:fs/promises'
import { expect, test as base, type Page, type Route } from '@playwright/test'
export * from '@playwright/test'

const expectedFailures = new WeakMap<Page, { url: string; message: RegExp }[]>()
const navigationReads = new WeakMap<Page, { origin: string; remaining: number }>()

/** A deliberately interrupted, already durable single-file operation may emit
 * WebKit's native loader diagnostic even though its rejection is caught.
 * Keep this allowance inside the navigation window; real JS events still fail. */
export async function interruptResourceWork(page: Page, interrupt: () => Promise<unknown>) {
  const origin = new URL(page.url()).origin
  if (!expectedFailures.has(page) || navigationReads.has(page)) throw new Error('Resource interruption requires one active runtime-error fixture.')
  navigationReads.set(page, { origin, remaining: 1 })
  try { await Promise.all([page.waitForEvent('load'), interrupt()]) }
  finally { navigationReads.delete(page) }
}
function expectFailure(route: Route, message: RegExp) {
  const failures = expectedFailures.get(route.request().frame().page())
  if (!failures) throw new Error('Expected network failures require the runtime-error fixture.')
  failures.push({ url: route.request().url(), message })
}
/** Only a deliberately injected response, exact URL and single console entry
 * are allowed. Unrelated network errors and React errors still fail the test. */
export async function abortExpectedRequest(route: Route) {
  expectFailure(route, /^Failed to load resource: net::ERR_FAILED$/)
  await route.abort('failed')
}
export async function fulfillExpectedFailure(route: Route, options: Parameters<Route['fulfill']>[0] & { status: number }) {
  if (options.status < 400 || options.status > 599) throw new Error('Expected failure must be an HTTP error.')
  expectFailure(route, new RegExp(`^Failed to load resource: the server responded with a status of ${options.status} \\([^)]*\\)$`))
  await route.fulfill(options)
}

/** Runtime failures are part of workflow acceptance, even when DOM assertions pass. */
export const test = base.extend<{ runtimeErrors: void }>({
  runtimeErrors: [async ({ page, browserName }, use, testInfo) => {
    const errors: string[] = []
    const events: string[] = []
    const consoleStacks: string[] = []
    const interruptedReads: string[] = []
    await page.addInitScript(testLabel => {
      const originalError = console.error
      console.error = function (...args: unknown[]) {
        console.debug('runtime-console-stack:', new Error('console.error call site').stack)
        Reflect.apply(originalError, console, args)
      }
      window.addEventListener('unhandledrejection', event => {
        console.debug('runtime-event:unhandledrejection', String(event.reason?.stack ?? event.reason))
        console.error('runtime-test-owner:', testLabel, location.href, String(event.reason))
      })
      const resizeEvents: unknown[] = []
      const NativeResizeObserver = window.ResizeObserver
      window.ResizeObserver = class extends NativeResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          const created = new Error('ResizeObserver created').stack
          super((entries, observer) => {
            resizeEvents.push({ time: performance.now(), created, entries: entries.map(entry => ({
              element: entry.target.tagName + '.' + entry.target.className,
              width: entry.contentRect.width, height: entry.contentRect.height,
            })) })
            if (resizeEvents.length > 64) resizeEvents.shift()
            callback(entries, observer)
          })
        }
      }
      window.addEventListener('error', event => {
        if (event.message.includes('ResizeObserver')) console.debug('runtime-console-stack:', JSON.stringify(resizeEvents))

        console.debug('runtime-event:error', event.message)
        console.error('runtime-test-owner:', testLabel, location.href, event.message)
      })
    }, testInfo.titlePath.join(' > '))
    const failures: { url: string; message: RegExp }[] = []
    expectedFailures.set(page, failures)
    page.on('console', message => {
      if (message.type() === 'debug' && message.text().startsWith('runtime-console-stack:')) consoleStacks.push(message.text())
      if (message.type() === 'debug' && message.text().startsWith('runtime-event:')) events.push(message.text())
      if (message.type() !== 'error') return
      const text = message.text(), url = message.location().url
      const expected = failures.findIndex(failure => failure.url === url && failure.message.test(text))
      if (expected >= 0) failures.splice(expected, 1)
      else errors.push(`${text} (${url})`)
    })
    page.on('pageerror', error => {
      const details = error.stack ?? error.message, navigation = navigationReads.get(page)
      const url = /^Cannot load (blob:[^\s]+) due to access control checks\.\n/.exec(details)?.[1]
      if (browserName === 'webkit' && navigation && navigation.remaining > 0 && url?.startsWith(`blob:${navigation.origin}/`)
        && /\n\s+at (?:digest|unknown) \([^\n]+\/src\/kernel\/(?:resource-store|indexeddb-recovery)\.ts:\d+:\d+\)/.test(details)) {
        navigation.remaining--; interruptedReads.push(details)
      } else errors.push(details)
    })
    await use()
    if (testInfo.status !== testInfo.expectedStatus && !page.isClosed()) {
      // Capture before closing: unload can unmount the app and erase Playwright's
      // later error-context snapshot, hiding the state that actually failed.
      const screenshot = testInfo.outputPath('failure-page.png'), dom = testInfo.outputPath('failure-dom.html')
      await page.screenshot({ path: screenshot, timeout: 5000 })
      await writeFile(dom, await page.content())
      await testInfo.attach('failure-page', { path: screenshot, contentType: 'image/png' })
      await testInfo.attach('failure-dom', { path: dom, contentType: 'text/html' })
    }
    // Keep the error observers alive through page teardown. The page fixture
    // otherwise closes after this assertion, hiding errors raised on unload.
    if (!page.isClosed()) await page.close()
    if (errors.length || events.length || interruptedReads.length) {
      const path = testInfo.outputPath('runtime-events.json')
      await writeFile(path, JSON.stringify({ errors, events, consoleStacks, interruptedReads }, null, 2))
      await testInfo.attach('runtime-events', { path, contentType: 'application/json' })
    }
    expect(events, 'No actual error or unhandled rejection may be hidden by a native navigation diagnostic.').toEqual([])
    expect(errors, 'The workflow must not emit browser or React runtime errors.').toEqual([])
  }, { auto: true }],
})
