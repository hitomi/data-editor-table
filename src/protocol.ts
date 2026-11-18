/** Source adapter protocol. No Controller state, journal, sessions or recovery store API. */
export type {
  Id, WorkspaceId, ScopeId, ScopeEpoch, EntityId, IntentId, OperationId,
  ItemId, ObservationId, FieldId, SchemaVersion, CodecVersion, PayloadHash, CausalStamp,
  EncodedValue, Document, ResourceValue, StoragePath, ScopeIdentity, ServerKey,
  ServerIdentity, AuthorityVersion, AuthorityFrontier, KernelIssue, Patch,
  SubmittedEntityRef, FrozenMutationItem, SubmissionCoverage, FrozenSubmission,
  ExactItemResult, ExactReceipt, NotAppliedProof, OperationLookup,
} from './kernel/model.js'
export { kernelId } from './kernel/model.js'
export type { PersistenceSource, ServerAuthority, SourceMutationResult } from './kernel/source.js'
export { hashSubmission } from './kernel/source.js'
export { canonicalEncodedValue, ownEncodedValue, ownDocument } from './kernel/document.js'
export type { DocumentCodec, SchemaField } from './kernel/schema.js'
export type { SubmissionRef } from './kernel/persistence.js'
export type { GridDocumentModel, GridDocumentColumnBinding } from './data/grid-document.js'
export { plainGridRowCodec } from './data/grid-document.js'
export type { DefinitiveResult, ScopeDispute, ScopeDisputeEvent } from './kernel/scope-disputes.js'
