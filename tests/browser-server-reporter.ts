import type { FullResult, Reporter } from '@playwright/test/reporter'

/** Vite can receive an unload error after the browser connection has closed.
 * These errors must fail the run even when every page assertion has finished. */
export default class BrowserServerReporter implements Reporter {
  private pending = ''
  private errors = new Set<string>()

  onStdErr(chunk: string | { toString(): string }) {
    this.pending += chunk.toString()
    const lines = this.pending.split('\n')
    this.pending = lines.pop()!
    for (const line of lines) this.inspect(line)
  }

  private inspect(line: string) {
    if (line.includes('[WebServer]') && /\[Unhandled (?:error|rejection)\]/.test(line)) this.errors.add(line)
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult['status'] }> {
    this.inspect(this.pending)
    if (!this.errors.size) return { status: result.status }
    console.error(`Browser server received unhandled runtime errors:\n${[...this.errors].join('\n')}`)
    return { status: 'failed' }
  }

  printsToStdio() { return false }
}
