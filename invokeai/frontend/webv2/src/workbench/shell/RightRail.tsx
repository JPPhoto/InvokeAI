/* oxlint-disable react-perf/jsx-no-new-function-as-prop */
import type { RightRailDock, WidgetRegionState } from '@workbench/layoutContracts';
import type { WidgetInstanceId } from '@workbench/widgetContracts';
import type { WidgetRegionDropState } from '@workbench/widgetDnd';
import type { PlacedWidgetRegionItem, WidgetPlacementInstanceMeta } from '@workbench/widgetRegionViewModel';

import { Box, chakra, Flex, HStack, Icon, Text } from '@chakra-ui/react';
import { useDndContext } from '@dnd-kit/core';
import { horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { useMountEffect } from '@platform/react/useMountEffect';
import { IconButton, Tooltip } from '@platform/ui';
import { useFocusRegionProps } from '@workbench/focusRegions';
import { RIGHT_RAIL_DOCKS } from '@workbench/layoutContracts';
import {
  WidgetChromeSlotById,
  WidgetInstanceContextMenu,
  WidgetPanelFrame,
  WidgetStrip,
  type WidgetInstanceContextMenuTarget,
} from '@workbench/widget-frame';
import { useWidgetSortable } from '@workbench/widget-frame/useWidgetSortable';
import { useActiveProjectSelector, useWorkbenchCommands } from '@workbench/WorkbenchContext';
import { clampPanelSize, getPanelSizeBounds } from '@workbench/workbenchState';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import {
  Suspense,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { WidgetPanelSlot } from './Panels';

export type RightRailItem = PlacedWidgetRegionItem<WidgetPlacementInstanceMeta>;

export interface RightRailDockModel {
  activeId: WidgetInstanceId | null;
  dropState: WidgetRegionDropState;
  items: RightRailItem[];
  region: RightRailDock;
  state: WidgetRegionState;
}

/** The tab strip's height; a collapsed dock is exactly this tall, and no dock shrinks below it. */
export const DOCK_STRIP_HEIGHT_PX = 40;
const DOCK_SIZE_STEP_PX = 16;
const TAB_HOVER_PROPS = { bg: 'bg.muted', color: 'fg' };
const HANDLE_HOVER_PROPS = { bg: 'accent.solid', opacity: 0.45 };
const HANDLE_FOCUS_PROPS = { bg: 'accent.solid', opacity: 0.65, outline: '2px solid {colors.accent.solid}' };

interface DockShape {
  items: readonly unknown[];
  region: RightRailDock;
  state?: Pick<WidgetRegionState, 'isCollapsed'>;
}

/**
 * The dock that takes the rail's spare height: the middle one while it shows
 * something, else the last expanded dock; a collapsed dock never takes it.
 */
export const resolveFlexDock = (docks: readonly DockShape[]): RightRailDock | null => {
  const expanded = docks.filter((dock) => dock.items.length > 0 && !dock.state?.isCollapsed);
  return expanded.some((dock) => dock.region === 'right') ? 'right' : (expanded.at(-1)?.region ?? null);
};

/**
 * The right rail's panel: up to three docks stacked top to bottom, each a tab
 * group over one widget region. The panel owns the rail's width; each outer
 * dock owns a preferred height, the flex dock takes what is left, and a dock
 * with nothing placed in it takes no space at all.
 */
export const RightRailPanel = ({
  docks,
  onSelect,
  onRemove,
}: {
  docks: readonly RightRailDockModel[];
  onSelect: (region: RightRailDock, instanceId: WidgetInstanceId) => void;
  onRemove: (region: RightRailDock, item: RightRailItem) => void;
}) => {
  const flexDock = resolveFlexDock(docks);
  const visible = docks.filter((dock) => dock.items.length > 0);
  // A drag previews the size locally; the store hears about it on release.
  const [preview, setPreview] = useState<{ region: RightRailDock; sizePx: number } | null>(null);

  return (
    <WidgetPanelFrame region="right">
      {visible.map((dock, index) => {
        const previous = visible[index - 1];
        // The divider above a dock sizes whichever of the pair is fixed; a pair of fixed docks sizes the lower one.
        const sized = dock.region === flexDock ? previous?.region : dock.region;
        const edge = sized === dock.region ? 'top' : 'bottom';
        return (
          <Flex key={dock.region} direction="column" display="contents">
            {previous && sized && !dock.state.isCollapsed && !previous.state.isCollapsed ? (
              <DockDivider edge={edge} region={sized} onPreview={setPreview} />
            ) : null}
            <RailDock
              dock={dock}
              isFlex={dock.region === flexDock}
              previewSizePx={preview?.region === dock.region ? preview.sizePx : null}
              onRemove={onRemove}
              onSelect={onSelect}
            />
          </Flex>
        );
      })}
    </WidgetPanelFrame>
  );
};

const RailDock = ({
  dock,
  isFlex,
  onRemove,
  onSelect,
  previewSizePx,
}: {
  dock: RightRailDockModel;
  isFlex: boolean;
  onRemove: (region: RightRailDock, item: RightRailItem) => void;
  onSelect: (region: RightRailDock, instanceId: WidgetInstanceId) => void;
  previewSizePx: number | null;
}) => {
  const { t } = useTranslation();
  const { layout } = useWorkbenchCommands();
  const { region, state } = dock;
  const expanded = !state.isCollapsed;
  const dockName = t(`widgets.dock.names.${region}`);
  const active = dock.items.find((item) => item.id === dock.activeId) ?? dock.items[0];
  const focusRegionProps = useFocusRegionProps(region);
  const panelId = `rail-dock-${region}-panel`;
  // Collapsed docks are their strip; the flex dock takes the rest; a fixed dock
  // keeps its preferred height but yields, down to its strip, when the rail is short.
  const sizeProps = !expanded
    ? { flex: '0 0 auto' as const }
    : isFlex
      ? { flex: '1 1 0' as const, minH: `${DOCK_STRIP_HEIGHT_PX}px` }
      : {
          flex: `0 1 ${clampPanelSize(region, previewSizePx ?? state.sizePx)}px`,
          minH: `${DOCK_STRIP_HEIGHT_PX}px`,
        };
  const toggle = useCallback(() => layout.setRegionCollapsed(region, expanded), [expanded, layout, region]);

  return (
    <Flex
      aria-label={t('widgets.panelLabel', { region: dockName })}
      borderColor="border.subtle"
      borderTopWidth={region === 'rightTop' ? '0' : '1px'}
      data-rail-dock={region}
      data-rail-dock-collapsed={expanded ? undefined : ''}
      direction="column"
      overflow="hidden"
      role="group"
      {...focusRegionProps}
      {...sizeProps}
    >
      <DockTabStrip
        active={active}
        dock={dock}
        expanded={expanded}
        panelId={panelId}
        onRemove={onRemove}
        onSelect={onSelect}
        onToggle={toggle}
      />
      {expanded && active ? (
        <Box
          aria-labelledby={`rail-dock-tab-${active.id}`}
          flex="1"
          id={panelId}
          minH="0"
          overflow="hidden"
          role="tabpanel"
        >
          <WidgetPanelSlot instanceId={active.id} region={region} />
        </Box>
      ) : null}
    </Flex>
  );
};

const DockTabStrip = ({
  active,
  dock,
  expanded,
  onRemove,
  onSelect,
  onToggle,
  panelId,
}: {
  active: RightRailItem | undefined;
  dock: RightRailDockModel;
  expanded: boolean;
  onRemove: (region: RightRailDock, item: RightRailItem) => void;
  onSelect: (region: RightRailDock, instanceId: WidgetInstanceId) => void;
  onToggle: () => void;
  panelId: string;
}) => {
  const { t } = useTranslation();
  const { active: activeDrag } = useDndContext();
  const { region } = dock;
  const dockName = t(`widgets.dock.names.${region}`);
  const sortableInstanceIds = useMemo(() => dock.items.map((item) => item.id), [dock.items]);
  const [menuTarget, setMenuTarget] = useState<WidgetInstanceContextMenuTarget | null>(null);
  const remove = useCallback(
    (item: { id: string }) => {
      const railItem = dock.items.find((candidate) => candidate.id === item.id);
      if (railItem) {
        onRemove(region, railItem);
      }
    },
    [dock.items, onRemove, region]
  );
  const isDragging = activeDrag !== null;
  const focusSibling = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      // A keyboard drag owns the arrow keys until it drops.
      if (isDragging) {
        return;
      }
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
    },
    [isDragging]
  );
  const collapseLabel = expanded
    ? t('widgets.dock.collapse', { dock: dockName })
    : t('widgets.dock.expand', { dock: dockName });

  return (
    <WidgetStrip
      align="center"
      direction="row"
      dropState={dock.dropState}
      flexShrink={0}
      gap="0.5"
      h={`${DOCK_STRIP_HEIGHT_PX}px`}
      minW="0"
      px="1.5"
      region={region}
      sortableInstanceIds={sortableInstanceIds}
      strategy={horizontalListSortingStrategy}
      surface="dock"
    >
      <HStack
        aria-label={t('widgets.dock.tabs', { dock: dockName })}
        aria-orientation="horizontal"
        flex="1"
        gap="0.5"
        minW="0"
        overflow="hidden"
        role="tablist"
        onKeyDown={focusSibling}
      >
        {dock.items.map((item) => (
          <DockTab
            key={item.id}
            isActive={item.id === active?.id}
            item={item}
            panelId={panelId}
            region={region}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenuTarget({ item, x: event.clientX, y: event.clientY });
            }}
            onSelect={onSelect}
          />
        ))}
      </HStack>
      {active && expanded ? (
        <Suspense fallback={null}>
          <WidgetChromeSlotById instanceId={active.id} region={region} slot="actions" widget={active.widget} />
        </Suspense>
      ) : null}
      <Tooltip content={collapseLabel}>
        <IconButton
          aria-expanded={expanded}
          aria-label={collapseLabel}
          color="fg.muted"
          size="2xs"
          variant="ghost"
          onClick={onToggle}
        >
          <Icon as={expanded ? ChevronDownIcon : ChevronUpIcon} boxSize="3.5" />
        </IconButton>
      </Tooltip>
      <WidgetInstanceContextMenu target={menuTarget} onClose={() => setMenuTarget(null)} onRemove={remove} />
    </WidgetStrip>
  );
};

const DockTab = ({
  isActive,
  item,
  onContextMenu,
  onSelect,
  panelId,
  region,
}: {
  isActive: boolean;
  item: RightRailItem;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onSelect: (region: RightRailDock, instanceId: WidgetInstanceId) => void;
  panelId: string;
  region: RightRailDock;
}) => {
  const isDisabled = item.status === 'disabled';
  // Space picks the tab up for a keyboard reorder; Enter and clicks select it.
  const { semanticDragHandleProps, setNodeRef, style } = useWidgetSortable({
    disabled: isDisabled,
    instanceId: item.id,
    region,
    surface: 'dock',
    typeId: item.typeId,
  });
  const select = useCallback(() => {
    if (!isDisabled && !isActive) {
      onSelect(region, item.id);
    }
  }, [isActive, isDisabled, item.id, onSelect, region]);

  return (
    <chakra.button
      ref={setNodeRef}
      {...semanticDragHandleProps}
      aria-controls={isActive ? panelId : undefined}
      aria-selected={isActive}
      bg={isActive ? 'bg.emphasized' : 'transparent'}
      color={isActive ? 'fg' : 'fg.muted'}
      cursor={isDisabled ? 'not-allowed' : 'pointer'}
      data-widget-dock-tab={item.id}
      flexShrink={0}
      fontSize="xs"
      fontWeight="600"
      h="7"
      id={`rail-dock-tab-${item.id}`}
      opacity={isDisabled ? 0.4 : 1}
      px="2.5"
      role="tab"
      rounded="md"
      style={style}
      tabIndex={isActive ? 0 : -1}
      title={item.failureMessage ? `${item.label}: ${item.failureMessage}` : item.label}
      type="button"
      _hover={isActive || isDisabled ? undefined : TAB_HOVER_PROPS}
      onClick={select}
      onContextMenu={onContextMenu}
    >
      <Text as="span" truncate>
        {item.label}
      </Text>
    </chakra.button>
  );
};

/**
 * The line between two docks, carrying the handle that sizes the fixed one of
 * the pair: dragging its top edge up or its bottom edge down grows it, the
 * store hears the size on release, an interrupted drag keeps the old size, and
 * dropping below the floor collapses the dock.
 */
const DockDivider = ({
  edge,
  onPreview,
  region,
}: {
  /** Which edge of the sized dock this divider is. */
  edge: 'top' | 'bottom';
  onPreview: (preview: { region: RightRailDock; sizePx: number } | null) => void;
  region: RightRailDock;
}) => {
  const { t } = useTranslation();
  const { layout } = useWorkbenchCommands();
  const sizePx = useActiveProjectSelector((project) => project.widgetRegions[region].sizePx);
  const { max, min } = getPanelSizeBounds(region);
  const session = useRef<AbortController | null>(null);
  const dockName = t(`widgets.dock.names.${region}`);

  useMountEffect(() => () => session.current?.abort());

  const commit = useCallback(
    (next: number) => {
      if (next < min) {
        layout.setRegionCollapsed(region, true);
        return;
      }
      const clamped = clampPanelSize(region, next);
      if (clamped !== sizePx) {
        layout.setRegionSize(region, clamped);
      }
    },
    [layout, min, region, sizePx]
  );
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startY = event.clientY;
      const direction = edge === 'top' ? -1 : 1;
      const controller = new AbortController();
      session.current?.abort();
      session.current = controller;
      let latest = sizePx;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The window listeners carry the drag without capture.
      }
      const move = (moveEvent: PointerEvent) => {
        latest = sizePx + (moveEvent.clientY - startY) * direction;
        onPreview({ region, sizePx: clampPanelSize(region, latest) });
      };
      const finish = (apply: boolean) => () => {
        controller.abort();
        onPreview(null);
        if (apply) {
          commit(latest);
        }
      };
      window.addEventListener('pointermove', move, { signal: controller.signal });
      window.addEventListener('pointerup', finish(true), { signal: controller.signal });
      window.addEventListener('pointercancel', finish(false), { signal: controller.signal });
    },
    [commit, edge, onPreview, region, sizePx]
  );
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? DOCK_SIZE_STEP_PX * 2 : DOCK_SIZE_STEP_PX;
      const grow = edge === 'top' ? 'ArrowUp' : 'ArrowDown';
      const shrink = edge === 'top' ? 'ArrowDown' : 'ArrowUp';
      const change =
        event.key === grow
          ? step
          : event.key === shrink
            ? -step
            : event.key === 'End'
              ? max - sizePx
              : event.key === 'Home'
                ? min - sizePx
                : undefined;
      if (change === undefined) {
        return;
      }
      event.preventDefault();
      commit(change < 0 && sizePx <= min ? min - 1 : sizePx + change);
    },
    [commit, edge, max, min, sizePx]
  );

  return (
    <Box flexShrink={0} h="1px" position="relative" zIndex="1">
      <Box
        aria-label={t('widgets.dock.resize', { dock: dockName })}
        aria-orientation="horizontal"
        aria-valuemax={max}
        aria-valuemin={min}
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
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
      />
    </Box>
  );
};

export { RIGHT_RAIL_DOCKS };
