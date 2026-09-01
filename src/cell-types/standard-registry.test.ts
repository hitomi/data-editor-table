import { describe, expect, it } from 'vitest'

import { createDataGridBinding } from '../react/data-grid.js'
import type { GridDataSource } from '../data/data-source.js'
import { zhCN } from '../locales/zh-cn.js'
import { createBooleanCellType } from './boolean.js'
import { createGridColumnHelper } from './column-helper.js'
import {
  createStandardCellTypeRegistry,
  type StandardGridCellTypeSchema,
} from './standard-registry.js'

type Row = Readonly<{
  id: string
  name: string
  status: 'draft' | 'ready'
  tags: readonly ('featured' | 'seasonal')[]
  active: boolean
}>

const statusOptions = {
  options: [
    { value: 'draft', label: 'Draft' },
    { value: 'ready', label: 'Ready' },
  ],
} as const

const priorityOptions = {
  options: [
    { value: 'draft', label: 'Low' },
    { value: 'ready', label: 'High' },
  ],
} as const

const row: Row = {
  id: 'row-1',
  name: 'Poster',
  status: 'draft',
  tags: ['featured'],
  active: true,
}

describe('createStandardCellTypeRegistry', () => {
  it('specializes one select type with independent column option catalogs', () => {
    const registry = createStandardCellTypeRegistry<Row>()
    const status = registry.behaviors.resolve('singleSelect', statusOptions)
    const priority = registry.behaviors.resolve('singleSelect', priorityOptions)

    expect(status).toBeDefined()
    expect(priority).toBeDefined()
    expect(status).not.toBe(priority)
    expect(status!.text.display('draft', {
      row,
      columnKey: 'status',
      typeOptions: statusOptions,
    })).toBe('Draft')
    expect(priority!.text.display('draft', {
      row,
      columnKey: 'priority',
      typeOptions: priorityOptions,
    })).toBe('Low')
    expect(status!.filter?.operators[0]?.input).toEqual({
      kind: 'select',
      options: [
        { value: 'string:draft', label: 'Draft' },
        { value: 'string:ready', label: 'Ready' },
      ],
    })
  })

  it('localizes all standard types once at registry level', () => {
    const registry = createStandardCellTypeRegistry<Row>().withLocale(zhCN)
    const boolean = registry.behaviors.resolve('boolean')
    const select = registry.behaviors.resolve('singleSelect', statusOptions)

    expect(boolean!.text.display(true, {
      row,
      columnKey: 'active',
      typeOptions: undefined,
    })).toBe('是')
    expect(select!.filter?.operators[0]?.label).toBe('等于')
  })

  it('replaces a standard type without mutating the original registry', () => {
    const standard = createStandardCellTypeRegistry<Row>()
    const replaced = standard.replace('boolean', createBooleanCellType({
      trueLabel: 'Enabled',
      falseLabel: 'Disabled',
    }))
    const context = { row, columnKey: 'active', typeOptions: undefined }

    expect(standard.behaviors.resolve('boolean')!.text.display(true, context)).toBe('True')
    expect(replaced.behaviors.resolve('boolean')!.text.display(true, context)).toBe('Enabled')
    const register = replaced.register as unknown as (
      type: string,
      registration: ReturnType<typeof createBooleanCellType>,
    ) => unknown
    expect(() => register('boolean', createBooleanCellType())).toThrow(
      'Cell type "boolean" is already registered.',
    )
  })
})

describe('createGridColumnHelper', () => {
  it('creates editable field columns and lifts choice options into typeOptions', () => {
    const column = createGridColumnHelper<Row>()
    const name = column.field('name', { label: 'Name', type: 'string' })
    const status = column.field('status', {
      label: 'Status',
      type: 'singleSelect',
      options: statusOptions.options,
    })
    const readOnly = column.field('active', {
      label: 'Active',
      type: 'boolean',
      editable: false,
    })

    expect(name.getValue(row)).toBe('Poster')
    expect(name.setValue?.(row, 'Calendar')).toEqual({ ...row, name: 'Calendar' })
    expect(status.typeOptions).toEqual(statusOptions)
    expect(readOnly.setValue).toBeUndefined()
  })
})

describe('DataGrid default registry', () => {
  it('creates a localized binding without an explicit registry', () => {
    const column = createGridColumnHelper<Row>()
    const dataSource: GridDataSource<Row, string, StandardGridCellTypeSchema> = {
      columns: [column.field('name', { label: 'Name', type: 'string' })],
      getRowKey: (entry) => entry.id,
      getSnapshot: () => ({
        rows: [row],
        status: 'ready',
        version: 1,
        scope: { kind: 'complete' },
      }),
      subscribe: () => () => undefined,
      persistence: {
        mode: 'manual-save',
        commit: async (request) => ({
          operationId: request.operationId,
          applied: {
            rows: request.rows,
            status: 'ready',
            version: 2,
            scope: { kind: 'complete' },
          },
        }),
      },
    }

    const binding = createDataGridBinding({ dataSource, locale: zhCN })
    expect(binding.registry.names()).toEqual([
      'string',
      'number',
      'date',
      'boolean',
      'singleSelect',
      'multiSelect',
    ])
    expect(binding.locale).toBe(zhCN)
    expect(binding.registry.behaviors.resolve('string')!.filter?.operators[0]?.label).toBe('包含')
    binding.destroy()
  })
})
