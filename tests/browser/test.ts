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
    await page.addInitScript(() => {
      const originalError = console.error
      console.error = function (...args: unknown[]) {
        console.debug('runtime-console-stack:', new Error('console.error call site').stack)
        Reflect.apply(originalError, console, args)
      }
      window.addEventListener('unhandledrejection', event => console.debug('runtime-event:unhandledrejection', String(event.reason?.stack ?? event.reason)))
      window.addEventListener('error', event => console.debug('runtime-event:error', event.message))
    })
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
    if (errors.length || events.length || interruptedReads.length) await testInfo.attach('runtime-events', { body: JSON.stringify({ errors, events, consoleStacks, interruptedReads }, null, 2), contentType: 'application/json' })
    expect(events, 'No actual error or unhandled rejection may be hidden by a native navigation diagnostic.').toEqual([])
    expect(errors, 'The workflow must not emit browser or React runtime errors.').toEqual([])
  }, { auto: true }],
})
