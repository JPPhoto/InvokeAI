import type {
  IntermediatesCleanupMode,
  IntermediatesPreview,
  IntermediatesRow,
  IntermediatesScope,
} from '@features/intermediates/core/types';
/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-jsx-as-prop */
import type { IntermediatesSummaryParams } from '@features/intermediates/data/keys';
import type { TFunction } from 'i18next';

import {
  Badge,
  Box,
  Center,
  Checkbox,
  HStack,
  Icon,
  Input,
  InputGroup,
  Separator,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import {
  EMPTY_SELECTION,
  isRowSelected,
  resolveScope,
  selectAllMatching,
  summarizeSelection,
  toggleRowSelection,
  withRowSelected,
  type IntermediatesSelection,
} from '@features/intermediates/core/selection';
import {
  createIntermediatesPreview,
  getIntermediatesOperation,
  getIntermediatesSummary,
  retryIntermediatesOperation,
  startIntermediatesOperation,
} from '@features/intermediates/data/api';
import { takeIntermediatesFocus } from '@features/intermediates/data/focus';
import { intermediatesKeys } from '@features/intermediates/data/keys';
import {
  activeOperationStore,
  clearPendingIntermediatesStart,
  followIntermediatesOperation,
  isPendingIntermediatesStartCurrent,
  recordPendingIntermediatesStart,
  restoreIntermediatesReceipt,
} from '@features/intermediates/data/operationStore';
import {
  INTERMEDIATES_MAX_ROWS,
  INTERMEDIATES_PAGE_SIZE,
  intermediatesOperationQueryOptions,
  intermediatesSummaryQueryOptions,
} from '@features/intermediates/data/queries';
import { attachIntermediatesRealtime } from '@features/intermediates/data/realtime';
import { useMountEffect } from '@platform/react/useMountEffect';
import {
  assertAccountScopeCurrent,
  captureAccountScope,
  isAccountScopeCurrent,
} from '@platform/state/accountLifecycle';
import { ApiError, getApiErrorMessage } from '@platform/transport/http';
import { Button, IconButton } from '@platform/ui/Button';
import { EmptyState } from '@platform/ui/EmptyState';
import { Scrollable } from '@platform/ui/Scrollable';
import { Tooltip } from '@platform/ui/Tooltip';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BrushCleaningIcon, RefreshCwIcon, SearchIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ClearDialogState } from './ClearDialog';

import { ClearDialog } from './ClearDialog';
import { formatBytes } from './format';
import { getOwnerLabel, IntermediatesList } from './IntermediatesList';
import { OperationPanel } from './OperationPanel';

export interface IntermediatesManagerProps {
  /** The current account, or null in single-user mode where the install is the only account. */
  currentUserId: string | null;
  canClearOthersIntermediates: boolean;
}

const SEARCH_ICON = <Icon as={SearchIcon} boxSize="3.5" color="fg.subtle" />;
const EMPTY_ROWS: readonly IntermediatesRow[] = [];
const EMPTY_TOTALS = { reclaimableBytes: 0, rows: 0, safeImages: 0, safeVideos: 0, unknownSizeCount: 0 };

const formatSummarySize = (bytes: number, unknownCount: number, t: TFunction): string =>
  unknownCount > 0
    ? `${formatBytes(bytes)} ${t('intermediates.list.unmeasured', { count: unknownCount })}`
    : formatBytes(bytes);

let nextIdempotencyKey = 1;
const createIdempotencyKey = (): string => `intermediates:${Date.now().toString(36)}:${nextIdempotencyKey++}`;

const isDefinitiveStartRejection = (error: unknown): boolean =>
  error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408;

const getLatestRetry = async (operationId: string, signal: AbortSignal) => {
  let operation = await getIntermediatesOperation(operationId, signal);
  const visited = new Set<string>([operationId]);
  while (operation.retriedByOperationId && !visited.has(operation.retriedByOperationId)) {
    visited.add(operation.retriedByOperationId);
    operation = await getIntermediatesOperation(operation.retriedByOperationId, signal);
  }
  return operation;
};

/** The Settings section: search, a select-all row with the delete action, and one row per project. */
export const IntermediatesManager = ({ canClearOthersIntermediates, currentUserId }: IntermediatesManagerProps) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // An entry point's intent is read once, when the section mounts; a later visit starts clean.
  const [focus] = useState(takeIntermediatesFocus);
  const [search, setSearch] = useState('');
  const [ownerFilter, setOwnerFilter] = useState<string | null>(() =>
    focus?.ownerId && canClearOthersIntermediates ? focus.ownerId : currentUserId
  );
  const [projectFilter, setProjectFilter] = useState<string | null>(focus?.projectId ?? null);
  const [offset, setOffset] = useState(0);
  const [selection, setSelection] = useState<IntermediatesSelection>(EMPTY_SELECTION);
  // The focused project is queried directly, so pagination cannot hide the entry point's selection.
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(focus?.projectId ?? null);
  const [dialog, setDialog] = useState<ClearDialogState | null>(null);
  const activeOperationId = activeOperationStore.useSelector((snapshot) => snapshot.operationId);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const previewRequestRef = useRef(0);
  const pendingScopeRef = useRef<IntermediatesScope | null>(null);

  useMountEffect(() => {
    let mounted = true;
    const detach = attachIntermediatesRealtime(queryClient);
    const pending = restoreIntermediatesReceipt();
    if (pending) {
      const owner = captureAccountScope();
      void startIntermediatesOperation(pending, owner.signal)
        .then((operation) => {
          if (mounted && isAccountScopeCurrent(owner) && isPendingIntermediatesStartCurrent(pending)) {
            queryClient.setQueryData(intermediatesKeys.operation(owner, operation.operationId), operation);
            followIntermediatesOperation(operation.operationId);
          }
        })
        .catch((error: unknown) => {
          if (mounted && isAccountScopeCurrent(owner) && isPendingIntermediatesStartCurrent(pending)) {
            if (isDefinitiveStartRejection(error)) {
              clearPendingIntermediatesStart();
            }
            setRecoveryError(getApiErrorMessage(error, t('intermediates.dialog.startFailed')));
          }
        });
    } else {
      const operationId = activeOperationStore.getSnapshot().operationId;
      if (operationId) {
        const owner = captureAccountScope();
        void getLatestRetry(operationId, owner.signal)
          .then((operation) => {
            if (
              mounted &&
              isAccountScopeCurrent(owner) &&
              activeOperationStore.getSnapshot().operationId === operationId &&
              operation.operationId !== operationId
            ) {
              queryClient.setQueryData(intermediatesKeys.operation(owner, operation.operationId), operation);
              followIntermediatesOperation(operation.operationId);
            }
          })
          .catch(() => undefined); // The operation query reports lookup failures in the panel.
      }
    }
    return () => {
      mounted = false;
      detach();
    };
  });

  // Non-admins are confined to their own rows by the server whatever is sent.
  const ownerId: string | null = canClearOthersIntermediates ? ownerFilter : currentUserId;
  const params = useMemo<IntermediatesSummaryParams>(
    () => ({
      limit: INTERMEDIATES_PAGE_SIZE,
      offset,
      order: 'desc',
      ownerId,
      projectId: projectFilter,
      search,
      sort: 'reclaimable_bytes',
    }),
    [offset, ownerId, projectFilter, search]
  );
  const query = useQuery(intermediatesSummaryQueryOptions(params));
  const rows = query.data?.items ?? EMPTY_ROWS;
  const totals = query.data?.totals;
  const hasSearch = search.trim().length > 0;
  const hasSubsetFilter = hasSearch || projectFilter !== null;
  // Rows disappearing (a cleanup, a narrower search) can leave the offset past the end; step back to a valid page.
  if (query.data && offset > 0 && offset >= query.data.total) {
    setOffset(
      Math.max(0, Math.floor(Math.max(query.data.total - 1, 0) / INTERMEDIATES_PAGE_SIZE) * INTERMEDIATES_PAGE_SIZE)
    );
  }
  const focusedRow = pendingProjectId ? rows.find((row) => row.projectId === pendingProjectId) : undefined;
  const effectiveSelection = focusedRow ? withRowSelected(selection, focusedRow) : selection;
  const hasExclusions = effectiveSelection.mode === 'all-matching' && effectiveSelection.excluded.size > 0;
  // One bounded read, shared across UI pages and refreshed by the same summary invalidations.
  const matchingSnapshotQuery = useQuery({
    ...intermediatesSummaryQueryOptions({ ...params, limit: INTERMEDIATES_MAX_ROWS, offset: 0 }),
    enabled: hasExclusions && query.data !== undefined,
  });
  const matchingSnapshot = matchingSnapshotQuery.data;
  const selectionOverLimit =
    hasExclusions && matchingSnapshot !== undefined && matchingSnapshot.total > matchingSnapshot.items.length;
  const operationQuery = useQuery({
    ...intermediatesOperationQueryOptions(activeOperationId ?? ''),
    enabled: activeOperationId !== null,
  });

  const resetSelection = useCallback(() => {
    setPendingProjectId(null);
    setSelection(EMPTY_SELECTION);
  }, []);
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearch(value);
      setProjectFilter(null);
      setOffset(0);
      // A filter change hides rows; hidden selections would act on what the user can no longer see.
      resetSelection();
    },
    [resetSelection]
  );
  const clearOwnerFilter = useCallback(() => {
    setOwnerFilter(null);
    setOffset(0);
    resetSelection();
  }, [resetSelection]);
  const showOwnAccount = useCallback(() => {
    setOwnerFilter(currentUserId);
    setOffset(0);
    resetSelection();
  }, [currentUserId, resetSelection]);
  const clearProjectFilter = useCallback(() => {
    setProjectFilter(null);
    setOffset(0);
    resetSelection();
  }, [resetSelection]);
  const handleToggleRow = useCallback(
    (row: IntermediatesRow) => {
      setPendingProjectId(null);
      setSelection(toggleRowSelection(effectiveSelection, row));
    },
    [effectiveSelection]
  );
  const selectionSummary = useMemo(
    () =>
      summarizeSelection(
        effectiveSelection,
        totals ?? EMPTY_TOTALS,
        matchingSnapshot && !matchingSnapshotQuery.isError && !selectionOverLimit ? matchingSnapshot.items : undefined,
        rows
      ),
    [effectiveSelection, matchingSnapshot, matchingSnapshotQuery.isError, rows, selectionOverLimit, totals]
  );
  const matchingRowCount = hasExclusions ? matchingSnapshot?.total : totals?.rows;
  // Select all selects every matching row, including pages not loaded; only a complete selection clears.
  const handleToggleAll = useCallback(() => {
    setPendingProjectId(null);
    setSelection(
      selectionSummary !== null && selectionSummary.rows === matchingRowCount ? EMPTY_SELECTION : selectAllMatching()
    );
  }, [selectionSummary, matchingRowCount]);

  const loadPreview = useCallback(
    async (mode: IntermediatesCleanupMode, scope: IntermediatesScope) => {
      const requestId = ++previewRequestRef.current;
      const owner = captureAccountScope();
      setDialog((current) => ({
        idempotencyKey: current?.idempotencyKey ?? createIdempotencyKey(),
        isStarting: false,
        mode,
        preview: null,
        previewError: null,
        startError: null,
      }));
      try {
        let resolvedScope = scope;
        // Filters and exclusions cannot be expressed by the cleanup scope; resolve them to explicit rows.
        if (effectiveSelection.mode === 'all-matching' && scope.kind === 'selection') {
          const everything = await getIntermediatesSummary(
            { ...params, limit: INTERMEDIATES_MAX_ROWS, offset: 0 },
            owner.signal
          );
          assertAccountScopeCurrent(owner);
          if (everything.total > everything.items.length) {
            throw new Error(t('intermediates.dialog.tooManyRows', { count: everything.items.length }));
          }
          resolvedScope = {
            kind: 'selection',
            targets: everything.items
              .filter((row) => isRowSelected(effectiveSelection, row))
              .map(({ projectId, userId }) => ({ projectId, userId })),
          };
        }
        const preview = await createIntermediatesPreview({ mode, scope: resolvedScope }, owner.signal);
        assertAccountScopeCurrent(owner);
        if (previewRequestRef.current === requestId) {
          // One key per preview: every Confirm of this preview replays the same operation, and a later preview
          // (mode switch, retry) starts clean instead of colliding with a key the server already settled.
          setDialog((current) => (current ? { ...current, idempotencyKey: createIdempotencyKey(), preview } : current));
        }
      } catch (error) {
        if (previewRequestRef.current === requestId && isAccountScopeCurrent(owner)) {
          setDialog((current) =>
            current
              ? { ...current, previewError: getApiErrorMessage(error, t('intermediates.dialog.previewFailed')) }
              : current
          );
        }
      }
    },
    [effectiveSelection, params, t]
  );
  const openDialog = useCallback(
    (scope: IntermediatesScope, trigger: HTMLElement | null) => {
      dialogTriggerRef.current = trigger;
      pendingScopeRef.current = scope;
      setRetryError(null);
      setDialog(null);
      void loadPreview('safe', scope);
    },
    [loadPreview]
  );
  const closeDialog = useCallback(() => {
    previewRequestRef.current += 1;
    setDialog(null);
  }, []);
  const retryPreview = useCallback(() => {
    if (dialog && pendingScopeRef.current) {
      void loadPreview(dialog.mode, pendingScopeRef.current);
    }
  }, [dialog, loadPreview]);
  const changeMode = useCallback(
    (mode: IntermediatesCleanupMode) => {
      if (pendingScopeRef.current) {
        void loadPreview(mode, pendingScopeRef.current);
      }
    },
    [loadPreview]
  );
  const confirmDialog = useCallback(async () => {
    const preview: IntermediatesPreview | null = dialog?.preview ?? null;

    if (!dialog || !preview) {
      return;
    }
    const owner = captureAccountScope();
    recordPendingIntermediatesStart({ idempotencyKey: dialog.idempotencyKey, previewId: preview.previewId });
    setDialog((current) => (current ? { ...current, isStarting: true, startError: null } : current));
    try {
      const operation = await startIntermediatesOperation(
        { idempotencyKey: dialog.idempotencyKey, previewId: preview.previewId },
        owner.signal
      );
      assertAccountScopeCurrent(owner);
      queryClient.setQueryData(intermediatesKeys.operation(owner, operation.operationId), operation);
      followIntermediatesOperation(operation.operationId);
      resetSelection();
      setDialog(null);
    } catch (error) {
      if (!isAccountScopeCurrent(owner)) {
        return;
      }
      // A 404 means the preview expired or was consumed by a request whose response was lost; only a new
      // preview can move forward, so offer that instead of a dead Confirm.
      const previewGone = error instanceof ApiError && error.status === 404;
      if (isDefinitiveStartRejection(error)) {
        clearPendingIntermediatesStart();
      }
      setDialog((current) =>
        current
          ? {
              ...current,
              isStarting: false,
              preview: previewGone ? null : current.preview,
              previewError: previewGone ? t('intermediates.dialog.previewExpired') : current.previewError,
              startError: previewGone ? null : getApiErrorMessage(error, t('intermediates.dialog.startFailed')),
            }
          : current
      );
    }
  }, [dialog, queryClient, resetSelection, t]);

  const handleRetry = useCallback(async () => {
    if (!activeOperationId) {
      return;
    }
    const owner = captureAccountScope();
    setIsRetrying(true);
    setRetryError(null);
    try {
      const operation = await retryIntermediatesOperation(activeOperationId, owner.signal);
      assertAccountScopeCurrent(owner);
      queryClient.setQueryData(intermediatesKeys.operation(owner, operation.operationId), operation);
      followIntermediatesOperation(operation.operationId);
    } catch (error) {
      if (isAccountScopeCurrent(owner)) {
        try {
          const latest = await getLatestRetry(activeOperationId, owner.signal);
          if (
            latest.operationId !== activeOperationId &&
            isAccountScopeCurrent(owner) &&
            activeOperationStore.getSnapshot().operationId === activeOperationId
          ) {
            queryClient.setQueryData(intermediatesKeys.operation(owner, latest.operationId), latest);
            followIntermediatesOperation(latest.operationId);
            return;
          }
        } catch {
          // Preserve the original retry error when reconciliation is unavailable.
        }
        setRetryError(getApiErrorMessage(error, t('intermediates.operation.retryFailed')));
      }
    } finally {
      if (isAccountScopeCurrent(owner)) {
        setIsRetrying(false);
      }
    }
  }, [activeOperationId, queryClient, t]);
  const dismissOperation = useCallback(() => {
    followIntermediatesOperation(null);
    setRetryError(null);
    // The Dismiss button unmounts with the panel; keep keyboard focus in the section.
    searchRef.current?.focus();
  }, []);
  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: intermediatesKeys.all });
  }, [queryClient]);

  const selectedScope = resolveScope({ hasSubsetFilter, loadedRows: rows, ownerId, selection: effectiveSelection });
  const hasSelection = selectionSummary ? selectionSummary.rows > 0 : hasExclusions && (totals?.rows ?? 0) > 0;
  const selectionState = hasSelection
    ? selectionSummary !== null && selectionSummary.rows === matchingRowCount
      ? 'all'
      : 'some'
    : 'none';
  const filteredOwnerRow = ownerFilter ? rows[0] : undefined;
  const hasPreviousPage = offset > 0;
  const hasNextPage = query.data !== undefined && offset + rows.length < query.data.total;
  const showPagination = offset > 0 || (query.data?.total ?? 0) > INTERMEDIATES_PAGE_SIZE;

  return (
    <Stack gap="3" h="full" minH="0">
      <HStack align="flex-start" gap="3" justify="space-between">
        <Stack gap="0.5" minW="0">
          <Text fontSize="sm" fontWeight="600">
            {t('intermediates.title')}
          </Text>
          <Text color="fg.muted" fontSize="xs">
            {t('intermediates.description')}
          </Text>
        </Stack>
        <Tooltip content={t('intermediates.refresh')}>
          <IconButton
            aria-label={t('intermediates.refresh')}
            disabled={query.isFetching}
            flexShrink={0}
            size="xs"
            variant="outline"
            onClick={handleRefresh}
          >
            <RefreshCwIcon />
          </IconButton>
        </Tooltip>
      </HStack>
      {recoveryError ? (
        <Text color="fg.error" fontSize="xs" role="alert">
          {recoveryError}
        </Text>
      ) : null}
      <HStack flexWrap="wrap" gap="2">
        <InputGroup flex="1 1 16rem" minW="0" startElement={SEARCH_ICON}>
          <Input
            ref={searchRef}
            aria-label={t('intermediates.searchLabel')}
            placeholder={
              canClearOthersIntermediates
                ? t('intermediates.searchPlaceholderAdmin')
                : t('intermediates.searchPlaceholder')
            }
            size="xs"
            value={search}
            onChange={(event) => handleSearchChange(event.currentTarget.value)}
          />
        </InputGroup>
        {canClearOthersIntermediates && ownerFilter ? (
          <Badge flexShrink={0} fontSize="2xs" gap="1" pe="0.5" variant="surface">
            {t('intermediates.owner.filtered', {
              name: filteredOwnerRow ? getOwnerLabel(filteredOwnerRow) : ownerFilter,
            })}
            <Tooltip content={t('intermediates.owner.showEveryone')}>
              <IconButton
                aria-label={t('intermediates.owner.showEveryone')}
                minW="4"
                size="2xs"
                variant="ghost"
                onClick={clearOwnerFilter}
              >
                <Icon as={XIcon} boxSize="3" />
              </IconButton>
            </Tooltip>
          </Badge>
        ) : null}
        {canClearOthersIntermediates && !ownerFilter && currentUserId ? (
          <Button size="2xs" variant="outline" onClick={showOwnAccount}>
            {t('intermediates.owner.showMine')}
          </Button>
        ) : null}
        {projectFilter ? (
          <Badge flexShrink={0} fontSize="2xs" gap="1" pe="0.5" variant="surface">
            {focusedRow?.projectName ?? t('intermediates.owner.projectFilter')}
            <Tooltip content={t('intermediates.owner.showAllProjects')}>
              <IconButton
                aria-label={t('intermediates.owner.showAllProjects')}
                minW="4"
                size="2xs"
                variant="ghost"
                onClick={clearProjectFilter}
              >
                <Icon as={XIcon} boxSize="3" />
              </IconButton>
            </Tooltip>
          </Badge>
        ) : null}
      </HStack>
      {activeOperationId ? (
        <OperationPanel
          isLoading={operationQuery.isPending}
          isRefetching={operationQuery.isFetching}
          lookupError={
            operationQuery.isError
              ? getApiErrorMessage(operationQuery.error, t('intermediates.operation.lookupFailed'))
              : null
          }
          onRefetch={() => void operationQuery.refetch()}
          isRetrying={isRetrying}
          operation={operationQuery.data ?? null}
          retryError={retryError}
          onDismiss={dismissOperation}
          onRetry={() => void handleRetry()}
        />
      ) : null}
      <Stack flex="1" gap="0" minH="0" mt="-3">
        {/* Keep the bar mounted so a selection never shifts the rows beneath it. */}
        <HStack borderBottomWidth="1px" borderColor="border.subtle" flexShrink={0} gap="2" minH="8" py="1.5">
          <Checkbox.Root
            aria-label={t('intermediates.list.selectAll')}
            checked={selectionState === 'all' ? true : selectionState === 'some' ? 'indeterminate' : false}
            colorPalette="accent"
            disabled={rows.length === 0}
            size="xs"
            onCheckedChange={handleToggleAll}
            pl="2"
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control />
            <Checkbox.Label color="fg.muted" fontSize="2xs" fontWeight="600">
              {t('intermediates.list.selectAll')}
            </Checkbox.Label>
          </Checkbox.Root>
          <Text color="fg.muted" flex="1" fontSize="2xs" minW="0" textAlign="end" truncate>
            {hasExclusions && selectionSummary === null
              ? t(
                  selectionOverLimit
                    ? 'intermediates.selection.tooManyRows'
                    : matchingSnapshotQuery.isError
                      ? 'intermediates.selection.estimateFailed'
                      : 'intermediates.selection.checking',
                  { count: INTERMEDIATES_MAX_ROWS }
                )
              : hasSelection && selectionSummary
                ? t('intermediates.selection.estimate', {
                    count: selectionSummary.rows,
                    images: t('intermediates.counts.images', { count: selectionSummary.safeImages }),
                    size: formatSummarySize(selectionSummary.reclaimableBytes, selectionSummary.unknownSizeCount, t),
                    videos: t('intermediates.counts.videos', { count: selectionSummary.safeVideos }),
                  })
                : totals
                  ? t('intermediates.selection.available', {
                      images: t('intermediates.counts.images', { count: totals.safeImages }),
                      size: formatSummarySize(totals.reclaimableBytes, totals.unknownSizeCount, t),
                      videos: t('intermediates.counts.videos', { count: totals.safeVideos }),
                    })
                  : ''}
          </Text>
          {query.data?.measuring ? (
            <Tooltip content={t('intermediates.stats.measuringNote')}>
              <Spinner aria-label={t('intermediates.stats.measuringNote')} color="fg.muted" size="xs" />
            </Tooltip>
          ) : null}
          <Separator borderColor="border.subtle" h="4" orientation="vertical" />
          <Button
            colorPalette="red"
            disabled={!hasSelection}
            size="2xs"
            variant="ghost"
            onClick={(event) => openDialog(selectedScope, event.currentTarget)}
          >
            <Icon as={Trash2Icon} boxSize="3" />
            {t('intermediates.list.delete')}
          </Button>
        </HStack>
        {query.isPending ? (
          <Center flex="1" minH="32">
            <Spinner color="fg.subtle" size="sm" />
          </Center>
        ) : query.isError ? (
          <Center flex="1" px="4">
            <EmptyState
              danger
              description={getApiErrorMessage(query.error, t('intermediates.errors.couldNotLoad'))}
              title={t('intermediates.errors.couldNotLoad')}
            >
              <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
                {t('common.retry')}
              </Button>
            </EmptyState>
          </Center>
        ) : rows.length === 0 ? (
          <Center flex="1" px="4">
            <EmptyState
              description={
                hasSearch ? t('intermediates.empty.noMatchesDescription') : t('intermediates.empty.description')
              }
              icon={<Icon as={hasSearch ? SearchIcon : BrushCleaningIcon} />}
              title={hasSearch ? t('intermediates.empty.noMatches') : t('intermediates.empty.title')}
            >
              {hasSearch ? (
                <Button size="xs" variant="outline" onClick={() => handleSearchChange('')}>
                  {t('common.clearSearch')}
                </Button>
              ) : null}
            </EmptyState>
          </Center>
        ) : (
          <Scrollable flex="1" h="full" label={t('intermediates.title')} minH="0">
            <Box py="1">
              <IntermediatesList
                isSelected={(row) => isRowSelected(effectiveSelection, row)}
                rows={rows}
                showOwner={canClearOthersIntermediates && ownerId === null}
                onToggleRow={handleToggleRow}
              />
            </Box>
          </Scrollable>
        )}
        {showPagination ? (
          <HStack borderColor="border.subtle" borderTopWidth="1px" flexShrink={0} justify="center" minH="8">
            <Button
              aria-label={t('common.previousPage')}
              disabled={!hasPreviousPage || query.isFetching}
              size="2xs"
              variant="ghost"
              onClick={() => setOffset((current) => Math.max(0, current - INTERMEDIATES_PAGE_SIZE))}
            >
              {t('common.previousPage')}
            </Button>
            <Text aria-live="polite" color="fg.muted" fontSize="2xs">
              {t('common.pageNumber', { page: Math.floor(offset / INTERMEDIATES_PAGE_SIZE) + 1 })}
            </Text>
            <Button
              aria-label={t('common.nextPage')}
              disabled={!hasNextPage || query.isFetching}
              size="2xs"
              variant="ghost"
              onClick={() => setOffset((current) => current + INTERMEDIATES_PAGE_SIZE)}
            >
              {t('common.nextPage')}
            </Button>
          </HStack>
        ) : null}
      </Stack>
      <ClearDialog
        fallbackFocusRef={searchRef}
        finalFocusRef={dialogTriggerRef}
        state={dialog}
        onClose={closeDialog}
        onConfirm={() => void confirmDialog()}
        onModeChange={changeMode}
        onRetryPreview={retryPreview}
      />
    </Stack>
  );
};
