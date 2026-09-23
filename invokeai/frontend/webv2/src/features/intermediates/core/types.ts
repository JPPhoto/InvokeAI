/**
 * Read models of the intermediates manager. Pure: no transport, React or UI imports.
 *
 * An intermediate is classified once by the server under the cleanup policy: `safe` (deleted by either mode),
 * `referenced` (named by a saved document or persisted editor state; deleted only by a force clear), `active` (produced or
 * consumed by queued or running work) and `recent` (inside the grace window). The last two are never deleted.
 */

export type IntermediatesCleanupMode = 'safe' | 'force';

export type IntermediatesSummarySort = 'reclaimable_bytes' | 'project_name';

export type IntermediatesOperationStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface IntermediatesKindCounts {
  safe: number;
  referenced: number;
  active: number;
  recent: number;
}

export interface IntermediatesScopeTarget {
  userId: string;
  /** `null` is the owner's unassigned intermediates: no project, or a project that no longer exists. */
  projectId: string | null;
}

export interface IntermediatesRow extends IntermediatesScopeTarget {
  userDisplayName: string | null;
  userEmail: string | null;
  projectName: string | null;
  /** The newest durable image on the project's board, for a thumbnail; null for unassigned rows. */
  coverImageName: string | null;
  images: IntermediatesKindCounts;
  videos: IntermediatesKindCounts;
  /** Measured bytes of the safe items. */
  reclaimableBytes: number;
  /** Measured bytes a force clear adds. */
  referencedBytes: number;
  /** Safe or referenced items not yet measured. */
  unknownSizeCount: number;
}

export interface IntermediatesSummaryTotals {
  rows: number;
  safeImages: number;
  safeVideos: number;
  inUseImages: number;
  inUseVideos: number;
  reclaimableBytes: number;
  unknownSizeCount: number;
}

export interface IntermediatesSummary {
  items: IntermediatesRow[];
  /** Rows matching the request across every page. */
  total: number;
  offset: number;
  limit: number;
  /** Over every matching row, not only the returned page. */
  totals: IntermediatesSummaryTotals;
  recentGraceSeconds: number;
  /** Sizes are still being measured in the background. */
  measuring: boolean;
  canManageEveryone: boolean;
}

export type IntermediatesScope =
  | { kind: 'selection'; targets: IntermediatesScopeTarget[] }
  | { kind: 'owner'; userId: string }
  | { kind: 'everyone' };

export interface IntermediatesImpact {
  deleteImages: number;
  deleteVideos: number;
  keepReferencedImages: number;
  keepReferencedVideos: number;
  keepActiveImages: number;
  keepActiveVideos: number;
  keepRecentImages: number;
  keepRecentVideos: number;
  reclaimableBytes: number;
  unknownSizeCount: number;
}

/**
 * What names the media: a saved project or library workflow, the legacy editor's persisted state (`ownerId` is its
 * state key), or a project set aside for repair by an earlier migration.
 */
export type IntermediatesAffectedDocumentKind = 'project' | 'workflow' | 'client_state' | 'quarantined_project';

export interface IntermediatesAffectedDocument {
  kind: IntermediatesAffectedDocumentKind;
  /** The document's owner. */
  userId: string;
  userDisplayName: string | null;
  userEmail: string | null;
  ownerId: string;
  name: string | null;
  references: number;
}

export interface IntermediatesPreview {
  previewId: string;
  mode: IntermediatesCleanupMode;
  scope: IntermediatesScope;
  createdAt: string;
  expiresAt: string;
  targetRows: number;
  hasMoreEligible: boolean;
  impact: IntermediatesImpact;
  affectedDocuments: IntermediatesAffectedDocument[];
}

export interface IntermediatesOperationProgress {
  processedImages: number;
  processedVideos: number;
  deletedImages: number;
  deletedVideos: number;
  retainedImages: number;
  retainedVideos: number;
  failedImages: number;
  failedVideos: number;
  reclaimedBytes: number;
  /** Deleted items whose size was never measured; their bytes are not in `reclaimedBytes`. */
  unknownSizeCount: number;
  pendingDiskCleanup: number;
  unresolvedImages: number;
  unresolvedVideos: number;
}

export interface IntermediatesOperation {
  operationId: string;
  userId: string;
  mode: IntermediatesCleanupMode;
  scope: IntermediatesScope;
  status: IntermediatesOperationStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  targetImages: number;
  targetVideos: number;
  progress: IntermediatesOperationProgress;
  retriedFromOperationId: string | null;
  retriedByOperationId: string | null;
}

export const getIntermediatesRowKey = (target: IntermediatesScopeTarget): string =>
  `${target.userId}\u0000${target.projectId ?? ''}`;

export const getKindTotal = (counts: IntermediatesKindCounts): number =>
  counts.safe + counts.referenced + counts.active + counts.recent;

export const getKindInUse = (counts: IntermediatesKindCounts): number =>
  counts.referenced + counts.active + counts.recent;

export const getOperationTotalTargets = (operation: IntermediatesOperation): number =>
  operation.targetImages + operation.targetVideos;

export const getOperationProcessed = (operation: IntermediatesOperation): number =>
  operation.progress.processedImages + operation.progress.processedVideos;

export const isOperationSettled = (operation: IntermediatesOperation): boolean =>
  operation.status === 'completed' || operation.status === 'failed';

/** Only unresolved targets can be retried, once the operation has stopped and no retry has taken them over. */
export const isOperationRetryable = (operation: IntermediatesOperation): boolean =>
  isOperationSettled(operation) &&
  operation.retriedByOperationId === null &&
  operation.progress.unresolvedImages + operation.progress.unresolvedVideos > 0;
