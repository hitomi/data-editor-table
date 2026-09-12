import { expect, it, vi } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { compileFrontierTable } from './frontier-table.js'

it.each(['self', 'future', 'forged-earlier-sequence'])('rejects %s dependencies without publishing a partial action', variant => {
  const fixture = new KernelFixture({ a: { x: 0, hidden: 7 } })
  const prepared = fixture.prepare([fixture.write('a', { x: 1 }), fixture.write('a', { x: 2 })])
  const builder = compileFrontierTable(prepared.frontiers, prepared.intents.map(intent => intent.id))
  const raw = JSON.parse(JSON.stringify(prepared)), before = fixture.state
  raw.intents[0].dependencies = builder.intern([prepared.intents[variant === 'self' ? 0 : 1]!.id])
  raw.frontiers = builder.snapshot()
  if (variant === 'forged-earlier-sequence') raw.intents[1].sequence = 0
  const original = JSON.stringify(raw)
  expect(fixture.dispatch({ kind: 'prepared-action', prepared: raw }).result.kind).toBe('rejected')
  expect(fixture.state).toBe(before)
  expect(fixture.state.inputs).toHaveLength(0)
  expect(JSON.stringify(raw)).toBe(original)
  expect(raw.inputs[0].input).toEqual({ kind: 'encoded', value: 'original input' })
})

it.each([16, 32, 64])('validates a shared %i-intent predecessor once across sixteen fields at admission', count => {
  const fields = Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`field:${index}`, 0]))
  const fixture = new KernelFixture({ a: { x: 0, ...fields, hidden: 7 } })
  for (let value = 1; value <= count; value++) fixture.apply([fixture.write('a', { x: value })])
  const values = { x: count + 1, ...Object.fromEntries(Object.keys(fields).map(key => [key, 1])) }
  const prepared = fixture.prepare([fixture.write('a', values)]), before = fixture.state, original = JSON.stringify(before)
  const ids = new Set(before.journal.intents.map(intent => intent.id)), reverse = Array.prototype.reverse
  let expanded = 0
  const spy = vi.spyOn(Array.prototype, 'reverse').mockImplementation(function (this: unknown[]) {
    if (this.length && this.every(id => ids.has(id as never))) expanded += this.length
    return reverse.call(this)
  })
  let transition: ReturnType<KernelFixture['dispatch']>
  try { transition = fixture.dispatch({ kind: 'prepared-action', prepared }) } finally { spy.mockRestore() }
  expect(transition.result.kind).toBe('accepted')
  expect(JSON.stringify(before)).toBe(original)
  expect(fixture.state.inputs).toHaveLength(count + 1)
  expect(fixture.project().rows[0]!.preview).toEqual({ ...values, hidden: 7 })
  // Counts IDs materialized by ordered frontier expansion, not total admission work.
  expect(expanded).toBeLessThanOrEqual(count * 2)
})
