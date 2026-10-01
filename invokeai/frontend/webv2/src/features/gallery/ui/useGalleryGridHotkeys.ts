import type { GalleryItem, GalleryItemRef } from '@features/gallery/core/items';
import type { GalleryNavigationDirection, GalleryNavigationEntry } from '@features/gallery/core/selection';

import { shouldStarSelection, toGalleryItemKey, toGalleryItemRef } from '@features/gallery/core/items';
import { getGalleryNavigationStep } from '@features/gallery/core/selection';
import { GALLERY_PAGE_SIZE } from '@features/gallery/data/queries';
import { captureAccountScope, isAccountScopeCurrent, type AccountScope } from '@platform/state/accountLifecycle';
import { useCallback, useEffect, useEffectEvent, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { getGalleryGridWindowIndexForItemKey } from './galleryGridLayout';
import { useGalleryUi } from './GalleryUiContext';
import { useGalleryWidget } from './GalleryWidgetContext';

const GALLERY_HOTKEYS = [
  ['gallery.selectAllOnPage', 'widgets.gallery.commands.selectAllOnPage', null, ['mod+a']],
  ['gallery.clearSelection', 'widgets.gallery.commands.clearSelection', null, ['esc']],
  ['gallery.galleryNavUp', 'widgets.gallery.commands.navigationUp', 'up', ['arrowup']],
  ['gallery.galleryNavRight', 'widgets.gallery.commands.navigationRight', 'right', ['arrowright']],
  ['gallery.galleryNavDown', 'widgets.gallery.commands.navigationDown', 'down', ['arrowdown']],
  ['gallery.galleryNavLeft', 'widgets.gallery.commands.navigationLeft', 'left', ['arrowleft']],
  ['gallery.galleryNavUpAlt', 'widgets.gallery.commands.navigationUp', 'up', ['alt+arrowup']],
  ['gallery.galleryNavRightAlt', 'widgets.gallery.commands.navigationRight', 'right', ['alt+arrowright']],
  ['gallery.galleryNavDownAlt', 'widgets.gallery.commands.navigationDown', 'down', ['alt+arrowdown']],
  ['gallery.galleryNavLeftAlt', 'widgets.gallery.commands.navigationLeft', 'left', ['alt+arrowleft']],
  ['gallery.deleteSelection', 'widgets.gallery.commands.deleteSelection', null, ['delete', 'backspace']],
  ['gallery.starImage', 'widgets.gallery.commands.toggleStarImage', null, ['.']],
  ['gallery.toggleStarredOnly', 'widgets.gallery.commands.toggleStarredOnly', null, []],
] as const satisfies readonly (readonly [string, string, GalleryNavigationDirection | null, readonly string[]])[];

/**
 * Read current handler state without re-registering commands on selection changes, avoiding palette and hotkey
 * churn.
 */
export const useGalleryGridHotkeys = ({
  actionSelectionRefs,
  columnCount,
  cursorKey,
  loadedItems,
  navigationSections,
  scrollToAbsoluteIndex,
  scrollToEntry,
}: {
  actionSelectionRefs: GalleryItemRef[];
  columnCount: number;
  /** Where the arrow keys step from: the followed session, else the selected item. */
  cursorKey: string | null;
  /** Everything on hand for star-state lookups, strip included. */
  loadedItems: readonly GalleryItem[];
  /** The arrow-key sections in visual order: the starred strip, in progress, the listing. */
  navigationSections: readonly (readonly GalleryNavigationEntry[])[];
  scrollToAbsoluteIndex: (index: number) => void;
  scrollToEntry: (entry: GalleryNavigationEntry) => void;
}) => {
  const { t } = useTranslation();
  const { actions, filter, gallery, itemActions, listing, runtime } = useGalleryWidget();
  const { followProgressSession, gallery: galleryCommands, projectId } = useGalleryUi();
  const backendIndexByItemKey = listing?.backendIndexByItemKey;
  const getBackendIndexAtDisplayIndex = listing?.getBackendIndexAtDisplayIndex;
  const leadingOverlayCount = listing?.leadingOverlayCount;
  const cursorPositionRef = useRef<{
    accountScope: AccountScope;
    filterIdentity: string;
    index: number;
    key: string;
    projectId: string;
    total: number | null;
  } | null>(null);
  const pendingNavigationRef = useRef<{
    accountScope: AccountScope;
    cursorKey: string | null;
    filterIdentity: string;
    backendIndex: number;
    projectId: string;
  } | null>(null);
  const filterIdentity = JSON.stringify(filter);

  const onListingItemMounted = useCallback(
    (item: GalleryItem, index: number) => {
      const itemKey = toGalleryItemKey(item);

      if (itemKey === cursorKey) {
        cursorPositionRef.current = {
          accountScope: captureAccountScope(),
          filterIdentity,
          index,
          key: itemKey,
          projectId,
          total: listing?.total ?? null,
        };
      }

      const pending = pendingNavigationRef.current;

      if (!pending) {
        return;
      }

      if (
        pending.cursorKey !== cursorKey ||
        pending.filterIdentity !== filterIdentity ||
        pending.projectId !== projectId ||
        !isAccountScopeCurrent(pending.accountScope)
      ) {
        pendingNavigationRef.current = null;
        return;
      }

      const backendIndex = backendIndexByItemKey
        ? backendIndexByItemKey.get(itemKey)
        : (getBackendIndexAtDisplayIndex?.(index) ?? index - (leadingOverlayCount ?? 0));

      if (backendIndex !== undefined && pending.backendIndex === backendIndex) {
        pendingNavigationRef.current = null;
        actions.selectItem(item);
        scrollToEntry({ item, kind: 'item' });
      }
    },
    [
      actions,
      cursorKey,
      filterIdentity,
      backendIndexByItemKey,
      getBackendIndexAtDisplayIndex,
      leadingOverlayCount,
      listing?.total,
      projectId,
      scrollToEntry,
    ]
  );

  const navigate = useEffectEvent((direction: GalleryNavigationDirection) => {
    pendingNavigationRef.current = null;
    const cursorExistsInSections = navigationSections.some((section) =>
      section.some((entry) =>
        entry.kind === 'item' ? toGalleryItemKey(entry.item) === cursorKey : `session:${entry.id}` === cursorKey
      )
    );
    const entry =
      cursorKey !== null && !cursorExistsInSections
        ? null
        : getGalleryNavigationStep(navigationSections, cursorKey, direction, columnCount);

    if (listing && cursorKey !== null) {
      const indexedCurrentItem = getGalleryGridWindowIndexForItemKey(listing.itemsByIndex, cursorKey);
      const cursorPosition = cursorPositionRef.current;
      const hasCurrentListingPosition =
        cursorPosition?.key === cursorKey &&
        isAccountScopeCurrent(cursorPosition.accountScope) &&
        cursorPosition.filterIdentity === filterIdentity &&
        cursorPosition.projectId === projectId &&
        cursorPosition.total === listing.total;
      const currentIndex =
        indexedCurrentItem >= 0 ? indexedCurrentItem : hasCurrentListingPosition ? cursorPosition.index : -1;
      const isCursorInListing =
        indexedCurrentItem >= 0 ||
        hasCurrentListingPosition ||
        (navigationSections
          .at(-1)
          ?.some((sectionEntry) => sectionEntry.kind === 'item' && toGalleryItemKey(sectionEntry.item) === cursorKey) ??
          false);
      const delta =
        direction === 'left' ? -1 : direction === 'right' ? 1 : direction === 'up' ? -columnCount : columnCount;
      if (isCursorInListing && currentIndex >= 0) {
        const targetIndex = currentIndex + delta;

        if (targetIndex >= 0 && (listing.total === null || targetIndex < listing.total)) {
          const targetItem = listing.itemsByIndex.get(targetIndex);

          if (targetItem) {
            actions.selectItem(targetItem);
            scrollToEntry({ item: targetItem, kind: 'item' });
          } else {
            let hasLoadedBeforeTarget = false;
            let hasLoadedAfterTarget = false;
            let nearestLoadedItem: { index: number; item: GalleryItem } | undefined;

            for (const [index, item] of listing.itemsByIndex) {
              if (index < targetIndex) {
                hasLoadedBeforeTarget = true;
                if (delta < 0 && (nearestLoadedItem === undefined || index > nearestLoadedItem.index)) {
                  nearestLoadedItem = { index, item };
                }
              } else if (index > targetIndex) {
                hasLoadedAfterTarget = true;

                if (delta > 0 && (nearestLoadedItem === undefined || index < nearestLoadedItem.index)) {
                  nearestLoadedItem = { index, item };
                }
              }
            }

            if (hasLoadedBeforeTarget && hasLoadedAfterTarget && nearestLoadedItem) {
              actions.selectItem(nearestLoadedItem.item);
              scrollToEntry({ item: nearestLoadedItem.item, kind: 'item' });
            } else {
              // A short final page can leave its last absolute slot empty after a deletion. Asking
              // for that slot is a no-op while the containing page is retained, so step to the
              // next page boundary when the gap is exactly at the end of this page.
              const leadingOverlayCount = listing.leadingOverlayCount ?? 0;
              const backendTargetIndex =
                listing.getBackendIndexAtDisplayIndex?.(targetIndex) ?? targetIndex - leadingOverlayCount;
              const isTerminalPageSlot = backendTargetIndex >= 0 && (backendTargetIndex + 1) % GALLERY_PAGE_SIZE === 0;
              const nextBackendPageIndex = backendTargetIndex + 1;
              const shouldRequestNextPage =
                delta > 0 &&
                isTerminalPageSlot &&
                (listing.backendTotal === null ||
                  listing.backendTotal === undefined ||
                  nextBackendPageIndex < listing.backendTotal);
              const requestIndex = shouldRequestNextPage
                ? (listing.getDisplayIndexForBackendIndex?.(nextBackendPageIndex) ??
                  nextBackendPageIndex + leadingOverlayCount)
                : targetIndex;
              pendingNavigationRef.current = {
                accountScope: captureAccountScope(),
                backendIndex: shouldRequestNextPage
                  ? nextBackendPageIndex
                  : (listing.getBackendIndexAtDisplayIndex?.(requestIndex) ?? requestIndex - leadingOverlayCount),
                cursorKey,
                filterIdentity,
                projectId,
              };
              listing.loadRange(requestIndex, requestIndex);
              scrollToAbsoluteIndex(requestIndex);
            }
          }
          return;
        }
      }
    }

    if (!entry) {
      return;
    }

    if (entry.kind === 'session') {
      followProgressSession(entry.id, { revealPreview: false });
    } else {
      actions.selectItem(entry.item);
    }

    scrollToEntry(entry);
  });

  const executeGalleryHotkey = useEffectEvent((commandId: string) => {
    if (commandId === 'gallery.selectAllOnPage') {
      const primaryItem = gallery.items[0];

      if (primaryItem) {
        actions.selectItemRange(gallery.items.map(toGalleryItemRef), primaryItem);
      }
      return;
    }

    if (commandId === 'gallery.clearSelection') {
      galleryCommands.clearSelection();
      return;
    }

    if (commandId === 'gallery.deleteSelection' && actionSelectionRefs.length > 0) {
      void itemActions.deleteItems(actionSelectionRefs);
      return;
    }

    if (commandId === 'gallery.starImage' && actionSelectionRefs.length > 0) {
      void itemActions.setItemsStarred(actionSelectionRefs, shouldStarSelection(loadedItems, actionSelectionRefs));
      return;
    }

    if (commandId === 'gallery.toggleStarredOnly' && gallery.semanticImageQuery === null) {
      actions.setStarredOnly(!gallery.starredOnly);
    }
  });

  useEffect(() => {
    const disposers = GALLERY_HOTKEYS.flatMap(([id, titleKey, direction, defaultKeys]) => [
      runtime.commands.register({
        handler: () => (direction ? navigate(direction) : executeGalleryHotkey(id)),
        id,
        title: t(titleKey),
      }),
      runtime.hotkeys.register({
        commandId: id,
        defaultKeys: [...defaultKeys],
        id,
        title: t(titleKey),
      }),
    ]);

    return () => {
      disposers.forEach((dispose) => dispose());
    };
  }, [runtime.commands, runtime.hotkeys, t]);

  return onListingItemMounted;
};
