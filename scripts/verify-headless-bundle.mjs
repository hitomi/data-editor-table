import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'

const packageRoot = process.argv[2]
if (!packageRoot) throw new Error('Expected the extracted package root.')

const distRoot = resolve(packageRoot, 'dist')

const verifyGraph = (entry, kind) => {
  const visited = new Set()

  const visit = (file) => {
    const absolute = resolve(file)
    assertInsideDist(absolute)
    if (visited.has(absolute)) return
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(`Headless ${kind} dependency does not exist: ${absolute}`)
    }
    visited.add(absolute)

    const source = readFileSync(absolute, 'utf8')

    for (const dependency of collectModuleSpecifiers(source, absolute)) {
      if (!dependency.specifier.startsWith('.')) {
        throw new Error(
          `Headless ${kind} graph imports external dependency "${dependency.specifier}" in ${relative(distRoot, absolute)}.`,
        )
      }
      visit(resolveRelativeDependency(absolute, dependency.specifier, kind))
    }
  }

  visit(resolve(distRoot, entry))
  return visited.size
}

const collectModuleSpecifiers = (source, fileName) => {
  const dependencies = []
  const tokens = tokenize(source)
  const addString = (token, syntax) => {
    if (token?.kind !== 'string') {
      throw new Error(`Headless dependency graph contains a non-literal ${syntax} in ${fileName}.`)
    }
    dependencies.push({ specifier: token.value, syntax })
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind !== 'word') continue
    if (token.value === 'require') {
      if (tokens[index + 1]?.value === '(') addString(tokens[index + 2], 'require')
      continue
    }
    if (token.value !== 'import' && token.value !== 'export') continue

    const next = tokens[index + 1]
    if (token.value === 'import' && next?.value === '.') continue
    if (token.value === 'import' && next?.value === '(') {
      addString(tokens[index + 2], 'dynamic import')
      continue
    }
    if (token.value === 'import' && next?.kind === 'string') {
      addString(next, 'bare import')
      continue
    }

    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor]
      if (candidate.value === ';') break
      if (
        candidate.kind === 'word' &&
        candidate.value === 'from' &&
        tokens[cursor + 1]?.kind === 'string'
      ) {
        addString(tokens[cursor + 1], 'static import/export')
        break
      }
    }
  }

  for (const match of source.matchAll(/\/\/\/\s*<reference\s+(?:path|types)=["']([^"']+)["']/g)) {
    dependencies.push({ specifier: match[1], syntax: 'triple-slash reference' })
  }
  return dependencies
}

const tokenize = (source) => {
  const tokens = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    if (/\s/.test(character)) {
      index += 1
      continue
    }
    if (character === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2)
      if (index === -1) break
      continue
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end === -1) throw new Error('Unterminated block comment in packed headless output.')
      index = end + 2
      continue
    }
    if (character === '/' && canStartRegularExpression(tokens[tokens.length - 1])) {
      let inCharacterClass = false
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2
          continue
        }
        if (source[index] === '[') inCharacterClass = true
        else if (source[index] === ']') inCharacterClass = false
        else if (source[index] === '/' && !inCharacterClass) break
        index += 1
      }
      if (source[index] !== '/') throw new Error('Unterminated regular expression in packed headless output.')
      index += 1
      while (index < source.length && /[A-Za-z]/.test(source[index])) index += 1
      continue
    }
    if (character === '"' || character === "'") {
      const quote = character
      let value = ''
      index += 1
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
          index += 1
          if (index >= source.length) break
        }
        value += source[index]
        index += 1
      }
      if (source[index] !== quote) throw new Error('Unterminated string in packed headless output.')
      index += 1
      tokens.push({ kind: 'string', value })
      continue
    }
    if (character === '`') {
      index += 1
      while (index < source.length && source[index] !== '`') {
        if (source[index] === '\\') index += 1
        index += 1
      }
      if (source[index] !== '`') throw new Error('Unterminated template in packed headless output.')
      index += 1
      continue
    }
    if (/[A-Za-z_$]/.test(character)) {
      let value = character
      index += 1
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) {
        value += source[index]
        index += 1
      }
      tokens.push({ kind: 'word', value })
      continue
    }
    tokens.push({ kind: 'punctuation', value: character })
    index += 1
  }
  return tokens
}

const canStartRegularExpression = (previous) => {
  if (!previous) return true
  if (previous.kind === 'word') {
    return ['case', 'else', 'return', 'throw', 'yield', 'await'].includes(previous.value)
  }
  return ['(', '[', '{', '=', ':', ',', ';', '!', '?', '>', '&', '|', '+', '-', '*', '%', '~'].includes(previous.value)
}

const resolveRelativeDependency = (from, specifier, kind) => {
  const base = resolve(dirname(from), specifier)
  const candidates = kind === 'declaration'
    ? declarationCandidates(base)
    : runtimeCandidates(base)
  const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
  if (!found) {
    throw new Error(
      `Cannot resolve headless ${kind} dependency "${specifier}" from ${relative(distRoot, from)}.`,
    )
  }
  assertInsideDist(found)
  return found
}

const declarationCandidates = (base) => {
  const extension = extname(base)
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return [`${base.slice(0, -extension.length)}.d.ts`]
  }
  if (extension === '.ts') return [base]
  return [`${base}.d.ts`, resolve(base, 'index.d.ts')]
}

const runtimeCandidates = (base) => {
  if (extname(base)) return [base]
  return [base, `${base}.js`, `${base}.mjs`, resolve(base, 'index.js')]
}

const assertInsideDist = (file) => {
  const pathFromDist = relative(distRoot, file)
  if (
    pathFromDist === '..'
    || pathFromDist.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(pathFromDist)
  ) {
    throw new Error(`Headless dependency escapes the packed dist directory: ${file}`)
  }
}

const runtimeModules = verifyGraph('engine.js', 'runtime')
const declarationModules = verifyGraph('engine.d.ts', 'declaration')
process.stdout.write(
  `Verified isolated headless graphs: ${runtimeModules} runtime modules, ${declarationModules} declaration modules.\n`,
)
