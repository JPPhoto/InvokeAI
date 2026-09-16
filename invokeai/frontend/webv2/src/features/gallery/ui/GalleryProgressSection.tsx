import type { QueueProgressSession } from '@features/queue/contracts';

import { Box, chakra, Icon, Skeleton, Text } from '@chakra-ui/react';
import { getDeterminateProgressPercent } from '@features/queue/contracts';
import { useItemProgress, useQueueItemProgressImage } from '@features/queue/react';
import { StreamingImageFrame } from '@platform/ui/streaming-image/StreamingImageFrame';
import { progressImageToStreamingSource } from '@platform/ui/streaming-image/streamingImageSource';
import { ChevronRightIcon, HourglassIcon } from 'lucide-react';
import { useCallback, useId, useRef } from 'react';
import { useVirtualizer } from 'react-hook-tanstack-virtual';
import { useTranslation } from 'react-i18next';

import { GALLERY_GRID_GAP_PX, GALLERY_STARRED_HEADER_HEIGHT_PX } from './galleryGridLayout';
import { useGalleryUi } from './GalleryUiContext';
import { useGalleryWidget } from './GalleryWidgetContext';

export const GalleryProgressSection = ({
  columns,
  tileSize,
  getScrollElement,
}: {
  columns: number;
  tileSize: number;
  getScrollElement(): HTMLDivElement | null;
}) => {
  const { t } = useTranslation();
  const { progressSessions, pinnedProgressSessionId, liveFollowEnabled, followProgressSession } = useGalleryUi();
  const { actions, gallery } = useGalleryWidget();
  const { progressSectionCollapsed, showPendingItems } = gallery.settings;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentId = useId();
  const restoreFocus = useCallback(() => {
    const root = rootRef.current;
    (root?.querySelector<HTMLButtonElement>('[data-progress-disclosure]') ?? root)?.focus({ preventScroll: true });
  }, []);
  const disclosureRef = useCallback(
    (element: HTMLButtonElement | null) => {
      if (!element) {
        return;
      }
      return () => {
        if (document.activeElement === element) {
          queueMicrotask(restoreFocus);
        }
      };
    },
    [restoreFocus]
  );
  const toggleCollapsed = useCallback(
    () => actions.updateSettings({ progressSectionCollapsed: !progressSectionCollapsed }),
    [actions, progressSectionCollapsed]
  );
  const visible = showPendingItems && progressSessions.length > 0;

  return (
    <Box ref={rootRef} aria-label={t('widgets.gallery.inProgress')} flexShrink={0} minW="0" role="region" tabIndex={-1}>
      {visible ? (
        <>
          <chakra.button
            ref={disclosureRef}
            display="flex"
            alignItems="center"
            aria-controls={contentId}
            aria-expanded={!progressSectionCollapsed}
            type="button"
            focusVisibleRing="inside"
            data-progress-disclosure
            gap="1"
            h={`${GALLERY_STARRED_HEADER_HEIGHT_PX}px`}
            py="0"
            px="1"
            textAlign="start"
            title={t('widgets.gallery.progressShared')}
            w="full"
            onClick={toggleCollapsed}
          >
            <Icon
              as={ChevronRightIcon}
              boxSize="3"
              transform={progressSectionCollapsed ? undefined : 'rotate(90deg)'}
            />
            <Icon as={HourglassIcon} boxSize="3" />
            <Text fontSize="2xs" fontWeight="600" letterSpacing="wide" lineHeight="1" textTransform="uppercase">
              {t('widgets.gallery.inProgress')}
            </Text>
            <Text color="fg.muted" fontSize="xs" fontVariantNumeric="tabular-nums">
              · {progressSessions.length}
            </Text>
          </chakra.button>
          <Box id={contentId} hidden={progressSectionCollapsed}>
            {!progressSectionCollapsed ? (
              <GalleryProgressGrid
                key={`${columns}:${tileSize}`}
                sessions={progressSessions}
                size={tileSize}
                columns={columns}
                getScrollElement={getScrollElement}
                pinnedSessionId={pinnedProgressSessionId}
                liveFollowEnabled={liveFollowEnabled}
                onFollow={followProgressSession}
                restoreFocus={restoreFocus}
              />
            ) : null}
          </Box>
        </>
      ) : null}
    </Box>
  );
};

const GalleryProgressGrid = ({
  sessions,
  size,
  columns,
  getScrollElement,
  pinnedSessionId,
  liveFollowEnabled,
  onFollow,
  restoreFocus,
}: {
  sessions: QueueProgressSession[];
  size: number;
  columns: number;
  getScrollElement(): HTMLDivElement | null;
  pinnedSessionId: string | null;
  liveFollowEnabled: boolean;
  onFollow(id: string): void;
  restoreFocus(): void;
}) => {
  const rowHeight = size + GALLERY_GRID_GAP_PX;
  const rowCount = Math.ceil(sessions.length / columns);
  const estimateSize = useCallback(() => rowHeight, [rowHeight]);
  const getItemKey = useCallback((index: number) => sessions[index * columns]!.id, [sessions, columns]);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement,
    estimateSize,
    getItemKey,
    scrollMargin: GALLERY_STARRED_HEADER_HEIGHT_PX,
    overscan: 2,
  });
  return (
    <Box minW="0" pb="2">
      <Box position="relative" h={`${virtualizer.totalSize}px`} w="full">
        {virtualizer.virtualItems.map((row) => (
          <Box
            key={row.key}
            position="absolute"
            top={`${row.start - GALLERY_STARRED_HEADER_HEIGHT_PX}px`}
            left="0"
            display="grid"
            gridTemplateColumns={`repeat(${columns}, minmax(0, 1fr))`}
            gap={`${GALLERY_GRID_GAP_PX}px`}
            w="full"
          >
            {sessions.slice(row.index * columns, (row.index + 1) * columns).map((session) => (
              <GalleryProgressTile
                key={session.id}
                session={session}
                size={size}
                selected={liveFollowEnabled && (pinnedSessionId === null || pinnedSessionId === session.id)}
                onFollow={onFollow}
                restoreFocus={restoreFocus}
              />
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  );
};

const GalleryProgressTile = ({
  session,
  size,
  selected,
  onFollow,
  restoreFocus,
}: {
  session: QueueProgressSession;
  size: number;
  selected: boolean;
  onFollow(id: string): void;
  restoreFocus(): void;
}) => {
  const { t } = useTranslation();
  const { antialiasProgressImages } = useGalleryUi();
  const image = useQueueItemProgressImage(session.queueItemId, session.itemIndex);
  const progress = useItemProgress(session.backendItemId);
  const percentage = getDeterminateProgressPercent(progress?.percentage);
  const label =
    session.itemCount > 1
      ? t('widgets.gallery.progressSession', {
          name: session.label,
          index: session.itemIndex,
          total: session.itemCount,
        })
      : session.label;
  const status =
    session.state === 'queued'
      ? t('widgets.gallery.progressQueued')
      : session.state === 'settling'
        ? t('widgets.gallery.progressSettling')
        : percentage !== null
          ? `${percentage}%`
          : progress?.message || t('widgets.gallery.progressPreparing');
  const follow = useCallback(() => onFollow(session.id), [onFollow, session.id]);
  const buttonRef = useCallback(
    (element: HTMLButtonElement | null) => {
      if (!element) {
        return;
      }
      return () => {
        if (document.activeElement === element) {
          queueMicrotask(restoreFocus);
        }
      };
    },
    [restoreFocus]
  );

  return (
    <chakra.button
      ref={buttonRef}
      type="button"
      focusVisibleRing="inside"
      aria-label={`${label} · ${status}`}
      aria-pressed={selected && session.state !== 'queued'}
      disabled={session.state === 'queued'}
      borderColor={selected && session.state !== 'queued' ? 'accent.solid' : 'border.subtle'}
      borderWidth="1px"
      flexShrink={0}
      minW="0"
      overflow="hidden"
      rounded="md"
      textAlign="start"
      title={label}
      w={`${size}px`}
      onClick={follow}
    >
      <StreamingImageFrame
        aspectRatio={1}
        fit="contain"
        liveImage={progressImageToStreamingSource(image)}
        shouldAntialiasLiveImage={antialiasProgressImages}
        w="full"
      >
        <Skeleton h="full" w="full" />
      </StreamingImageFrame>
    </chakra.button>
  );
};
