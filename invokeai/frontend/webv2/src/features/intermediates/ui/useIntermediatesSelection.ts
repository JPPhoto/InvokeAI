import type { IntermediatesRow, IntermediatesSummary } from '@features/intermediates/core/types';
import type { IntermediatesSummaryParams } from '@features/intermediates/data/keys';

import {
  EMPTY_SELECTION,
  selectAllMatching,
  summarizeSelection,
  toggleRowSelection,
  withRowSelected,
  type IntermediatesSelection,
} from '@features/intermediates/core/selection';
import { INTERMEDIATES_MAX_ROWS, intermediatesSummaryQueryOptions } from '@features/intermediates/data/queries';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

const EMPTY_TOTALS = { reclaimableBytes: 0, rows: 0, safeImages: 0, safeVideos: 0, unknownSizeCount: 0 };

/**
 * Row selection across pages. An entry point's project stays selected until the user changes the selection; with
 * exclusions, "all matching" is summarized from one bounded read of every matching row.
 */
export const useIntermediatesSelection = ({
  initialProjectId,
  params,
  rows,
  summary,
}: {
  initialProjectId: string | null;
  params: IntermediatesSummaryParams;
  rows: readonly IntermediatesRow[];
  summary: IntermediatesSummary | undefined;
}) => {
  const [selection, setSelection] = useState<IntermediatesSelection>(EMPTY_SELECTION);
  // The manager filters to the focused project, so pagination cannot hide the entry point's selection.
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(initialProjectId);
  const totals = summary?.totals;
  const focusedRow = pendingProjectId ? rows.find((row) => row.projectId === pendingProjectId) : undefined;
  const effectiveSelection = focusedRow ? withRowSelected(selection, focusedRow) : selection;
  const hasExclusions = effectiveSelection.mode === 'all-matching' && effectiveSelection.excluded.size > 0;
  // One bounded read, shared across UI pages and refreshed by the same summary invalidations.
  const matchingSnapshotQuery = useQuery({
    ...intermediatesSummaryQueryOptions({ ...params, limit: INTERMEDIATES_MAX_ROWS, offset: 0 }),
    enabled: hasExclusions && summary !== undefined,
  });
  const matchingSnapshot = matchingSnapshotQuery.data;
  const isOverLimit =
    hasExclusions && matchingSnapshot !== undefined && matchingSnapshot.total > matchingSnapshot.items.length;
  const selectionSummary = useMemo(
    () =>
      summarizeSelection(
        effectiveSelection,
        totals ?? EMPTY_TOTALS,
        matchingSnapshot && !matchingSnapshotQuery.isError && !isOverLimit ? matchingSnapshot.items : undefined,
        rows
      ),
    [effectiveSelection, isOverLimit, matchingSnapshot, matchingSnapshotQuery.isError, rows, totals]
  );
  const matchingRowCount = hasExclusions ? matchingSnapshot?.total : totals?.rows;
  const hasSelection = selectionSummary ? selectionSummary.rows > 0 : hasExclusions && (totals?.rows ?? 0) > 0;
  const isComplete = selectionSummary !== null && selectionSummary.rows === matchingRowCount;

  const reset = useCallback(() => {
    setPendingProjectId(null);
    setSelection(EMPTY_SELECTION);
  }, []);
  const toggleRow = useCallback(
    (row: IntermediatesRow) => {
      setPendingProjectId(null);
      setSelection(toggleRowSelection(effectiveSelection, row));
    },
    [effectiveSelection]
  );
  // Select all selects every matching row, including pages not loaded; only a complete selection clears.
  const toggleAll = useCallback(() => {
    setPendingProjectId(null);
    setSelection(isComplete ? EMPTY_SELECTION : selectAllMatching());
  }, [isComplete]);

  return {
    effectiveSelection,
    /** Why an "all matching" estimate is unavailable, when it is. */
    estimateState: !hasExclusions
      ? null
      : isOverLimit
        ? ('tooManyRows' as const)
        : matchingSnapshotQuery.isError
          ? ('estimateFailed' as const)
          : ('checking' as const),
    hasSelection,
    reset,
    selectionState: hasSelection ? (isComplete ? ('all' as const) : ('some' as const)) : ('none' as const),
    selectionSummary,
    toggleAll,
    toggleRow,
  };
};
