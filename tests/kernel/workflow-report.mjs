import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Node-only artifact I/O stays outside the browser-portable kernel TS program.
export async function saveWorkflowMeasurement(report) {
  const directory = process.env.KERNEL_WORKFLOW_REPORT
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, `workflow-${report.mode}-${report.commands}.json`), JSON.stringify({
    ...report, runtime: { node: process.version, bun: process.versions.bun ?? null },
  }, null, 2))
}
