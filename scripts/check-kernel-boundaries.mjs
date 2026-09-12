import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../src/', import.meta.url))
const failures = []
// Production code must not reintroduce the removed state implementation,
// including through old types or view helpers.
function migrated(file) {
  const relative = path.relative(root, file).split(path.sep).join('/')
  return /^(?:kernel\/|react\/workspace-|locales\/workspace-)/.test(relative)
    || /^(?:index|engine|clipboard|value-codecs)\.ts$/.test(relative)
}
function importsLegacy(file, specifier) {
  if (!specifier.startsWith('.')) return false
  const relative = path.relative(root, path.resolve(path.dirname(file), specifier)).split(path.sep).join('/')
  return /^(?:controller|data|model|layout|cell-types)\//.test(relative)
    || relative.startsWith('react/') && !relative.startsWith('react/workspace-')
    || relative.startsWith('locales/') && !relative.startsWith('locales/workspace-')
}
for (const file of files(root)) {
  if (!migrated(file) || !/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue
  const source = fs.readFileSync(file, 'utf8')
  for (const { specifier, index } of imports(source)) if (importsLegacy(file, specifier))
    failures.push(`${path.relative(root, file)}:${source.slice(0, index).split('\n').length}: Workspace production code must not import legacy implementation or types (${specifier})`)
}
for (const file of files(root)) {
  if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue
  const relative = path.relative(root, file).split(path.sep).join('/')
  if (!relative.startsWith('kernel/') && !/^(?:engine|clipboard|value-codecs)\.ts$/.test(relative)) continue
  const source = fs.readFileSync(file, 'utf8')
  for (const { specifier, index } of imports(source)) if (importsReact(file, specifier))
    failures.push(`${relative}:${source.slice(0, index).split('\n').length}: Headless modules must not import React implementation or types (${specifier})`)
}
function importsReact(file, specifier) {
  return /^(react|react-dom)(\/|$)/.test(specifier)
    || specifier.startsWith('.') && path.resolve(path.dirname(file), specifier).startsWith(path.join(root, 'react') + path.sep)
}

if (process.argv.includes('--self-test')) {
  for (const [file, specifier, blocked] of [
    ['kernel/projection.ts', '../data/rebase-draft.js', true],
    ['kernel/model.ts', '../model/grid-model.js', true],
    ['react/workspace-data-grid.tsx', './data-grid.js', true],
    ['react/workspace-data-grid.tsx', '../cell-types/contracts.js', true],
    ['index.ts', './locales/zh-cn.js', true],
    ['index.ts', './react/workspace-data-grid.js', false],
    ['react/workspace-data-grid.tsx', '../kernel/workspace.js', false],
    ['engine.ts', './value-codecs.js', false],
  ]) {
    const source = path.join(root, file)
    assert.equal(migrated(source), true)
    assert.equal(importsLegacy(source, specifier), blocked, `${file}: ${specifier}`)
  }
  for (const source of ["import type { ReactNode } from 'react'", "import('react-dom/client')", "import '../react/workspace-data-grid.js'", "export * from '../react/workspace-react.js'"]) {
    const found = [...imports(source)]
    assert.equal(found.length, 1)
    assert.equal(importsReact(path.join(root, 'kernel/example.ts'), found[0].specifier), true)
  }
  for (const source of ["import type { Document } from './model.js'", "import { type Document } from './model.js'", "import {\n kernelId,\n type Document,\n} from './model.js'"]) {
    const found = [...imports(source)]
    assert.equal(found.length, 1)
    assert.equal(importsReact(path.join(root, 'kernel/example.ts'), found[0].specifier), false)
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
