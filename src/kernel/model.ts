/** The new kernel's storage protocol. No React, business Row, or display snapshot
 * is a source of intent. IDs are supplied by the runtime, never generated here.
 */
declare const identity: unique symbol
export type Id<Kind extends string> = string & { readonly [identity]: Kind }
export type WorkspaceId = Id<'workspace'>
export type ScopeId = Id<'scope'>
export type ScopeEpoch = Id<'scope-epoch'>
export type EntityId = Id<'entity'>
export type IntentId = Id<'intent'>
export type ActionId = Id<'action'>
export type ApplicationId = Id<'application'>
export type InputId = Id<'input'>
export type OperationId = Id<'operation'>
export type ItemId = Id<'item'>
export type ObservationId = Id<'observation'>
export type FieldId = Id<'field'>
export type WriteGroupId = Id<'write-group'>
export type TaskId = Id<'task'>
export type SessionId = Id<'session'>
export type ViewId = Id<'view'>
export type IngressId = Id<'ingress'>
export type ResourceId = Id<'resource'>
export type RecoveryId = Id<'recovery'>
export type PolicyVersion = Id<'policy-version'>
export type SchemaVersion = Id<'schema-version'>
export type CodecVersion = Id<'codec-version'>
export type ReceiptHash = Id<'receipt-hash'>
export type PayloadHash = Id<'payload-hash'>
export type CausalStamp = Id<'causal-stamp'>

export function kernelId<Kind extends string>(value: string): Id<Kind> {
  if (value.length === 0 || value !== value.trim()) throw new Error('An identity must be nonempty and have no surrounding whitespace.')
  return value as Id<Kind>
}

export type EncodedValue = null | boolean | number | string | readonly EncodedValue[] | Document
export type Document = { readonly [key: string]: EncodedValue }
/** Missing is a resource envelope, never a sentinel inside an encoded document. */
export type ResourceValue = Readonly<{ kind: 'missing' }> | Readonly<{ kind: 'value'; value: EncodedValue }>
export type StoragePath = readonly [string, ...string[]]
export type ScopeIdentity = Readonly<{ sourceId: string; id: ScopeId; epoch: ScopeEpoch }>
export type ServerKey = string | number
export type ServerIdentity = Readonly<{ key: ServerKey; incarnation: string }>
export type WorkspaceIdentity = Readonly<{
  id: WorkspaceId
  scope: ScopeIdentity
  schema: SchemaVersion
  codec: CodecVersion
}>

/** Opaque tokens have no order. A trusted read gateway supplies explicit stamps
 * it covers; its local request counter cannot manufacture server freshness.
 */
export type AuthorityVersion =
  | Readonly<{ kind: 'ordered'; token: string; position: string }>
  | Readonly<{ kind: 'causal'; token: string; stamp: CausalStamp; covers: readonly CausalStamp[] }>
export type AuthorityFrontier = readonly AuthorityVersion[]
export type AuthorityEntity = Readonly<{ entityId: EntityId; identity: ServerIdentity; document: Document }>
export type CompleteAuthority = Readonly<{
  scope: ScopeIdentity
  observation: ObservationId
  version: AuthorityVersion
  entities: readonly AuthorityEntity[]
  order: readonly EntityId[]
}>
export type KernelIssue = Readonly<{
  code: string
  message: string
  entityId?: EntityId
  fieldId?: FieldId
  intentIds?: readonly IntentId[]
}>
export type AuthorityState = Readonly<{
  content: Readonly<{ kind: 'uninitialized' }> | Readonly<{ kind: 'complete'; snapshot: CompleteAuthority }>
  read: Readonly<{ kind: 'idle' }> | Readonly<{ kind: 'loading'; ticket: string }>
    | Readonly<{ kind: 'failed'; ticket: string; issue: KernelIssue }>
}>
export type EntityBinding =
  | Readonly<{ kind: 'local'; entityId: EntityId; creationIntentId: IntentId }>
  | Readonly<{ kind: 'bound'; entityId: EntityId; identity: ServerIdentity }>
  | Readonly<{ kind: 'retired'; entityId: EntityId; identity: ServerIdentity }>
export type FieldRef = Readonly<{ entityId: EntityId; fieldId: FieldId }>
export type ResourceRef =
  | Readonly<{ kind: 'path'; entityId: EntityId; path: StoragePath }>
  | Readonly<{ kind: 'entity'; entityId: EntityId }>
  | Readonly<{ kind: 'order' }>
/** Index into the owning journal's append-only frontier table; null is empty. */
export type FrontierRef = number | null
export type FrontierTable = Readonly<{ scope: string; nodes: readonly Readonly<{ parent: FrontierRef; intent: IntentId; length: number }>[] }>
export type AuthorityAnchor = Readonly<{ kind: 'authority'; observation: ObservationId }>
export type LogicalOutputAnchor = Readonly<{ kind: 'logical-output'; predecessor: FrontierRef; fallback: AuthorityAnchor }>
export type Anchor = AuthorityAnchor | LogicalOutputAnchor | Readonly<{
  kind: 'submission-output'
  operationId: OperationId
  itemId: ItemId
  frontier: FrontierRef
  fallback: LogicalOutputAnchor
}>
export type ExpectedResource = Readonly<{
  resource: ResourceRef
  expected: ResourceValue
  anchor: Anchor
  role: 'write-base' | 'semantic-read' | 'policy-guard'
}>
export type Patch =
  | Readonly<{ kind: 'set'; path: StoragePath; value: EncodedValue }>
  | Readonly<{ kind: 'remove'; path: StoragePath }>
export type WriteGroup = Readonly<{
  id: WriteGroupId
  writes: readonly Patch[]
  expectations: readonly ExpectedResource[]
}>
export type InputRef = Readonly<{ id: InputId; version: number }>
export type OwnedInput =
  | Readonly<{ kind: 'encoded'; value: EncodedValue }>
  | Readonly<{ kind: 'resource'; id: ResourceId }>
export type ResourceDescriptor = Readonly<{ id: ResourceId; size: number; mediaType: string }> & (
  | Readonly<{ kind: 'blob' }>
  | Readonly<{ kind: 'file'; name: string; lastModified: number }>
)
export type ResourceRecord = Readonly<{ descriptor: ResourceDescriptor; status: 'available' | 'released' }>
export type InputDisposition =
  | Readonly<{ kind: 'session'; sessionId: SessionId }>
  | Readonly<{ kind: 'task'; taskId: TaskId }>
  | Readonly<{ kind: 'intents'; intentIds: readonly IntentId[] }>
  | Readonly<{ kind: 'applied-to-view'; viewId?: ViewId; queryVersion: number }>
  | Readonly<{ kind: 'settled-intents'; proofs: readonly IntentSettlement[] }>
  | Readonly<{ kind: 'superseded'; by: InputRef }>
  | Readonly<{ kind: 'discarded'; by: IntentId }>
  | Readonly<{ kind: 'workspace-discarded'; ticket: CloseTicket }>
  | Readonly<{ kind: 'cancelled-session'; sessionId: SessionId }>
  | Readonly<{ kind: 'cancelled-task'; taskId: TaskId }>
  | Readonly<{ kind: 'recovery'; recoveryId: RecoveryId }>
export type InputRecord = Readonly<{ ref: InputRef; input: OwnedInput; disposition: InputDisposition }>
export type RecoveryEntry = Readonly<{
  id: RecoveryId
  resolution: IntentId
  createdBy: IntentId
  intentIds: readonly IntentId[]
  inputs: readonly InputRef[]
  state: 'available' | 'consumed' | 'discarded'
}>

export type DataOperation =
  | Readonly<{ kind: 'create'; entityId: EntityId; document: Document; proposedKey?: ServerKey; restoresEntity?: EntityId }>
  | Readonly<{ kind: 'write'; entityId: EntityId; groups: readonly WriteGroup[] }>
  | Readonly<{ kind: 'replace'; entityId: EntityId; expected: ExpectedResource; document: Document }>
  | Readonly<{ kind: 'delete'; entityId: EntityId; expected: ExpectedResource; recoveryDocument: Document }>
  | Readonly<{ kind: 'order'; expectedOrder: readonly EntityId[]; authorityBase: readonly EntityId[]; anchor: Anchor; desired: readonly EntityId[] }>
export type ResolutionDecision = Readonly<{
  kind: 'use-authority' | 'keep-local' | 'merge' | 'recreate' | 'adopt-existing'
  targets: readonly IntentId[]
  observation: ObservationId
  issueIds: readonly string[]
  replacements: readonly IntentId[]
  field?: Readonly<{ entityId: EntityId; path: StoragePath }>
}>
export type IntentOperation = DataOperation
  | Readonly<{ kind: 'undo'; target: ApplicationId; sourceEntityId: EntityId; entityId: EntityId; targets: readonly IntentId[]; frontier: FrontierRef;
    compensation: Exclude<DataOperation, { kind: 'order' }> | null }>
  | Readonly<{ kind: 'undo-order'; target: ApplicationId; targets: readonly IntentId[]; restorations: readonly IntentId[]; frontier: FrontierRef; compensation: Extract<DataOperation, { kind: 'order' }> | null }>
  | Readonly<{ kind: 'redo'; target: ApplicationId; sourceIntentId: IntentId; sourceEntityId: EntityId; entityId: EntityId; replay: Exclude<DataOperation, { kind: 'order' }> }>
  | Readonly<{ kind: 'redo-order'; target: ApplicationId; sourceIntentId: IntentId; replay: Extract<DataOperation, { kind: 'order' }> }>
  | Readonly<{ kind: 'restore-resolution-row'; target: ApplicationId; resolution: IntentId; sourceIntentId: IntentId; entityId: EntityId; replay: Exclude<DataOperation, { kind: 'order' }> }>
  | Readonly<{ kind: 'restore-resolution-order'; target: ApplicationId; resolution: IntentId; sourceIntentId: IntentId; replay: Extract<DataOperation, { kind: 'order' }> }>
  | Readonly<{ kind: 'undo-resolution'; target: ApplicationId; resolution: IntentId; recoveryId: RecoveryId }>
  | Readonly<{ kind: 'redo-resolution'; target: ApplicationId; sourceIntentId: IntentId; decision: ResolutionDecision; recoveries: readonly RecoveryId[]; restored?: readonly IntentId[] }>
  | Readonly<{ kind: 'resolve'; decision: ResolutionDecision }>
  | Readonly<{ kind: 'discard'; targets: readonly IntentId[] }>
export type IntentRecord = Readonly<{
  id: IntentId
  actionId: ActionId
  applicationId: ApplicationId
  sequence: number
  cause: 'user' | 'task' | 'undo' | 'redo' | 'resolution'
  inputs: readonly InputRef[]
  dependencies: FrontierRef
  operation: IntentOperation
}>
export type ActionRecord = Readonly<{
  id: ActionId
  applicationId: ApplicationId
  label: string
  intentIds: readonly IntentId[]
  saveAtomicity: 'row' | 'transaction'
  beforeOrder: readonly EntityId[]
  orderBase: Readonly<{ authority: readonly EntityId[]; frontier: FrontierRef }>
  recoveryDocuments: readonly Readonly<{ entityId: EntityId; document: Document; observation: ObservationId }>[]
}>
export type IntentJournal = Readonly<{ intents: readonly IntentRecord[]; actions: readonly ActionRecord[]; frontiers: FrontierTable }>
export type IntentSettlement =
  | Readonly<{ kind: 'committed'; intentId: IntentId; operationId: OperationId; itemId: ItemId }>
  | Readonly<{ kind: 'externally-satisfied'; intentId: IntentId; observation: ObservationId }>
  | Readonly<{ kind: 'discarded'; intentId: IntentId; by: IntentId }>
  | Readonly<{ kind: 'workspace-discarded'; intentId: IntentId; ticket: CloseTicket }>
  | Readonly<{ kind: 'control-completed'; intentId: IntentId }>

export type SubmittedEntityRef =
  | Readonly<{ kind: 'bound'; identity: ServerIdentity }>
  | Readonly<{ kind: 'created-in-submission'; itemId: ItemId }>
export type FrozenMutationItem =
  | Readonly<{ kind: 'create'; id: ItemId; entityId: EntityId; document: Document; proposedKey?: ServerKey;
    restores?: Readonly<{ identity: ServerIdentity; operationId: OperationId; itemId: ItemId }> }>
  | Readonly<{ kind: 'update'; id: ItemId; entityId: EntityId; identity: ServerIdentity; before: Document; after: Document; writes: readonly Patch[] }>
  | Readonly<{ kind: 'delete'; id: ItemId; entityId: EntityId; identity: ServerIdentity; before: Document }>
  | Readonly<{ kind: 'order'; id: ItemId; before: readonly ServerIdentity[]; after: readonly SubmittedEntityRef[] }>
export type SubmissionCoverage = Readonly<{ itemId: ItemId; intentIds: readonly IntentId[] }>
/** Kept in the kernel/recovery store; the wire gateway need not expose local IDs. */
export type FrozenSubmission = Readonly<{
  workspaceId: WorkspaceId
  operationId: OperationId
  scope: ScopeIdentity
  schema: SchemaVersion
  payloadHash: PayloadHash
  baseAuthority: AuthorityVersion
  items: readonly FrozenMutationItem[]
  coverage: readonly SubmissionCoverage[]
  frontier: readonly IntentId[]
}>
export type ExactItemResult =
  | Readonly<{ kind: 'created'; itemId: ItemId; identity: ServerIdentity; canonical: Document }>
  | Readonly<{ kind: 'updated'; itemId: ItemId; identity: ServerIdentity; canonical: Document }>
  | Readonly<{ kind: 'deleted'; itemId: ItemId; identity: ServerIdentity }>
  | Readonly<{ kind: 'ordered'; itemId: ItemId; canonicalOrder: readonly ServerIdentity[] }>
export type ExactReceipt = Readonly<{
  operationId: OperationId
  scope: ScopeIdentity
  payloadHash: PayloadHash
  committedVersion: AuthorityVersion
  results: readonly ExactItemResult[]
}>
export type NotAppliedProof = Readonly<{
  operationId: OperationId
  scope: ScopeIdentity
  payloadHash: PayloadHash
  /** A stable server result fencing execution, not a client timeout or 404. */
  rejectionToken: string
  reason: KernelIssue
}>
export type OperationLookup =
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'unknown'; issue: KernelIssue }>
  | Readonly<{ kind: 'applied'; receipt: ExactReceipt }>
  | Readonly<{ kind: 'not-applied'; proof: NotAppliedProof }>
export type PersistenceState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'waiting-for-gateway'; ticket: string; requestedFrontier: readonly IntentId[] }>
  | Readonly<{ kind: 'sending'; submission: FrozenSubmission; attempt: number }>
  | Readonly<{ kind: 'outcome-unknown'; submission: FrozenSubmission; attempt: number; issue: KernelIssue }>
  | Readonly<{ kind: 'committed-awaiting-receipt'; submission: FrozenSubmission; commitToken: string }>
  | Readonly<{ kind: 'committed-awaiting-authority'; submission: FrozenSubmission; receipt: ExactReceipt; requiredFrontier: AuthorityFrontier }>
  | Readonly<{ kind: 'receipt-blocked'; submission: FrozenSubmission; receipt: ExactReceipt; issue: KernelIssue }>

export type EditorLease = Readonly<{ viewId: ViewId; sessionId: SessionId; generation: number }>
/** Compiled display expressions contain encoded values and storage bindings;
 * neither a callback nor a filtered row snapshot enters recoverable state. */
export type ViewPredicate =
  | Readonly<{ kind: 'compare'; fieldId: FieldId; operator: 'equals' | 'contains' | 'less-than' | 'greater-than' | 'text-contains' | 'text-equals' | 'includes'; value: EncodedValue; locale?: string }>
  | Readonly<{ kind: 'missing'; fieldId: FieldId }>
  | Readonly<{ kind: 'all' | 'any'; predicates: readonly ViewPredicate[] }>
  | Readonly<{ kind: 'not'; predicate: ViewPredicate }>
export type ViewFilter = Readonly<{ columnId: string; predicate: ViewPredicate }>
export type ViewSort = Readonly<{ fieldId: FieldId; direction: 'asc' | 'desc' }>
export type ViewSearchField = Readonly<{ fieldId: FieldId; labels?: readonly Readonly<{ value: EncodedValue; text: string }>[] }>
export type ViewSearch = Readonly<{ text: string; locale: string; fields: readonly ViewSearchField[] }>
export type ViewQuery = Readonly<{ viewId?: ViewId; version: number; search?: ViewSearch; filters: readonly ViewFilter[]; sort: readonly ViewSort[] }>
export type SessionCreation = Omit<Extract<DataOperation, { kind: 'create' }>, 'kind' | 'restoresEntity'>
export type SessionTarget =
  | Readonly<{ kind: 'cell'; field: FieldRef }>
  | Readonly<{ kind: 'bulk'; fields: readonly FieldRef[]; creations?: readonly SessionCreation[] }>
  | Readonly<{ kind: 'filter'; viewId?: ViewId; columnId: string; queryVersion: number }>
export type Session = Readonly<{
  id: SessionId
  input: InputRef
  rawInput: OwnedInput
  /** Recovery sources remain individually owned until apply or explicit cancel. */
  retainedInputs: readonly InputRef[]
  target: SessionTarget
  queryBase: ViewFilter | null
  dependencies: readonly Readonly<{ resource: ResourceRef; expected: ResourceValue }>[]
  phase: 'editing' | 'preparing' | 'blocked'
  editor: EditorLease | null
  composition: 'idle' | 'composing'
  issues: readonly KernelIssue[]
}>
export type PreparedAction = Readonly<{
  revision: number
  frontiers: FrontierTable
  action: ActionRecord
  intents: readonly IntentRecord[]
  inputs: readonly InputRecord[]
  observation: ObservationId
  policyVersion: PolicyVersion
}>
export type TaskResult =
  | Readonly<{ kind: 'action-candidate'; input: OwnedInput }>
  | Readonly<{ kind: 'session-candidate'; sessionId: SessionId; input: OwnedInput }>
  | Readonly<{ kind: 'action'; action: PreparedAction }>
export type TaskOwner =
  | Readonly<{ kind: 'session'; sessionId: SessionId; input: InputRef }>
  | Readonly<{ kind: 'field'; field: FieldRef; generation: number }>
  | Readonly<{ kind: 'workspace'; workspaceId: WorkspaceId }>
export type TaskDefinitionRef = Readonly<{ id: string; version: string }>
export type DurableTaskRef = Readonly<{ workspaceId: WorkspaceId; taskId: TaskId; executionId: string; definition: TaskDefinitionRef; payloadHash: string }>
export type DurableTaskRequest = Readonly<{
  ref: DurableTaskRef
  workspace: WorkspaceIdentity
  owner: TaskOwner
  input: OwnedInput
  resource: Readonly<{ descriptor: ResourceDescriptor; sha256: string }> | null
}>
export type DurableTaskOutcome =
  | Readonly<{ kind: 'succeeded'; ref: DurableTaskRef; result: TaskResult }>
  | Readonly<{ kind: 'failed'; ref: DurableTaskRef; issue: KernelIssue }>
  | Readonly<{ kind: 'pending' | 'unknown'; ref: DurableTaskRef; issue: KernelIssue }>
export type TaskState = Readonly<{
  id: TaskId
  owner: TaskOwner
  input: InputRef
  dependencies: Session['dependencies']
  executionId: string
  execution?: Readonly<{ request: DurableTaskRequest; outcome: DurableTaskOutcome | null }>
}> & (
  | Readonly<{ kind: 'queued' | 'running' }>
  | Readonly<{ kind: 'result-ready'; result: TaskResult }>
  | Readonly<{ kind: 'blocked'; result: TaskResult; issues: readonly KernelIssue[] }>
  | Readonly<{ kind: 'failed'; issue: KernelIssue }>
  | Readonly<{ kind: 'superseded' | 'cancelled'; result?: TaskResult }>
  | Readonly<{ kind: 'consumed'; result: TaskResult; destination: Readonly<{ kind: 'session'; sessionId: SessionId; input: InputRef }> | Readonly<{ kind: 'action'; applicationId: ApplicationId }> }>
)
export type InputEnvelope = Readonly<{
  ingressId: IngressId
  lease: EditorLease
  inputSequence: number
  predecessor: Readonly<{ kind: 'published'; inputVersion: number }> | Readonly<{ kind: 'ingress'; id: IngressId }>
  input: OwnedInput
  composition: 'idle' | 'composing'
}>
export type CloseTicket = Readonly<{ workspaceId: WorkspaceId; semanticRevision: number; ingressGeneration: number; runtimeGeneration: number; leaseEpoch: string }>
export type CloseBlocker = Readonly<{
  kind: 'intent' | 'session' | 'task' | 'task-result' | 'submission' | 'ingress' | 'storage' | 'recovery' | 'resource' | 'runtime'
  id: string
  message: string
}>
export type SaveSchedule = Readonly<{
  mode: 'manual' | 'immediate' | 'debounced'
  debounceMs: number
  token: number
  pending: boolean
}>
export type StorageCommitToken = Readonly<{
  workspaceId: WorkspaceId
  leaseEpoch: string
  sequence: number
  candidateHash: string
}>
export type RecoveryRoot = Readonly<{ token: StorageCommitToken; revision: number }>
export type PreparedStorageCommit = Readonly<{
  token: StorageCommitToken
  workspace: WorkspaceIdentity
  parent: RecoveryRoot | null
  semanticRevision: number
}>
export type RecoveryCommitResult =
  | Readonly<{ kind: 'committed'; commit: PreparedStorageCommit; root: RecoveryRoot }>
  | Readonly<{ kind: 'not-committed'; commit: PreparedStorageCommit; issue: KernelIssue }>
  | Readonly<{ kind: 'unknown'; commit: PreparedStorageCommit; issue: KernelIssue }>
