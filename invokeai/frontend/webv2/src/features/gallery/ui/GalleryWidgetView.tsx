import type { GalleryItem, GalleryItemRef } from '@features/gallery/core/items';
import type { GalleryItemsFilter } from '@features/gallery/data/queries';

import { getGallerySelectionPageAfterRemoval, toGalleryItemKey, toGalleryItemRef } from '@features/gallery/core/items';
import { getBoundedRecentImages } from '@features/gallery/core/recentImages';
import { getGallerySettings } from '@features/gallery/core/settings';
import { GALLERY_PAGE_SIZE, galleryItemNamesOptions } from '@features/gallery/data/queries';
import { StatusWidgetChip } from '@platform/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ImageIcon } from 'lucide-react';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import type { GalleryStateView } from './galleryStateView';

import { GalleryBoardDragMonitor } from './GalleryBoardDragMonitor';
import { getGalleryGridWindowIndexForItemKey, mergeGalleryLoadedItems } from './galleryGridLayout';
import { GalleryLayout } from './GalleryLayout';
import {
  getGalleryAnchoredWindowPage,
  getGalleryPage,
  getGalleryProjectBoardId,
  getGalleryRawSelectedBoardId,
  getGallerySearchTerm,
  getGallerySemanticImageQuery,
  getGalleryStarredOnly,
  getGalleryStateView,
  getGalleryTotalImages,
  getGalleryView,
} from './galleryStateView';
import {
  useGalleryItemActions,
  useGalleryUi,
  type GalleryItemActionContext,
  type GalleryWidgetProps,
  type GalleryWidgetRuntime,
} from './GalleryUiContext';
import {
  GalleryWidgetContext,
  type GalleryActions,
  type GalleryStarredStrip,
  type GalleryWidgetContextValue,
} from './GalleryWidgetContext';
import { useGalleryActions } from './useGalleryActions';
import { useGalleryData } from './useGalleryData';
import { useGalleryStarredStrip } from './useGalleryStarredStrip';

export const shouldPublishGalleryTotal = ({
  knownTotalImages,
  lastPublishedTotal,
  total,
}: {
  knownTotalImages: number | null;
  lastPublishedTotal: number | null;
  total: number | null;
}): boolean =>
  typeof total === 'number' && Number.isFinite(total) && total !== knownTotalImages && total !== lastPublishedTotal;

export const shouldEnableGalleryStarredStrip = ({
  anchoredWindowPage,
  infiniteListingOffset,
  isInfinite,
  semanticSearchActive,
  starredOnly,
}: {
  anchoredWindowPage: number;
  infiniteListingOffset: number;
  isInfinite: boolean;
  semanticSearchActive: boolean;
  starredOnly: boolean;
}): boolean =>
  !semanticSearchActive && !starredOnly && (isInfinite ? infiniteListingOffset === 0 : anchoredWindowPage === 0);

export const GalleryStatusChip = ({ count }: { count: number }) => {
  const { t } = useTranslation();

  return (
    <StatusWidgetChip icon={ImageIcon}>
      {t('widgets.gallery.statusChip', {
        count,
      })}
    </StatusWidgetChip>
  );
};

/** Keeps query identity local to the gallery consumer that owns it. */
export const useGallerySemanticImageQuery = (value: unknown) =>
  useMemo(() => getGallerySemanticImageQuery({ semanticImageQuery: value }), [value]);

export const GalleryWidgetView = ({ presentation, region, runtime }: GalleryWidgetProps) => {
  const {
    gallery: galleryCommands,
    galleryValues,
    generateValues,
    notifications,
    projectId,
    projectName,
    ItemActionsProvider,
  } = useGalleryUi();
  const galleryView = getGalleryView(galleryValues);
  const searchTerm = getGallerySearchTerm(galleryValues);
  const starredOnly = getGalleryStarredOnly(galleryValues);
  const recentImages = useMemo(() => getBoundedRecentImages(galleryValues.recentImages), [galleryValues.recentImages]);
  const page = getGalleryPage(galleryValues);
  const knownTotalImages = getGalleryTotalImages(galleryValues);
  const settings = getGallerySettings(galleryValues);
  const queryClient = useQueryClient();
  const semanticQuery = useGallerySemanticImageQuery(galleryValues.semanticImageQuery);
  const data = useGalleryData({
    galleryView,
    page,
    projectBoardId: getGalleryProjectBoardId(galleryValues),
    recentImages,
    searchTerm,
    selectedBoardId: getGalleryRawSelectedBoardId(galleryValues),
    semanticQuery,
    settings,
    // The grid partitions: starred items live in the strip above it.
    starred: starredOnly,
  });

  // Report semantic failures separately so failed searches cannot masquerade as empty results.
  const semanticError = semanticQuery ? data.queryError : null;

  useEffect(() => {
    if (!semanticError) {
      return;
    }

    notifications.reportError({
      area: 'gallery-semantic-search',
      message: semanticError.message,
      namespace: 'gallery',
    });
  }, [notifications, semanticError]);

  const { selectedBoardId, total } = data;
  // No strip under a ranked result (no starred filter applies) or a
  // starred-only listing (it would repeat the grid). Infinite windows use
  // their retained offset because backward loading can return to zero while
  // the persisted deep-reveal anchor remains unchanged.
  const starredStrip = useGalleryStarredStrip({
    enabled: shouldEnableGalleryStarredStrip({
      anchoredWindowPage: getGalleryAnchoredWindowPage(galleryValues),
      infiniteListingOffset: data.listing.offset,
      isInfinite: settings.paginationMode === 'infinite',
      semanticSearchActive: semanticQuery !== null,
      starredOnly,
    }),
    filter: data.filter,
  });
  const gallery = useMemo(
    () => getGalleryStateView(galleryValues, data.boards, data.items, data.isLoadingItems, starredStrip.items),
    [data.boards, data.isLoadingItems, data.items, galleryValues, starredStrip.items]
  );
  const loadedItems = useMemo(
    () => mergeGalleryLoadedItems(starredStrip.items, gallery.items),
    [gallery.items, starredStrip.items]
  );
  const lastPublishedTotalRef = useRef<number | null>(null);
  const itemActionFilterIdentity = useMemo(() => JSON.stringify(data.filter), [data.filter]);
  const getItemSelectionPage = useCallback(
    (item: GalleryItem) => {
      const index = getGalleryGridWindowIndexForItemKey(data.listing.itemsByIndex, toGalleryItemKey(item));

      return index < 0 ? undefined : Math.floor(index / GALLERY_PAGE_SIZE);
    },
    [data.listing.itemsByIndex]
  );
  const getItemSelectionPageAfterRemoval = useCallback(
    (item: GalleryItem, orderedRefs: GalleryItemRef[], removedRefs: GalleryItemRef[]) =>
      getGallerySelectionPageAfterRemoval({
        item,
        orderedRefs,
        removedRefs,
        listingOffset: starredStrip.items.length,
      }),
    [starredStrip.items.length]
  );
  const loadOrderedItemRefs = useCallback(
    async (signal: AbortSignal) => {
      signal.throwIfAborted();
      const result = await queryClient.fetchQuery(galleryItemNamesOptions(data.filter));

      signal.throwIfAborted();
      // Navigation order: the strip's starred items, then the listing.
      return [...starredStrip.items.map(toGalleryItemRef), ...result.items];
    },
    [data.filter, queryClient, starredStrip.items]
  );
  const itemActionContextRef = useRef<GalleryItemActionContext | null>(null);
  const galleryLocationRef = useRef({ galleryView, selectedBoardId });

  // In-flight deletion must read the latest rendered filter and selection without an effect-sized stale window.
  // eslint-disable-next-line react/refs
  itemActionContextRef.current = {
    filterIdentity: itemActionFilterIdentity,
    getItemSelectionPage,
    getItemSelectionPageAfterRemoval,
    items: gallery.items,
    loadOrderedRefs: loadOrderedItemRefs,
    selectedItemKey: gallery.selectedItemKey,
  };
  // Capture upload destination at launch; judge completion visibility against the latest rendered board and view.
  // eslint-disable-next-line react/refs
  galleryLocationRef.current = { galleryView, selectedBoardId };

  const getItemActionContext = useCallback(() => itemActionContextRef.current, []);
  const getCurrentGalleryLocation = useCallback(() => galleryLocationRef.current, []);

  const actions = useGalleryActions({
    boards: data.boards,
    getItemActionContext,
    getCurrentGalleryLocation,
    selectedBoardId,
  });

  // Publish fetched totals for footer pagination. React only to this instance's total; reacting to shared totals
  // can make simultaneous views dispatch indefinitely.
  const publishGalleryTotal = useEffectEvent((nextTotal: number) => {
    const lastPublishedTotal = lastPublishedTotalRef.current;

    lastPublishedTotalRef.current = nextTotal;

    if (shouldPublishGalleryTotal({ knownTotalImages, lastPublishedTotal, total: nextTotal })) {
      galleryCommands.setPageInfo(nextTotal);
    }
  });

  useEffect(() => {
    if (typeof total !== 'number' || !Number.isFinite(total)) {
      return;
    }

    publishGalleryTotal(total);
  }, [total]);

  // Clamp both paginated pages and infinite anchors after shrinkage so stale positions cannot appear as empty
  // boards.
  useEffect(() => {
    if (total === null) {
      return;
    }

    const maxPage = Math.max(0, Math.ceil(total / GALLERY_PAGE_SIZE) - 1);

    if (page > maxPage) {
      galleryCommands.setPage(maxPage);
    }
  }, [galleryCommands, page, total]);

  if (region === 'bottom' && presentation !== 'expanded') {
    // The listing total is unstarred-only; the strip's total is the rest.
    return <GalleryStatusChip count={(total ?? gallery.items.length) + starredStrip.total} />;
  }

  return (
    <ItemActionsProvider
      boards={data.boards}
      generateValues={generateValues}
      getItemActionContext={getItemActionContext}
      projectId={projectId}
    >
      <GalleryWidgetContent
        actions={actions}
        filter={data.filter}
        gallery={gallery}
        listing={gallery.settings.paginationMode === 'infinite' ? data.listing : undefined}
        loadedItems={loadedItems}
        projectName={projectName}
        region={region}
        runtime={runtime}
        starredStrip={starredStrip}
      />
    </ItemActionsProvider>
  );
};

const GalleryWidgetContent = ({
  actions,
  filter,
  gallery,
  listing,
  loadedItems,
  projectName,
  region,
  runtime,
  starredStrip,
}: {
  actions: GalleryActions;
  filter: GalleryItemsFilter;
  gallery: GalleryStateView;
  listing: GalleryWidgetContextValue['listing'];
  loadedItems: GalleryItem[];
  projectName: string;
  region: GalleryWidgetProps['region'];
  runtime: GalleryWidgetRuntime;
  starredStrip: GalleryStarredStrip;
}) => {
  const itemActions = useGalleryItemActions();
  const contextValue = useMemo<GalleryWidgetContextValue>(
    () => ({
      actions,
      filter,
      gallery,
      listing,
      itemActions,
      loadedItems,
      projectName,
      region,
      runtime,
      starredStrip,
    }),
    [actions, filter, gallery, itemActions, listing, loadedItems, projectName, region, runtime, starredStrip]
  );

  return (
    <GalleryWidgetContext value={contextValue}>
      <GalleryBoardDragMonitor />
      <GalleryLayout region={region} />
    </GalleryWidgetContext>
  );
};
