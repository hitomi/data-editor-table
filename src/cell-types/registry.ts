import type {
  GridCellBehaviorProjection,
  GridCellEffectSchema,
  GridCellTypeKind,
  GridCellTypeSchema,
  GridCellTypeSignature,
  GridRegisteredRuntimeCellBehavior,
  GridRuntimeCellActionContext,
  GridRuntimeFillContext,
  GridRuntimeRegisteredValueContext,
} from './contracts.js'
import type {
  GridCellTypeDefinition,
  GridCellTypeFactory,
  GridCellTypeFactoryContext,
  GridCellTypeFamily,
  GridCellViewPort,
  GridRuntimeReactView,
} from './react-view-contracts.js'
import type { DataEditorTableLocale } from '../locales/contracts.js'
import type {
  GridRuntimeColumnContext,
  GridRuntimeValueContext,
} from '../model/grid-model.js'

export const gridCellTypeSchema = Symbol('grid-cell-type-schema')

type RegistrationName<Schema extends GridCellTypeSchema, Name extends string> =
  string extends Name ? never : Name extends keyof Schema ? never : Name

type ExistingRegistrationName<Schema extends GridCellTypeSchema, Name extends string> =
  string extends Name ? never : Name extends keyof Schema ? Name : never

type FixedCellTypeRegistration<
  Row,
  Value,
  EditDraft,
  BulkDraft,
  ColumnOptions,
  Effects extends GridCellEffectSchema,
> =
  | GridCellTypeDefinition<Row, Value, EditDraft, BulkDraft, ColumnOptions, Effects>
  | GridCellTypeFactory<Value, EditDraft, BulkDraft, ColumnOptions, Effects>

type AnyCellTypeDefinition<Row> = GridCellTypeDefinition<
  Row,
  unknown,
  unknown,
  unknown,
  unknown,
  GridCellEffectSchema
>

type RuntimeCellTypeFactory = Readonly<{
  kind: 'grid-cell-type-factory'
  create: <Row>(context?: GridCellTypeFactoryContext) => AnyCellTypeDefinition<Row>
}>

type RuntimeCellTypeFamily = Readonly<{
  kind: 'grid-cell-type-family'
  signatureKind: Exclude<GridCellTypeKind, 'fixed'>
  create: <Row>(
    typeOptions: unknown,
    context?: GridCellTypeFactoryContext,
  ) => AnyCellTypeDefinition<Row>
}>

type RuntimeCellTypeRegistration<Row> =
  | AnyCellTypeDefinition<Row>
  | RuntimeCellTypeFactory
  | RuntimeCellTypeFamily

type RegisteredCellType<Row> = Readonly<{
  behavior: GridRegisteredRuntimeCellBehavior<Row>
  view: GridRuntimeReactView<Row>
}>

type RegisterCellType<Row, Schema extends GridCellTypeSchema> = {
  <
    const Name extends string,
    Value,
    EditDraft = Value,
    BulkDraft = never,
    ColumnOptions = undefined,
    Effects extends GridCellEffectSchema = {},
  >(
    type: RegistrationName<Schema, Name>,
    registration: FixedCellTypeRegistration<
      Row,
      Value,
      EditDraft,
      BulkDraft,
      ColumnOptions,
      Effects
    >,
  ): GridCellTypeRegistry<
    Row,
    Schema & Record<Name, GridCellTypeSignature<Value, ColumnOptions>>
  >
  <
    const Name extends string,
    Value,
    EditDraft = Value,
    BulkDraft = never,
    ColumnOptions = undefined,
    Effects extends GridCellEffectSchema = {},
    Kind extends Exclude<GridCellTypeKind, 'fixed'> = Exclude<GridCellTypeKind, 'fixed'>,
  >(
    type: RegistrationName<Schema, Name>,
    registration: GridCellTypeFamily<
      Value,
      EditDraft,
      BulkDraft,
      ColumnOptions,
      Effects,
      Kind
    >,
  ): GridCellTypeRegistry<
    Row,
    Schema & Record<Name, GridCellTypeSignature<Value, ColumnOptions, Kind>>
  >
}

type ReplaceCellType<Row, Schema extends GridCellTypeSchema> = {
  <
    const Name extends string,
    Value,
    EditDraft = Value,
    BulkDraft = never,
    ColumnOptions = undefined,
    Effects extends GridCellEffectSchema = {},
  >(
    type: ExistingRegistrationName<Schema, Name>,
    registration: FixedCellTypeRegistration<
      Row,
      Value,
      EditDraft,
      BulkDraft,
      ColumnOptions,
      Effects
    >,
  ): GridCellTypeRegistry<
    Row,
    Omit<Schema, Name> & Record<Name, GridCellTypeSignature<Value, ColumnOptions>>
  >
  <
    const Name extends string,
    Value,
    EditDraft = Value,
    BulkDraft = never,
    ColumnOptions = undefined,
    Effects extends GridCellEffectSchema = {},
    Kind extends Exclude<GridCellTypeKind, 'fixed'> = Exclude<GridCellTypeKind, 'fixed'>,
  >(
    type: ExistingRegistrationName<Schema, Name>,
    registration: GridCellTypeFamily<
      Value,
      EditDraft,
      BulkDraft,
      ColumnOptions,
      Effects,
      Kind
    >,
  ): GridCellTypeRegistry<
    Row,
    Omit<Schema, Name> & Record<Name, GridCellTypeSignature<Value, ColumnOptions, Kind>>
  >
}

export type GridCellTypeSchemaOf<Registry> =
  Registry extends Readonly<{ readonly [gridCellTypeSchema]: infer Schema extends GridCellTypeSchema }>
    ? Schema
    : never

export type GridCellTypeRegistry<
  Row,
  Schema extends GridCellTypeSchema = {},
> = Readonly<{
  readonly [gridCellTypeSchema]: Schema
  locale?: DataEditorTableLocale
  behaviors: GridCellBehaviorProjection<Row>
  views: GridCellViewPort<Row>
  has: (type: string) => boolean
  names: () => readonly Extract<keyof Schema, string>[]
  register: RegisterCellType<Row, Schema>
  replace: ReplaceCellType<Row, Schema>
  withLocale: (locale?: DataEditorTableLocale) => GridCellTypeRegistry<Row, Schema>
}>

export function createCellTypeRegistry<Row>(): GridCellTypeRegistry<Row, {}> {
  return createRegistry(new Map())
}

export function defineCellType<
  Row,
  Value,
  EditDraft = Value,
  BulkDraft = never,
  ColumnOptions = undefined,
  Effects extends GridCellEffectSchema = {},
>(definition: GridCellTypeDefinition<
  Row,
  Value,
  EditDraft,
  BulkDraft,
  ColumnOptions,
  Effects
>): GridCellTypeDefinition<Row, Value, EditDraft, BulkDraft, ColumnOptions, Effects> {
  return definition
}

export function defineCellTypeFactory<
  Value,
  EditDraft = Value,
  BulkDraft = never,
  ColumnOptions = undefined,
  Effects extends GridCellEffectSchema = {},
>(create: <Row>(context?: GridCellTypeFactoryContext) => GridCellTypeDefinition<
  Row,
  Value,
  EditDraft,
  BulkDraft,
  ColumnOptions,
  Effects
>): GridCellTypeFactory<Value, EditDraft, BulkDraft, ColumnOptions, Effects> {
  return Object.freeze({ kind: 'grid-cell-type-factory' as const, create })
}

export function defineCellTypeFamily<
  Value,
  EditDraft = Value,
  BulkDraft = never,
  ColumnOptions = undefined,
  Effects extends GridCellEffectSchema = {},
  Kind extends Exclude<GridCellTypeKind, 'fixed'> = Exclude<GridCellTypeKind, 'fixed'>,
>(
  signatureKind: Kind,
  create: <Row>(
    typeOptions: ColumnOptions,
    context?: GridCellTypeFactoryContext,
  ) => GridCellTypeDefinition<
    Row,
    Value,
    EditDraft,
    BulkDraft,
    ColumnOptions,
    Effects
  >,
): GridCellTypeFamily<Value, EditDraft, BulkDraft, ColumnOptions, Effects, Kind> {
  return Object.freeze({ kind: 'grid-cell-type-family' as const, signatureKind, create })
}

function createRegistry<Row, Schema extends GridCellTypeSchema>(
  entries: ReadonlyMap<string, RuntimeCellTypeRegistration<Row>>,
  locale?: DataEditorTableLocale,
): GridCellTypeRegistry<Row, Schema> {
  const fixedCache = new Map<string, RegisteredCellType<Row>>()
  const familyCache = new Map<string, Map<unknown, RegisteredCellType<Row>>>()
  const context = locale === undefined ? undefined : Object.freeze({ locale })

  const resolve = (type: string, typeOptions?: unknown) => {
    const registration = entries.get(type)
    if (!registration) return undefined
    if (isCellTypeFamily(registration)) {
      let instances = familyCache.get(type)
      if (!instances) {
        instances = new Map()
        familyCache.set(type, instances)
      }
      const cached = instances.get(typeOptions)
      if (cached) return cached
      const created = materialize(type, registration.create<Row>(typeOptions, context))
      instances.set(typeOptions, created)
      return created
    }
    const cached = fixedCache.get(type)
    if (cached) return cached
    const definition = isCellTypeFactory(registration)
      ? registration.create<Row>(context)
      : registration
    const created = materialize(type, definition)
    fixedCache.set(type, created)
    return created
  }
  const behaviors = Object.freeze({
    resolve: (type: string, typeOptions?: unknown) => resolve(type, typeOptions)?.behavior,
  })
  const views = Object.freeze({
    resolve: (type: string, typeOptions?: unknown) => resolve(type, typeOptions)?.view,
  })
  const changeRegistration = (
    type: string,
    registration: RuntimeCellTypeRegistration<Row>,
    replacing: boolean,
  ) => {
    assertTypeName(type)
    if (!replacing && entries.has(type)) {
      throw new Error(`Cell type "${type}" is already registered.`)
    }
    if (replacing && !entries.has(type)) {
      throw new Error(`Cell type "${type}" is not registered and cannot be replaced.`)
    }
    const nextEntries = new Map(entries)
    nextEntries.set(type, registration)
    return createRegistry(nextEntries, locale)
  }
  const registry = {
    [gridCellTypeSchema]: undefined as unknown as Schema,
    ...(locale === undefined ? {} : { locale }),
    behaviors,
    views,
    has: (type: string) => entries.has(type),
    names: () => Object.freeze([...entries.keys()]) as readonly Extract<keyof Schema, string>[],
    register: (type: string, registration: RuntimeCellTypeRegistration<Row>) =>
      changeRegistration(type, registration, false),
    replace: (type: string, registration: RuntimeCellTypeRegistration<Row>) =>
      changeRegistration(type, registration, true),
    withLocale: (nextLocale?: DataEditorTableLocale) =>
      nextLocale === locale ? registry : createRegistry(entries, nextLocale),
  }
  return Object.freeze(registry) as unknown as GridCellTypeRegistry<Row, Schema>
}

function materialize<Row>(
  type: string,
  definition: AnyCellTypeDefinition<Row>,
): RegisteredCellType<Row> {
  validateDefinition(type, definition)
  return Object.freeze({
    behavior: eraseBehavior(definition.behavior),
    view: Object.freeze({
      ...definition.view,
      presentation: Object.freeze({
        ...definition.view.presentation,
        editActivation: Object.freeze([...definition.view.presentation.editActivation]),
      }),
    }) as GridRuntimeReactView<Row>,
  })
}

function assertTypeName(type: string): void {
  if (type.length === 0) throw new Error('A cell type name is required.')
  if (type !== type.trim()) throw new Error(`Cell type name "${type}" cannot start or end with whitespace.`)
}

function isCellTypeFactory<Row>(
  registration: RuntimeCellTypeRegistration<Row>,
): registration is RuntimeCellTypeFactory {
  return 'kind' in registration && registration.kind === 'grid-cell-type-factory'
}

function isCellTypeFamily<Row>(
  registration: RuntimeCellTypeRegistration<Row>,
): registration is RuntimeCellTypeFamily {
  return 'kind' in registration && registration.kind === 'grid-cell-type-family'
}

function validateDefinition<Row>(type: string, definition: AnyCellTypeDefinition<Row>): void {
  if (typeof definition.behavior.value?.validate !== 'function') {
    throw new Error(`Cell type "${type}" must provide behavior.value.validate.`)
  }
  if (typeof definition.behavior.text?.display !== 'function') {
    throw new Error(`Cell type "${type}" must provide behavior.text.display.`)
  }
  if (typeof definition.view.Cell !== 'function') {
    throw new Error(`Cell type "${type}" must provide a React Cell view.`)
  }
  if (Boolean(definition.behavior.edit) !== Boolean(definition.view.Editor)) {
    throw new Error(`Cell type "${type}" must provide behavior.edit and view.Editor together.`)
  }
  if (Boolean(definition.behavior.bulk) !== Boolean(definition.view.BulkEditor)) {
    throw new Error(`Cell type "${type}" must provide behavior.bulk and view.BulkEditor together.`)
  }

  const filter = definition.behavior.filter
  if (filter) {
    assertUniqueIds(type, 'filter operator', filter.operators)
    if (!filter.operators.some((operator) => operator.id === filter.defaultOperator)) {
      throw new Error(`Cell type "${type}" has unknown default filter operator "${filter.defaultOperator}".`)
    }
  }
  if (definition.behavior.actions) assertUniqueIds(type, 'action', definition.behavior.actions)
  if (definition.behavior.effects) {
    assertUniqueIds(type, 'effect', Object.keys(definition.behavior.effects).map((id) => ({ id })))
  }
}

function assertUniqueIds(
  type: string,
  capability: string,
  entries: readonly Readonly<{ id: string }>[],
): void {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (!entry.id.trim()) throw new Error(`Cell type "${type}" has a ${capability} without an id.`)
    if (ids.has(entry.id)) throw new Error(`Cell type "${type}" registers ${capability} "${entry.id}" more than once.`)
    ids.add(entry.id)
  }
}

function eraseBehavior<Row>(
  behavior: AnyCellTypeDefinition<Row>['behavior'],
): GridRegisteredRuntimeCellBehavior<Row> {
  const erased = {
    value: Object.freeze({
      validate: (value: unknown, context: GridRuntimeValueContext<Row>) =>
        behavior.value.validate(value, context),
    }),
    text: Object.freeze({
      display: (value: unknown, context: GridRuntimeValueContext<Row>) => behavior.text.display(value, context),
      ...(behavior.text.search === undefined ? {} : {
        search: (value: unknown, context: GridRuntimeValueContext<Row>) => behavior.text.search!(value, context),
      }),
      ...(behavior.text.original === undefined ? {} : {
        original: (value: unknown, context: GridRuntimeValueContext<Row>) => behavior.text.original!(value, context),
      }),
    }),
    ...(behavior.equals === undefined ? {} : {
      equals: (left: unknown, right: unknown, context: GridRuntimeColumnContext) => behavior.equals!(left, right, context),
    }),
    ...(behavior.clipboard === undefined ? {} : {
      clipboard: Object.freeze({
        format: (value: unknown, context: GridRuntimeValueContext<Row>) => behavior.clipboard!.format(value, context),
        ...(behavior.clipboard.parse === undefined ? {} : {
          parse: (text: string, context: GridRuntimeValueContext<Row>) => behavior.clipboard!.parse!(text, context),
        }),
      }),
    }),
    ...(behavior.edit === undefined ? {} : {
      edit: Object.freeze({
        ...(behavior.edit.exit === undefined ? {} : { exit: behavior.edit.exit }),
        begin: (value: unknown, context: GridRuntimeValueContext<Row>) => behavior.edit!.begin(value, context),
        commit: (draft: unknown, context: GridRuntimeValueContext<Row>) => behavior.edit!.commit(draft, context),
      }),
    }),
    ...(behavior.clear === undefined ? {} : {
      clear: (context: GridRuntimeValueContext<Row>) => behavior.clear!(context),
    }),
    ...(behavior.fill === undefined ? {} : {
      fill: (context: GridRuntimeFillContext<Row>) => behavior.fill!({
        sourceValues: context.sourceValues,
        repeatedValue: context.repeatedValue,
        sourceStartIndex: context.sourceStartIndex,
        targetIndex: context.targetIndex,
        targetRow: context.targetRow,
        direction: context.direction,
        columnKey: context.column.columnKey,
        typeOptions: context.column.typeOptions,
      }),
    }),
    ...(behavior.compare === undefined ? {} : {
      compare: (left: unknown, right: unknown, context: GridRuntimeColumnContext) => behavior.compare!(left, right, context),
    }),
    ...(behavior.filter === undefined ? {} : {
      filter: Object.freeze({
        defaultOperator: behavior.filter.defaultOperator,
        operators: Object.freeze(behavior.filter.operators.map((operator) => Object.freeze({
          id: operator.id,
          label: operator.label,
          requiresValue: operator.requiresValue,
          ...(operator.input === undefined ? {} : {
            input: Object.freeze(operator.input.kind === 'select'
              ? {
                  kind: 'select' as const,
                  options: Object.freeze(operator.input.options.map((option) => Object.freeze({ ...option }))),
                }
              : { ...operator.input }),
          }),
          ...(operator.validate === undefined ? {} : {
            validate: (value: unknown) => {
              const raw = typeof value === 'string' ? value : String(value ?? '')
              const message = operator.validate!(raw)
              return message === null
                ? { ok: true as const, value: raw }
                : { ok: false as const, issue: { code: 'invalid-filter-value', message } }
            },
          }),
          matches: (value: unknown, raw: unknown, context: GridRuntimeValueContext<Row>) => operator.matches(value, typeof raw === 'string' ? raw : String(raw ?? ''), context),
        }))),
      }),
    }),
    ...(behavior.bulk === undefined ? {} : {
      bulk: Object.freeze({
        begin: (
          values: readonly unknown[],
          contexts: readonly GridRuntimeValueContext<Row>[],
        ) => behavior.bulk!.begin({ values, cells: contexts }),
        apply: (
          current: unknown,
          draft: unknown,
          context: GridRuntimeValueContext<Row>,
        ) => behavior.bulk!.apply(current, draft, context),
      }),
    }),
    ...(behavior.actions === undefined ? {} : {
      actions: Object.freeze(behavior.actions.map((action) => Object.freeze({
        id: action.id,
        label: action.label,
        ...(action.group === undefined ? {} : { group: action.group }),
        destructive: action.destructive ?? false,
        requiresEditable: action.requiresEditable ?? true,
        ...(action.hidden === undefined ? {} : {
          hidden: (context: GridRuntimeCellActionContext<Row>) => action.hidden!(context),
        }),
        ...(action.disabled === undefined ? {} : {
          disabled: (context: GridRuntimeCellActionContext<Row>) => action.disabled!(context),
        }),
        run: (context: GridRuntimeCellActionContext<Row>) => action.run(context),
      }))),
    }),
    ...(behavior.effects === undefined ? {} : {
      effects: Object.freeze({
        resolve: (id: string) => {
          const effect = behavior.effects?.[id]
          if (!effect) return undefined
          return Object.freeze({
            id,
            concurrency: effect.concurrency,
            run: async (
              input: unknown,
              context: GridRuntimeRegisteredValueContext<Row>,
              signal: AbortSignal,
            ) => effect.run(input, context, signal),
          })
        },
      }),
    }),
  }
  return Object.freeze(erased) as GridRegisteredRuntimeCellBehavior<Row>
}
