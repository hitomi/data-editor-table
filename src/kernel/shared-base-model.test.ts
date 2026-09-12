import { expect, it } from 'vitest'
import { SharedFrontiers, type SharedFrontier } from './shared-frontier.js'
import { sharedBaseResolver, type BaseFact } from './shared-base.js'
import { kernelId } from './model.js'
import type { RowOperation } from './resources.js'
const entityId = kernelId<'entity'>('a'), resource = { kind: 'path' as const, entityId, path: ['x'] as const }
const write = (value: number): RowOperation => ({ kind: 'write', entityId, groups: [{ id: kernelId<'write-group'>('x'), expectations: [], writes: [{ kind: 'set', path: ['x'], value }] }] })

it('preserves ordered exact-item deduplication and keeps local prefixes outside cached bases', () => {
  const arena = new SharedFrontiers(['first','edit','same-item','tail'])
  const facts = new Map<string,BaseFact>([
    ['first',{kind:'canonical',item:'commit/item',document:{x:1.5,hidden:7}}],
    ['edit',{kind:'unsettled',operation:write(2)}],
    ['same-item',{kind:'canonical',item:'commit/item',document:{x:1.5,hidden:7}}],
    ['tail',{kind:'skip'}],
  ])
  const first=arena.append(null,'first'), edit=arena.append(first,'edit'), duplicate=arena.append(edit,'same-item'), tail=arena.append(duplicate,'tail')
  const reversed=arena.append(arena.append(arena.append(null,'edit'),'first'),'tail')
  const resolver=sharedBaseResolver(arena,resource,facts,new SharedFrontiers(['commit/item']))
  expect(resolver.resolve(tail,{kind:'missing'})).toEqual({kind:'value',value:2})
  expect(resolver.resolve(reversed,{kind:'missing'})).toEqual({kind:'value',value:1.5})
  expect(resolver.resolve(tail,{kind:'missing'},[write(3)])).toEqual({kind:'value',value:3})
  expect(resolver.resolve(tail,{kind:'missing'})).toEqual({kind:'value',value:2})
  expect(resolver.evaluated).toBe(arena.size)
})

it('distinguishes unresolved fallback, explicit missing, and local creation', () => {
  const arena=new SharedFrontiers(['edit','deleted','created']), edit=arena.append(null,'edit')
  const facts=new Map<string,BaseFact>([['edit',{kind:'unsettled',operation:write(2)}],
    ['deleted',{kind:'canonical',item:'delete',document:null}],
    ['created',{kind:'unsettled',operation:{kind:'create',entityId,document:{x:null,hidden:9}}}]])
  const resolver=sharedBaseResolver(arena,resource,facts,new SharedFrontiers(['delete']))
  expect(resolver.resolve(edit,{kind:'value',value:17})).toEqual({kind:'value',value:17})
  expect(resolver.resolve(edit,{kind:'value',value:18})).toEqual({kind:'value',value:18})
  expect(resolver.resolve(arena.append(edit,'deleted'),{kind:'value',value:17})).toEqual({kind:'missing'})
  expect(resolver.resolve(arena.append(edit,'created'),{kind:'missing'})).toEqual({kind:'value',value:null})
})

it('evaluates each shared node once across every prefix of a long created-row history', () => {
  const ids=Array.from({length:5000},(_,i)=>String(i)), arena=new SharedFrontiers(ids)
  const facts=new Map<string,BaseFact>(ids.map((id,i)=>[id,{kind:'unsettled',operation:i===0?{kind:'create',entityId,document:{x:0,hidden:7}}:write(i)}]))
  const resolver=sharedBaseResolver(arena,{kind:'entity',entityId},facts,new SharedFrontiers([]))
  let frontier:SharedFrontier|null=null
  for (let i=0;i<ids.length;i++) {
    frontier=arena.append(frontier,ids[i]!)
    expect(resolver.resolve(frontier,{kind:'missing'})).toEqual({kind:'value',value:{x:i,hidden:7}})
  }
  expect(resolver.evaluated).toBe(ids.length)
})
