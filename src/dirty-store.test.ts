import { describe, expect, it } from 'vitest'

import { createDataGridDirtyStore } from './dirty-store'

describe('createDataGridDirtyStore', () => {
  it('notifies only affected row, field and column subscribers', () => {
    const store = createDataGridDirtyStore<string>()
    const notifications: string[] = []
    store.subscribeRow('one', () => notifications.push('row'))
    store.subscribeRow('two', () => notifications.push('other-row'))
    store.subscribeField('one', 'status', () => notifications.push('field'))
    store.subscribeColumn('status', () => notifications.push('column'))
    store.setSnapshot(new Map([['one', new Map([['status', 'before']])]]))
    expect(notifications).toEqual(['row', 'field', 'column'])
    expect(store.getOriginalValue('one', 'status')).toBe('before')
  })

  it('keeps a column dirty until its last dirty row is cleared', () => {
    const store = createDataGridDirtyStore<string>()
    let notifications = 0
    store.subscribeColumn('name', () => { notifications += 1 })
    store.setRowSnapshot('one', new Map([['name', 'one']]))
    store.setRowSnapshot('two', new Map([['name', 'two']]))
    store.setRowSnapshot('one', undefined)
    expect(store.getColumnDirty('name')).toBe(true)
    expect(notifications).toBe(1)
    store.setRowSnapshot('two', undefined)
    expect(store.getColumnDirty('name')).toBe(false)
    expect(notifications).toBe(2)
  })
})
