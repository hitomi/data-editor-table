import type { GridBooleanCellTypeMessages } from '../cell-types/boolean.js'
import type {
  GridMultiSelectCellTypeMessages,
  GridSingleSelectCellTypeMessages,
} from '../cell-types/choices.js'
import type { GridImageCellTypeMessages } from '../cell-types/image.js'
import type {
  GridIsoDateCellTypeMessages,
  GridNumberCellTypeMessages,
  GridStringCellTypeMessages,
} from '../cell-types/standard.js'
import type { DataGridMessages } from '../react/data-grid.js'

export type DataEditorTableLocale = Readonly<{
  code: string
  dataGrid: DataGridMessages
  cellTypes: Readonly<{
    string: GridStringCellTypeMessages
    number: GridNumberCellTypeMessages
    isoDate: GridIsoDateCellTypeMessages
    singleSelect: GridSingleSelectCellTypeMessages
    multiSelect: GridMultiSelectCellTypeMessages
    boolean: GridBooleanCellTypeMessages
    image: GridImageCellTypeMessages
  }>
}>
