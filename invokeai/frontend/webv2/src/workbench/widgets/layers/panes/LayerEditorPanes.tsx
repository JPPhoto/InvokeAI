import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { Box, chakra, Flex, HStack, Icon, Text } from '@chakra-ui/react';
import { useMountEffect } from '@platform/react/useMountEffect';
import { IconButton } from '@platform/ui/Button';
import { Tooltip } from '@platform/ui/Tooltip';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { LayerEditorPaneId, LayerEditorPaneLayout } from './editorPaneLayout';

import {
  clampLayerEditorPaneSize,
  LAYER_EDITOR_PANE_MAX_SIZE_PX,
  LAYER_EDITOR_PANE_MIN_SIZE_PX,
} from './editorPaneLayout';
import { PropertiesPane } from './PropertiesPane';
import { TransformPane } from './TransformPane';

/** The tab strip's height; the collapsed pane block is exactly this tall. */
const STRIP_HEIGHT_PX = 40;
const RESIZE_STEP_PX = 16;
/** Parity with the shell panels: releasing at the floor stops there; collapse asks for a real push past it. */
const COLLAPSE_OVERSHOOT_PX = 80;
const PANEL_ID = 'layer-editor-pane-panel';
const TAB_HOVER_PROPS = { bg: 'bg.muted', color: 'fg' };
const HANDLE_HOVER_PROPS = { bg: 'accent.solid', opacity: 0.45 };
const HANDLE_FOCUS_PROPS = { bg: 'accent.solid', opacity: 0.65, outline: '2px solid {colors.accent.solid}' };

const PANES: ReadonlyArray<{ id: LayerEditorPaneId; labelKey: string }> = [
  { id: 'properties', labelKey: 'widgets.labels.properties' },
  { id: 'transform', labelKey: 'widgets.labels.transform' },
];

/**
 * The Layers widget's editor panes: a fixed block under the tree with one tab
 * per pane — the active tool's Properties and the selected layer's Transform.
 * The panes are part of the panel, not movable widgets; the block keeps a
 * preferred height, collapses to its strip, and persists through the widget's
 * project state.
 */
export const LayerEditorPanes = ({
  layout,
  onLayoutChange,
}: {
  layout: LayerEditorPaneLayout;
  onLayoutChange: (next: LayerEditorPaneLayout) => void;
}) => {
  const { t } = useTranslation();
  const { activePane, isCollapsed, sizePx } = layout;
  // A drag previews the size locally; the store hears about it on release.
  const [previewSizePx, setPreviewSizePx] = useState<number | null>(null);
  const drag = useRef<AbortController | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useMountEffect(() => () => drag.current?.abort());

  const patch = useCallback(
    (next: Partial<LayerEditorPaneLayout>) => onLayoutChange({ ...layout, ...next }),
    [layout, onLayoutChange]
  );
  const toggle = useCallback(() => patch({ isCollapsed: !isCollapsed }), [isCollapsed, patch]);
  const selectPane = useCallback(
    (pane: LayerEditorPaneId) =>
      patch(pane === activePane ? { isCollapsed: !isCollapsed } : { activePane: pane, isCollapsed: false }),
    [activePane, isCollapsed, patch]
  );
  const commitSize = useCallback(
    (next: number) => {
      const clamped = clampLayerEditorPaneSize(next);
      if (clamped !== sizePx) {
        patch({ sizePx: clamped });
      }
    },
    [patch, sizePx]
  );
  const onSeparatorPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startY = event.clientY;
      const controller = new AbortController();
      drag.current?.abort();
      drag.current = controller;
      let latest = sizePx;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The window listeners carry the drag without capture.
      }
      const move = (moveEvent: PointerEvent) => {
        latest = sizePx + (startY - moveEvent.clientY);
        // Past the overshoot the preview snaps to the strip, so the release's collapse is never a surprise.
        setPreviewSizePx(
          latest <= LAYER_EDITOR_PANE_MIN_SIZE_PX - COLLAPSE_OVERSHOOT_PX
            ? STRIP_HEIGHT_PX
            : clampLayerEditorPaneSize(latest)
        );
      };
      const finish = (apply: boolean) => () => {
        controller.abort();
        setPreviewSizePx(null);
        if (!apply) {
          return;
        }
        if (latest <= LAYER_EDITOR_PANE_MIN_SIZE_PX - COLLAPSE_OVERSHOOT_PX) {
          patch({ isCollapsed: true });
          return;
        }
        commitSize(latest);
      };
      window.addEventListener('pointermove', move, { signal: controller.signal });
      window.addEventListener('pointerup', finish(true), { signal: controller.signal });
      window.addEventListener('pointercancel', finish(false), { signal: controller.signal });
    },
    [commitSize, patch, sizePx]
  );
  const onSeparatorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? RESIZE_STEP_PX * 2 : RESIZE_STEP_PX;
      const change =
        event.key === 'ArrowUp'
          ? step
          : event.key === 'ArrowDown'
            ? -step
            : event.key === 'End'
              ? LAYER_EDITOR_PANE_MAX_SIZE_PX - sizePx
              : event.key === 'Home'
                ? LAYER_EDITOR_PANE_MIN_SIZE_PX - sizePx
                : undefined;
      if (change === undefined) {
        return;
      }
      event.preventDefault();
      // A further collapse-ward step at the floor collapses; the separator unmounts, so focus moves to the strip first.
      if (change < 0 && sizePx <= LAYER_EDITOR_PANE_MIN_SIZE_PX) {
        toggleRef.current?.focus();
        patch({ isCollapsed: true });
        return;
      }
      commitSize(sizePx + change);
    },
    [commitSize, patch, sizePx]
  );
  const focusSibling = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    const current = tabs.indexOf(document.activeElement as HTMLElement);
    if (current === -1) {
      return;
    }
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    tabs[next]?.focus();
  }, []);

  const collapseLabel = isCollapsed ? t('widgets.layers.panes.expand') : t('widgets.layers.panes.collapse');

  return (
    <Flex
      borderColor="border.subtle"
      borderTopWidth="1px"
      data-layer-editor-panes={isCollapsed ? 'collapsed' : 'expanded'}
      direction="column"
      flex={isCollapsed ? '0 0 auto' : `0 1 ${previewSizePx ?? sizePx}px`}
      minH={`${STRIP_HEIGHT_PX}px`}
      overflow="hidden"
    >
      {!isCollapsed ? (
        <Box flexShrink={0} h="1px" position="relative" zIndex="1">
          <Box
            aria-label={t('widgets.layers.panes.resize')}
            aria-orientation="horizontal"
            aria-valuemax={LAYER_EDITOR_PANE_MAX_SIZE_PX}
            aria-valuemin={LAYER_EDITOR_PANE_MIN_SIZE_PX}
            aria-valuenow={sizePx}
            cursor="ns-resize"
            h="2"
            left="0"
            opacity="0"
            position="absolute"
            right="0"
            role="separator"
            tabIndex={0}
            top="-4px"
            transition="opacity var(--wb-motion-duration-fast) ease"
            _focusVisible={HANDLE_FOCUS_PROPS}
            _hover={HANDLE_HOVER_PROPS}
            onKeyDown={onSeparatorKeyDown}
            onPointerDown={onSeparatorPointerDown}
          />
        </Box>
      ) : null}
      <HStack align="center" flexShrink={0} gap="0.5" h={`${STRIP_HEIGHT_PX}px`} minW="0" px="1.5">
        <HStack
          aria-label={t('widgets.layers.panes.tabs')}
          aria-orientation="horizontal"
          flex="1"
          gap="0.5"
          minW="0"
          overflow="hidden"
          role="tablist"
          onKeyDown={focusSibling}
        >
          {PANES.map((pane) => (
            <PaneTab
              key={pane.id}
              id={pane.id}
              isExpanded={!isCollapsed}
              isSelected={pane.id === activePane}
              label={t(pane.labelKey)}
              onSelect={selectPane}
            />
          ))}
        </HStack>
        <Tooltip content={collapseLabel}>
          <IconButton
            ref={toggleRef}
            aria-expanded={!isCollapsed}
            aria-label={collapseLabel}
            color="fg.muted"
            size="2xs"
            variant="ghost"
            onClick={toggle}
          >
            <Icon as={isCollapsed ? ChevronUpIcon : ChevronDownIcon} boxSize="3.5" />
          </IconButton>
        </Tooltip>
      </HStack>
      {!isCollapsed ? (
        <Box
          aria-labelledby={`layer-editor-pane-tab-${activePane}`}
          flex="1"
          id={PANEL_ID}
          minH="0"
          overflow="hidden"
          role="tabpanel"
        >
          {activePane === 'transform' ? <TransformPane /> : <PropertiesPane />}
        </Box>
      ) : null}
    </Flex>
  );
};

const PaneTab = ({
  id,
  isExpanded,
  isSelected,
  label,
  onSelect,
}: {
  id: LayerEditorPaneId;
  /** Collapsed keeps the selected tab focusable and selected; only the shown look changes. */
  isExpanded: boolean;
  isSelected: boolean;
  label: string;
  onSelect: (pane: LayerEditorPaneId) => void;
}) => {
  const select = useCallback(() => onSelect(id), [id, onSelect]);
  const isShown = isSelected && isExpanded;

  return (
    <chakra.button
      aria-controls={isShown ? PANEL_ID : undefined}
      aria-selected={isSelected}
      bg={isShown ? 'bg.emphasized' : 'transparent'}
      color={isShown ? 'fg' : 'fg.muted'}
      cursor="pointer"
      flexShrink={0}
      fontSize="xs"
      fontWeight="600"
      h="7"
      id={`layer-editor-pane-tab-${id}`}
      px="2.5"
      role="tab"
      rounded="md"
      tabIndex={isSelected ? 0 : -1}
      type="button"
      _hover={isShown ? undefined : TAB_HOVER_PROPS}
      onClick={select}
    >
      <Text as="span" truncate>
        {label}
      </Text>
    </chakra.button>
  );
};
