import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../src/', import.meta.url))
const domains = new Set([
  'bulk-transitions.ts', 'editing-transitions.ts', 'filter-transitions.ts',
  'session-policy.ts', 'view-transitions.ts', 'draft-commands.ts',
  'source-reconciliation.ts', 'transaction-builder.ts', 'interaction-transitions.ts',
])
const executionModules = new Set([
  'grid-controller.js', 'controller-workflow.js', 'controller-runtime.js',
  'controller-effects.js', 'persistence-effects.js',
])
const failures = []
for (const directory of ['controller', 'data', 'model', 'layout']) {
  for (const file of files(path.join(root, directory))) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
    const source = fs.readFileSync(file, 'utf8')
    for (const { specifier, typeOnly, index } of imports(source)) {
      const reason = boundaryReason(directory, file, specifier, typeOnly)
      if (reason) {
        const line = source.slice(0, index).split('\n').length
        failures.push(`${path.relative(root, file)}:${line}: ${reason} (${specifier})`)
      }
    }
  }
}

function boundaryReason(directory, file, specifier, typeOnly) {
  const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : null
  const target = path.basename(specifier)
  if (/^(react|react-dom)(\/|$)/.test(specifier) || resolved?.startsWith(path.join(root, 'react') + path.sep))
    return 'Engine modules must not import React implementation or declarations.'
  if (directory !== 'controller' && resolved?.startsWith(path.join(root, 'controller') + path.sep))
    return 'Data/model/layout must not depend on controller modules.'
  if (!typeOnly && domains.has(path.basename(file)) && executionModules.has(target))
    return 'Domain transitions must not import facade, workflow, Runtime or I/O runners.'
  if (!typeOnly && path.basename(file) === 'controller-workflow.ts' && executionModules.has(target))
    return 'Workflow prepares transitions; it must not own facade, Runtime or I/O runners.'
  return null
}

if (process.argv.includes('--self-test')) {
  const cases = [
    ['controller', 'editing-transitions.ts', "import { run } from './controller-effects.js'", true],
    ['controller', 'controller-workflow.ts', "import type { GridTransition } from './controller-runtime.js'", false],
    ['controller', 'controller-workflow.ts', "import { type GridTransition } from './controller-runtime.js'", false],
    ['controller', 'controller-workflow.ts', "import { type GridTransition, GridControllerRuntime } from './controller-runtime.js'", true],
    ['data', 'planner.ts', "import { selectedCells } from '../controller/selection-model.js'", true],
    ['model', 'model.ts', "import type { ReactNode } from 'react'", true],
    ['data', 'source.ts', "import('react-dom/client')", true],
    ['data', 'source.ts', "import '../react/data-grid.js'", true],
    ['data', 'planner.ts', "import {\n gridRangeBounds,\n selectedCells,\n} from '../model/range-geometry.js'", false],
  ]
  for (const [directory, filename, source, blocked] of cases) {
    const found = [...imports(source)]
    assert.equal(found.length, 1, `Expected one import: ${source}`)
    const { specifier, typeOnly } = found[0]
    assert.equal(Boolean(boundaryReason(directory, path.join(root, directory, filename), specifier, typeOnly)), blocked, source)
  }
}

// Static import/export declarations used by this repository. Also inspect
// literal side-effect and dynamic imports; packed graph validation remains the
// authoritative transitive headless check. No compiler API dependency is needed.
function* imports(source) {
  const declarations = /^[ \t]*(?:import|export)\s+((?:type\s+)?(?:\{[^}]*\}|[\w*$,\s]+(?:\{[^}]*\})?))\s+from\s*['"]([^'"]+)['"]/gm
  for (const match of source.matchAll(declarations)) {
    const clause = match[1].trim()
    const named = clause.startsWith('{') && clause.endsWith('}') ? clause.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean) : null
    yield {
      specifier: match[2], index: match.index,
      typeOnly: clause.startsWith('type ') || Boolean(named?.length && named.every((item) => item.startsWith('type '))),
    }
  }
  for (const match of source.matchAll(/\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g))
    yield { specifier: match[1], index: match.index, typeOnly: false }
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
}

function* files(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* files(file)
    else yield file
  }
}
