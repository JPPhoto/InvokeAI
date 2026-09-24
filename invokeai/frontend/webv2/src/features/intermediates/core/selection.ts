import type { IntermediatesRow, IntermediatesScope, IntermediatesScopeTarget } from './types';

import { getIntermediatesRowKey } from './types';

/**
 * Row selection for the manager. `rows` keeps a snapshot of every picked row, so picks survive paging and can be
 * summarized and targeted without the page that showed them; `all-matching` stands for every row the current
 * filters match, including rows never loaded, minus explicit exclusions. It resolves against the server when a
 * preview is requested.
 */
export type IntermediatesSelection =
  | { mode: 'rows'; rows: ReadonlyMap<string, IntermediatesRow> }
  | { mode: 'all-matching'; excluded: ReadonlySet<string> };

export const EMPTY_SELECTION: IntermediatesSelection = { mode: 'rows', rows: new Map() };

export const isRowSelected = (selection: IntermediatesSelection, row: IntermediatesRow): boolean =>
  selection.mode === 'all-matching'
    ? !selection.excluded.has(getIntermediatesRowKey(row))
    : selection.rows.has(getIntermediatesRowKey(row));

export const withRowSelected = (selection: IntermediatesSelection, row: IntermediatesRow): IntermediatesSelection => {
  return isRowSelected(selection, row) ? selection : toggleRowSelection(selection, row);
};

export const toggleRowSelection = (
  selection: IntermediatesSelection,
  row: IntermediatesRow
): IntermediatesSelection => {
  const key = getIntermediatesRowKey(row);
  if (selection.mode === 'all-matching') {
    const excluded = new Set(selection.excluded);
    if (excluded.has(key)) {
      excluded.delete(key);
    } else {
      excluded.add(key);
    }
    return { mode: 'all-matching', excluded };
  }
  const rows = new Map(selection.rows);
  if (rows.has(key)) {
    rows.delete(key);
  } else {
    rows.set(key, row);
  }
  return { mode: 'rows', rows };
};

export const selectAllMatching = (): IntermediatesSelection => ({ mode: 'all-matching', excluded: new Set() });

export interface SelectionSummary {
  rows: number;
  safeImages: number;
  safeVideos: number;
  referencedImages: number;
  referencedVideos: number;
  reclaimableBytes: number;
  referencedBytes: number;
  unknownSizeCount: number;
}

/**
 * Sums the selection. Explicit picks are summed from their snapshots, whichever page showed them; "all matching"
 * uses the server's totals. With exclusions, a complete current matching snapshot is required: old excluded-row
 * snapshots cannot tell us whether those rows still exist or how their counts changed.
 */
export const summarizeSelection = (
  selection: IntermediatesSelection,
  totals: { rows: number; safeImages: number; safeVideos: number; reclaimableBytes: number; unknownSizeCount: number },
  matchingRows?: readonly IntermediatesRow[],
  visibleRows: readonly IntermediatesRow[] = []
): SelectionSummary | null => {
  if (selection.mode === 'all-matching') {
    if (selection.excluded.size > 0) {
      return matchingRows
        ? summarizeSelection(
            {
              mode: 'rows',
              rows: new Map(
                matchingRows
                  .filter((row) => isRowSelected(selection, row))
                  .map((row) => [getIntermediatesRowKey(row), row])
              ),
            },
            totals
          )
        : null;
    }
    return {
      referencedBytes: 0,
      referencedImages: 0,
      referencedVideos: 0,
      reclaimableBytes: totals.reclaimableBytes,
      rows: totals.rows,
      safeImages: totals.safeImages,
      safeVideos: totals.safeVideos,
      unknownSizeCount: totals.unknownSizeCount,
    };
  }

  const summary: SelectionSummary = {
    referencedBytes: 0,
    referencedImages: 0,
    referencedVideos: 0,
    reclaimableBytes: 0,
    rows: 0,
    safeImages: 0,
    safeVideos: 0,
    unknownSizeCount: 0,
  };

  const freshRows = new Map(visibleRows.map((row) => [getIntermediatesRowKey(row), row]));
  for (const [key, snapshot] of selection.rows) {
    const row = freshRows.get(key) ?? snapshot;
    summary.rows += 1;
    summary.safeImages += row.images.safe;
    summary.safeVideos += row.videos.safe;
    summary.referencedImages += row.images.referenced;
    summary.referencedVideos += row.videos.referenced;
    summary.reclaimableBytes += row.reclaimableBytes;
    summary.referencedBytes += row.referencedBytes;
    summary.unknownSizeCount += row.unknownSizeCount;
  }

  return summary;
};

const toTarget = ({ projectId, userId }: IntermediatesScopeTarget): IntermediatesScopeTarget => ({ projectId, userId });

/**
 * What a confirmation acts on before it reaches the server. `matching` is every row the current filters match minus
 * the exclusions; the cleanup scope cannot express filters, so it must be resolved against a complete matching read
 * with `resolveMatchingTargets` before a preview is requested.
 */
export type IntermediatesScopeRequest = IntermediatesScope | { kind: 'matching'; excluded: ReadonlySet<string> };

/**
 * Without a row filter or exclusions, "all matching" is exactly the owner filter (or everyone), which the server can
 * freeze without the client enumerating rows. Explicit picks become their targets.
 */
export const resolveScope = (options: {
  selection: IntermediatesSelection;
  hasSubsetFilter: boolean;
  ownerId: string | null;
}): IntermediatesScopeRequest => {
  const { hasSubsetFilter, ownerId, selection } = options;

  if (selection.mode === 'rows') {
    return { kind: 'selection', targets: [...selection.rows.values()].map(toTarget) };
  }
  if (selection.excluded.size > 0 || hasSubsetFilter) {
    return { kind: 'matching', excluded: selection.excluded };
  }
  return ownerId === null ? { kind: 'everyone' } : { kind: 'owner', userId: ownerId };
};

/** The explicit targets of a `matching` request, given every row the filters match. */
export const resolveMatchingTargets = (
  excluded: ReadonlySet<string>,
  matchingRows: readonly IntermediatesRow[]
): IntermediatesScopeTarget[] => matchingRows.filter((row) => !excluded.has(getIntermediatesRowKey(row))).map(toTarget);
