import { expect, it } from 'vitest'
import { KernelFixture } from '../../tests/kernel/fixtures.js'
import { SourceFixture } from '../../tests/kernel/source-fixture.js'
import { compileSharedStateBases } from './shared-state-bases.js'
import type { ExpectedResource } from './model.js'

it('compiles coalesced exact settlement without replacing it with later authority or another state cache', async () => {
  const fixture = new KernelFixture({a:{x:0,hidden:7},b:{x:0,hidden:8}})
  const source = new SourceFixture(fixture.state.workspace.scope,{a:{x:0,hidden:7},b:{x:0,hidden:8}})
  fixture.apply([fixture.write('a',{x:1})]); fixture.apply([fixture.write('a',{x:2})])
  const frozen=fixture.freeze().submission
  const successor=fixture.apply([fixture.write('a',{x:3})])
  const operation=successor.intents[0]!.operation
  if (operation.kind !== 'write') throw new Error('Expected write')
  const expected=operation.groups[0]!.expectations.find(value=>value.role==='write-base')!
  const before=compileSharedStateBases(fixture.state)
  expect(before(expected)).toEqual({kind:'value',value:2})
  source.normalize=document=>({...document,x:Number(document.x)+0.5,hidden:9})
  const result=await source.submit(frozen)
  if (result.kind!=='applied') throw new Error('Expected real exact receipt')
  fixture.dispatch({kind:'exact-receipt',receipt:result.receipt})
  fixture.observe({a:{x:2.5,hidden:9},b:{x:0,hidden:8}},1)
  const settled=compileSharedStateBases(fixture.state)
  expect(settled(expected)).toEqual({kind:'value',value:2.5})
  expect(before(expected)).toEqual({kind:'value',value:2})
  source.external({a:{x:9,hidden:10},b:{x:0,hidden:8}})
  fixture.observe({a:{x:9,hidden:10},b:{x:0,hidden:8}},2)
  const latest=compileSharedStateBases(fixture.state)
  expect(latest(expected)).toEqual({kind:'value',value:2.5})
  expect(latest({...expected,role:'semantic-read'})).toEqual(expected.expected)
  expect(latest({...expected,role:'policy-guard'})).toEqual(expected.expected)
  const foreign:ExpectedResource={...expected,resource:{kind:'path',entityId:fixture.state.entities.find(entity=>entity.entityId==='b')!.entityId,path:['x']},expected:{kind:'value',value:17}}
  expect(latest(foreign)).toEqual({kind:'value',value:17})
  expect(fixture.state.journal.intents.at(-1)).toEqual(successor.intents[0])
  expect(source.requests).toHaveLength(1); expect(source.writes).toBe(1)
})
