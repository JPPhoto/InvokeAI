import type { IntermediatesRow } from '@features/intermediates/core/types';
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
import { isRowSelected, resolveScope } from '@features/intermediates/core/selection';
import { takeIntermediatesFocus } from '@features/intermediates/data/focus';
import { intermediatesKeys } from '@features/intermediates/data/keys';
import {
  INTERMEDIATES_MAX_ROWS,
  INTERMEDIATES_PAGE_SIZE,
  intermediatesSummaryQueryOptions,
} from '@features/intermediates/data/queries';
import { getApiErrorMessage } from '@platform/transport/http';
import { Button, IconButton } from '@platform/ui/Button';
import { EmptyState } from '@platform/ui/EmptyState';
import { Scrollable } from '@platform/ui/Scrollable';
import { Tooltip } from '@platform/ui/Tooltip';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BrushCleaningIcon, RefreshCwIcon, SearchIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ClearDialog } from './ClearDialog';
import { formatBytes } from './format';
import { getOwnerLabel, IntermediatesList } from './IntermediatesList';
import { OperationPanel } from './OperationPanel';
import { useCleanupDialog } from './useCleanupDialog';
import { useFollowedOperation } from './useFollowedOperation';
import { useIntermediatesSelection } from './useIntermediatesSelection';

export interface IntermediatesManagerProps {
  /** The current account, or null in single-user mode where the install is the only account. */
  currentUserId: string | null;
  canClearOthersIntermediates: boolean;
}

const SEARCH_ICON = <Icon as={SearchIcon} boxSize="3.5" color="fg.subtle" />;
const EMPTY_ROWS: readonly IntermediatesRow[] = [];

const isSameListExceptOffset = (previous: unknown, next: IntermediatesSummaryParams): boolean => {
  if (typeof previous !== 'object' || previous === null) {
    return false;
  }
  const { offset: _previousOffset, ...previousRest } = previous as IntermediatesSummaryParams;
  const { offset: _nextOffset, ...nextRest } = next;
  const keys = new Set([...Object.keys(previousRest), ...Object.keys(nextRest)]) as Set<keyof typeof nextRest>;
  return [...keys].every((key) => previousRest[key] === nextRest[key]);
};

const formatSummarySize = (bytes: number, unknownCount: number, t: TFunction): string =>
  unknownCount > 0
    ? `${formatBytes(bytes)} ${t('intermediates.list.unmeasured', { count: unknownCount })}`
    : formatBytes(bytes);

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
  const searchRef = useRef<HTMLInputElement | null>(null);
  const operation = useFollowedOperation({ fallbackFocusRef: searchRef });

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
  // Paging keeps the current rows on screen until the next page arrives; any other change is a different list.
  const query = useQuery({
    ...intermediatesSummaryQueryOptions(params),
    placeholderData: (previous, previousQuery) =>
      previousQuery && isSameListExceptOffset(previousQuery.queryKey.at(-1), params) ? previous : undefined,
  });
  const isPaging = query.isPlaceholderData;
  const rows = query.data?.items ?? EMPTY_ROWS;
  const totals = query.data?.totals;
  const hasSearch = search.trim().length > 0;
  const hasSubsetFilter = hasSearch || projectFilter !== null;
  // Rows disappearing (a cleanup, a narrower search) can leave the offset past the end; step back to a valid page.
  if (query.data && !query.isPlaceholderData && offset > 0 && offset >= query.data.total) {
    setOffset(
      Math.max(0, Math.floor(Math.max(query.data.total - 1, 0) / INTERMEDIATES_PAGE_SIZE) * INTERMEDIATES_PAGE_SIZE)
    );
  }
  const selection = useIntermediatesSelection({
    initialProjectId: focus?.projectId ?? null,
    params,
    rows,
    summary: query.data,
  });
  const dialog = useCleanupDialog({ onStarted: selection.reset, params, selection: selection.effectiveSelection });
  const { reset: resetSelection } = selection;

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
  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: intermediatesKeys.all });
  }, [queryClient]);

  const selectedScope = resolveScope({
    hasSubsetFilter,
    loadedRows: rows,
    ownerId,
    selection: selection.effectiveSelection,
  });
  const { selectionSummary } = selection;
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
      {operation.recoveryError ? (
        <Text color="fg.error" fontSize="xs" role="alert">
          {operation.recoveryError}
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
            {selection.focusedRow?.projectName ?? t('intermediates.owner.projectFilter')}
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
      {operation.operationId ? (
        <OperationPanel
          isLoading={operation.query.isPending}
          isRefetching={operation.query.isFetching}
          lookupError={
            operation.query.isError
              ? getApiErrorMessage(operation.query.error, t('intermediates.operation.lookupFailed'))
              : null
          }
          onRefetch={() => void operation.query.refetch()}
          isRetrying={operation.isRetrying}
          operation={operation.query.data ?? null}
          retryError={operation.retryError}
          onDismiss={operation.dismiss}
          onRetry={() => void operation.retry()}
        />
      ) : null}
      <Stack flex="1" gap="0" minH="0" mt="-3">
        {/* Keep the bar mounted so a selection never shifts the rows beneath it. */}
        <HStack borderBottomWidth="1px" borderColor="border.subtle" flexShrink={0} gap="2" minH="8" py="1.5">
          <Checkbox.Root
            aria-label={t('intermediates.list.selectAll')}
            checked={
              selection.selectionState === 'all' ? true : selection.selectionState === 'some' ? 'indeterminate' : false
            }
            colorPalette="accent"
            disabled={rows.length === 0 || isPaging}
            size="xs"
            onCheckedChange={selection.toggleAll}
            pl="2"
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control />
            <Checkbox.Label color="fg.muted" fontSize="2xs" fontWeight="600">
              {t('intermediates.list.selectAll')}
            </Checkbox.Label>
          </Checkbox.Root>
          <Text color="fg.muted" flex="1" fontSize="2xs" minW="0" textAlign="end" truncate>
            {selection.estimateState && selectionSummary === null
              ? t(`intermediates.selection.${selection.estimateState}`, { count: INTERMEDIATES_MAX_ROWS })
              : selection.hasSelection && selectionSummary
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
            disabled={!selection.hasSelection}
            size="2xs"
            variant="ghost"
            onClick={(event) => {
              operation.clearRetryError();
              dialog.open(selectedScope, event.currentTarget);
            }}
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
                isBusy={isPaging}
                isSelected={(row) => isRowSelected(selection.effectiveSelection, row)}
                rows={rows}
                showOwner={canClearOthersIntermediates && ownerId === null}
                onToggleRow={selection.toggleRow}
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
              {t('common.pageNumber', {
                page: Math.floor((query.data?.offset ?? offset) / INTERMEDIATES_PAGE_SIZE) + 1,
              })}
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
        canManageEveryone={canClearOthersIntermediates}
        currentUserId={currentUserId}
        fallbackFocusRef={searchRef}
        finalFocusRef={dialog.triggerRef}
        state={dialog.state}
        onClose={dialog.close}
        onConfirm={() => void dialog.confirm()}
        onModeChange={dialog.changeMode}
        onRetryPreview={dialog.retryPreview}
      />
    </Stack>
  );
};
