import type { IntermediatesRow, IntermediatesScope, IntermediatesScopeTarget } from './types';

import { getIntermediatesRowKey } from './types';

/**
 * Row selection for the manager. `rows` keeps a snapshot of every picked row, so picks survive paging and can be
 * summarized and targeted without the page that showed them; `all-matching` stands for every row the current
 * filters match, including rows never loaded, and resolves against the server when a preview is requested.
 */
export type IntermediatesSelection =
  | { mode: 'rows'; rows: ReadonlyMap<string, IntermediatesRow> }
  | { mode: 'all-matching' };

export const EMPTY_SELECTION: IntermediatesSelection = { mode: 'rows', rows: new Map() };

export const isRowSelected = (selection: IntermediatesSelection, row: IntermediatesRow): boolean =>
  selection.mode === 'all-matching' || selection.rows.has(getIntermediatesRowKey(row));

export const isSelectionEmpty = (selection: IntermediatesSelection): boolean =>
  selection.mode === 'rows' && selection.rows.size === 0;

const materialize = (
  selection: IntermediatesSelection,
  visibleRows: readonly IntermediatesRow[]
): Map<string, IntermediatesRow> =>
  new Map(
    selection.mode === 'all-matching'
      ? visibleRows.map((row) => [getIntermediatesRowKey(row), row] as const)
      : selection.rows
  );

export const withRowSelected = (selection: IntermediatesSelection, row: IntermediatesRow): IntermediatesSelection => {
  if (selection.mode === 'all-matching' || selection.rows.has(getIntermediatesRowKey(row))) {
    return selection;
  }
  const rows = new Map(selection.rows);

  rows.set(getIntermediatesRowKey(row), row);

  return { mode: 'rows', rows };
};

export const toggleRowSelection = (
  selection: IntermediatesSelection,
  row: IntermediatesRow,
  visibleRows: readonly IntermediatesRow[]
): IntermediatesSelection => {
  const key = getIntermediatesRowKey(row);
  // Leaving "all matching" materializes the visible page minus the toggled row; rows beyond the page cannot be kept.
  const rows = materialize(selection, visibleRows);

  if (rows.has(key)) {
    rows.delete(key);
  } else {
    rows.set(key, row);
  }

  return { mode: 'rows', rows };
};

export const selectAllMatching = (): IntermediatesSelection => ({ mode: 'all-matching' });

export type PageSelectionState = 'none' | 'some' | 'all';

export const getPageSelectionState = (
  selection: IntermediatesSelection,
  visibleRows: readonly IntermediatesRow[]
): PageSelectionState => {
  if (visibleRows.length === 0) {
    return 'none';
  }
  if (selection.mode === 'all-matching') {
    return 'all';
  }

  const selected = visibleRows.filter((row) => selection.rows.has(getIntermediatesRowKey(row))).length;

  return selected === 0 ? 'none' : selected === visibleRows.length ? 'all' : 'some';
};

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
 * uses the server's totals, which cover every matching row.
 */
export const summarizeSelection = (
  selection: IntermediatesSelection,
  totals: { rows: number; safeImages: number; safeVideos: number; reclaimableBytes: number; unknownSizeCount: number }
): SelectionSummary => {
  if (selection.mode === 'all-matching') {
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

  for (const row of selection.rows.values()) {
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

export const selectionToTargets = (
  selection: IntermediatesSelection,
  loadedRows: readonly IntermediatesRow[]
): IntermediatesScopeTarget[] =>
  [...(selection.mode === 'all-matching' ? loadedRows : selection.rows.values())].map(({ projectId, userId }) => ({
    projectId,
    userId,
  }));

/**
 * The scope a confirmation acts on. Without a row filter, "all matching" is exactly the owner filter (or everyone),
 * which the server can freeze without the client enumerating rows.
 */
export const resolveScope = (options: {
  selection: IntermediatesSelection;
  loadedRows: readonly IntermediatesRow[];
  hasSubsetFilter: boolean;
  ownerId: string | null;
}): IntermediatesScope => {
  const { hasSubsetFilter, loadedRows, ownerId, selection } = options;

  if (selection.mode === 'all-matching' && !hasSubsetFilter) {
    return ownerId === null ? { kind: 'everyone' } : { kind: 'owner', userId: ownerId };
  }

  return { kind: 'selection', targets: selectionToTargets(selection, loadedRows) };
};
