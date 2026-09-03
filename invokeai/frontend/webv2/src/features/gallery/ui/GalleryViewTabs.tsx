import type { GalleryView } from '@features/gallery/core/types';

import { Text } from '@chakra-ui/react';
import { SegmentTabs } from '@platform/ui';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { getGalleryCountForView } from './galleryBoardLabels';
import { useGalleryWidget } from './GalleryWidgetContext';

const GALLERY_VIEW_TABS = [
  { labelKey: 'common.media', value: 'images' },
  { labelKey: 'common.assets', value: 'assets' },
] satisfies { labelKey: string; value: GalleryView }[];

/**
 * Media / Assets, each carrying the selected board's count for that view so
 * the split is legible before you switch. The same `SegmentTabs` strip the
 * layer panes use; each layout shell wires the tabpanel by putting
 * `segmentTabsPanelId(idBase)` on its grid container.
 */
export const GalleryViewTabs = ({ idBase }: { idBase: string }) => {
  const { t } = useTranslation();
  const { actions, gallery } = useGalleryWidget();
  const selectedBoard = gallery.boards.find((board) => board.id === gallery.selectedBoardId);

  // SegmentTabs re-fires selecting the active tab (its collapsible-toggle
  // affordance); a same-view write would only dirty the widget values.
  const handleViewChange = useCallback(
    (value: GalleryView) => {
      if (value !== gallery.galleryView) {
        actions.setView(value);
      }
    },
    [actions, gallery.galleryView]
  );

  const tabs = useMemo(
    () =>
      GALLERY_VIEW_TABS.map(({ labelKey, value }) => {
        const count = selectedBoard ? getGalleryCountForView(selectedBoard, value) : null;

        return {
          id: value,
          label: (
            <Text as="span" display="flex" gap="1.5">
              {t(labelKey)}
              {count === null ? null : (
                // Dimmed from the tab's own text colour, so it tracks the
                // shown/idle swap; 0.8 stays comfortably legible on both.
                <Text as="span" color="currentColor" fontVariantNumeric="tabular-nums" opacity="0.8">
                  {count}
                </Text>
              )}
            </Text>
          ),
        };
      }),
    [selectedBoard, t]
  );

  return (
    <SegmentTabs
      activeId={gallery.galleryView}
      ariaLabel={t('common.view')}
      idBase={idBase}
      isCompact
      tabs={tabs}
      onSelect={handleViewChange}
    />
  );
};
