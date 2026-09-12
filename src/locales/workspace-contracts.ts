import type { WorkspaceGridMessages } from '../react/workspace-data-grid.js'
import type { WorkspaceFilterEditorMessages } from '../react/workspace-filter-editor.js'
import type { WorkspaceCloseMessages } from '../react/workspace-close-controls.js'

/** Application labels and choice catalogs remain owned by the host. Built-in
 * interaction, recovery and scalar validation copy has one locale contract. */
export type WorkspaceLocale = Readonly<{
  close: WorkspaceCloseMessages
  grid: WorkspaceGridMessages
  filter: WorkspaceFilterEditorMessages
  values: Readonly<{ string: string; number: string; boolean: string; date: string; choice: string; choices: string;
    empty: string; emptyChoices: string; trueLabel: string; falseLabel: string }>
}>
