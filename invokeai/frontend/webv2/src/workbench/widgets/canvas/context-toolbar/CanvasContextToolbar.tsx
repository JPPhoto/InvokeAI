import type { Project } from '@workbench/projectContracts';
import type { ComponentType, FocusEvent, ReactNode, RefObject } from 'react';

import { Box, Flex, Icon, Text, VisuallyHidden } from '@chakra-ui/react';
import { Button, Tooltip } from '@platform/ui';
import { collectSubtreeLeaves, getDocumentNode } from '@workbench/canvas-engine/api';
import { useCanvasProjectMutationDispatch } from '@workbench/useCanvasProjectMutationDispatch';
import { useCanvasActiveTool, useCanvasOperation } from '@workbench/widgets/canvas/engineStoreHooks';
import { clearLayerPropertiesRequest } from '@workbench/widgets/layers/layerPropertiesRequestStore';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CanvasToolOptionsEngine, ToolbarRegionComponent, ToolbarStatusProps } from './toolbarContracts';

import { hasToolRegions, OPERATION_PRESENTATION_ADAPTERS, TOOL_PRESENTATION_ADAPTERS } from './toolAdapters';
import {
  resolveToolbarLayout,
  TOOLBAR_GAP_PX,
  TOOLBAR_HEIGHT_PX,
  TOOLBAR_REGION_ORDER,
  TOOLBAR_REGION_WIDTH_PX,
  type ToolbarLayout,
  type ToolbarRegionId,
  type ToolbarRegionPlacement,
} from './toolbarLayout';
import { ToolbarMoreMenu, ToolbarMoreSection } from './ToolbarMoreMenu';
import { ToolbarHint, ToolbarStatus } from './ToolbarPrimitives';

/** Horizontal inset of the bar's content; the identity region's left edge sits here at every width. */
export const TOOLBAR_INSET_PX = 8;

const REGION_LABEL_KEYS: Record<ToolbarRegionId | 'status', string> = {
  color: 'widgets.canvas.toolbar.regions.color',
  geometry: 'widgets.canvas.toolbar.regions.geometry',
  intensity: 'widgets.canvas.toolbar.regions.intensity',
  modes: 'widgets.canvas.toolbar.regions.modes',
  status: 'widgets.canvas.toolbar.regions.status',
};

/** Content width of the bar; a hidden bar (a kept-alive widget) reports unbounded so its regions stay mounted. */
const useMeasuredWidth = (ref: RefObject<HTMLElement | null>): number => {
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      setWidth(next > 0 ? next - 2 * TOOLBAR_INSET_PX : Number.POSITIVE_INFINITY);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
};

const GAP = `${TOOLBAR_GAP_PX}px`;

/**
 * One region's box. Regions space themselves with a start margin rather than a
 * container gap, so a region with nothing to show (`display: none`) costs the
 * bar neither width nor a gap, exactly as `resolveToolbarLayout` charges it.
 */
const RegionSlot = ({
  children,
  disabled = false,
  empty = false,
  id,
  label,
  placement,
  vacant = false,
  width,
}: {
  children: ReactNode;
  disabled?: boolean;
  /** Nothing to show: the slot collapses and costs no gap. */
  empty?: boolean;
  id: ToolbarRegionId | 'status';
  label: string;
  placement: ToolbarRegionPlacement;
  /** Reserved for alignment but holding no control for this tool: no group semantics. */
  vacant?: boolean;
  width?: number;
}) => (
  <Flex
    align="center"
    aria-label={vacant ? undefined : label}
    data-placement={placement}
    data-region={id}
    display={placement !== 'menu' && !empty ? 'flex' : 'none'}
    flexShrink={width === undefined ? 1 : 0}
    gap={GAP}
    h="full"
    inert={disabled || undefined}
    minW="0"
    ms={GAP}
    opacity={disabled ? 0.5 : 1}
    overflow="hidden"
    role={vacant ? undefined : 'group'}
    w={width === undefined ? 'auto' : `${width}px`}
  >
    {/* Keyed on the lock so a popover opened from the region closes with it: portalled content ignores `inert`. */}
    {placement === 'menu' ? null : <Fragment key={String(disabled)}>{children}</Fragment>}
  </Flex>
);

const regionSlotWidth = (region: ToolbarRegionId, placement: ToolbarRegionPlacement): number | undefined =>
  region === 'modes'
    ? undefined
    : region === 'geometry' && placement === 'compact'
      ? TOOLBAR_REGION_WIDTH_PX.geometryCompact
      : TOOLBAR_REGION_WIDTH_PX[region];

interface SelectedGroup {
  firstLeafId: string | null;
  id: string;
}

const selectSelectedGroup = (project: Project): SelectedGroup | null => {
  const { document } = project.canvas;
  const node = getDocumentNode(document, document.selectedLayerId);
  return node?.type === 'group' ? { firstLeafId: collectSubtreeLeaves(node)[0]?.id ?? null, id: node.id } : null;
};

const sameSelectedGroup = (a: SelectedGroup | null, b: SelectedGroup | null): boolean =>
  a?.id === b?.id && a?.firstLeafId === b?.firstLeafId;

/** Leaf tools cannot paint into a group: name the way out instead of silently refusing strokes. */
const GroupSelectedNotice = ({ group }: { group: SelectedGroup }) => {
  const { t } = useTranslation();
  const dispatch = useCanvasProjectMutationDispatch();
  const selectFirstLeaf = useCallback(() => {
    if (group.firstLeafId) {
      dispatch({ id: group.firstLeafId, type: 'setCanvasSelectedLayer' });
    }
  }, [dispatch, group.firstLeafId]);
  return (
    <>
      <ToolbarHint>{t('widgets.layers.groupSelectedHint')}</ToolbarHint>
      {group.firstLeafId ? (
        <Button flexShrink={0} size="2xs" variant="subtle" onClick={selectFirstLeaf}>
          {t('widgets.layers.actions.selectFirstChild')}
        </Button>
      ) : null}
    </>
  );
};

const IdleStatus = ({ compact }: ToolbarStatusProps) => <ToolbarStatus compact={compact} />;

const IDLE_LAYOUT_INPUT = { modesWidth: null, primary: null, reservesToolRegions: true } as const;

const ConnectedToolbar = ({
  engine,
  isSurfaceInteractionLocked,
  width,
}: {
  engine: CanvasToolOptionsEngine;
  isSurfaceInteractionLocked: boolean;
  width: number;
}) => {
  const { t } = useTranslation();
  const activeTool = useCanvasActiveTool(engine);
  const operation = useCanvasOperation(engine);
  const operationKind = operation.status === 'active' ? operation.identity.kind : null;
  const tool = TOOL_PRESENTATION_ADAPTERS[activeTool];
  const running = operationKind ? OPERATION_PRESENTATION_ADAPTERS[operationKind] : null;

  // An operation bar used to consume any pending layer-properties request; the toolbar keeps that contract.
  useEffect(() => {
    if (operationKind) {
      clearLayerPropertiesRequest();
    }
  }, [operationKind]);

  const selectedGroup = useActiveProjectSelector(selectSelectedGroup, sameSelectedGroup);
  const modes = running ? running.modes : tool.modes;
  const More = running ? running.more : tool.more;
  const Status = running?.status ?? tool.status ?? IdleStatus;
  const reservesToolRegions = hasToolRegions(tool);
  const hintOnly = !running && !reservesToolRegions;
  const notice = !running && tool.paintsLeaf ? selectedGroup : null;
  const hasModesContent = !!modes || hintOnly || notice !== null;
  const layout: ToolbarLayout = resolveToolbarLayout({
    modesWidth: hasModesContent ? (modes?.width ?? 0) : null,
    primary: running ? (running.modes ? 'modes' : null) : tool.primary,
    reservesToolRegions,
    width,
  });
  const contentKey = running ? `${activeTool}:${running.kind}` : activeTool;
  const toolRegions: Record<Exclude<ToolbarRegionId, 'modes'>, ToolbarRegionComponent | undefined> = {
    color: tool.color,
    geometry: tool.geometry,
    intensity: tool.intensity,
  };
  const renderRegion = (region: ToolbarRegionId, placement: ToolbarRegionPlacement): ReactNode => {
    if (region === 'modes') {
      const Modes = modes?.component;
      return (
        <>
          {notice ? <GroupSelectedNotice group={notice} /> : null}
          {Modes ? (
            <Modes
              key={contentKey}
              engine={engine}
              isSurfaceInteractionLocked={isSurfaceInteractionLocked}
              placement={placement}
            />
          ) : hintOnly ? (
            <ToolbarHint>{t(`widgets.canvas.toolHints.${tool.id}`)}</ToolbarHint>
          ) : null}
        </>
      );
    }
    const Region = toolRegions[region];
    return Region ? (
      <Region
        key={activeTool}
        engine={engine}
        isSurfaceInteractionLocked={isSurfaceInteractionLocked}
        placement={placement}
      />
    ) : null;
  };

  // While an operation runs the tool's regions are inert, so none of them belongs in the menu either.
  const displaced = TOOLBAR_REGION_ORDER.filter(
    (region) => layout.regions[region] === 'menu' && (region === 'modes' ? modes : !running && toolRegions[region])
  );

  // `inert` blurs a focused tool control when an operation starts; hand focus to the operation's Cancel instead.
  const blurredByInert = useRef<HTMLElement | null>(null);
  const onBlurCapture = useCallback((event: FocusEvent<HTMLElement>) => {
    blurredByInert.current =
      event.relatedTarget === null && event.target.closest('[inert]') !== null
        ? event.target.closest<HTMLElement>('[data-canvas-context-toolbar]')
        : null;
  }, []);
  useLayoutEffect(() => {
    const root = blurredByInert.current;
    blurredByInert.current = null;
    if (running && root) {
      root.querySelector<HTMLElement>('[data-toolbar-action="cancel"]')?.focus();
    }
  }, [running]);

  return (
    <Flex align="center" display="contents" onBlurCapture={onBlurCapture}>
      <Identity compact={layout.identity === 'compact'} icon={tool.icon} name={t(`widgets.canvas.tools.${tool.id}`)} />
      {TOOLBAR_REGION_ORDER.map((region) => (
        <RegionSlot
          key={region}
          disabled={isSurfaceInteractionLocked || (running !== null && region !== 'modes')}
          empty={region === 'modes' ? !hasModesContent : !reservesToolRegions}
          id={region}
          label={t(REGION_LABEL_KEYS[region])}
          placement={layout.regions[region]}
          vacant={region !== 'modes' && !toolRegions[region]}
          width={regionSlotWidth(region, layout.regions[region])}
        >
          {renderRegion(region, layout.regions[region])}
        </RegionSlot>
      ))}
      <ToolbarMoreMenu disabled={isSurfaceInteractionLocked} empty={displaced.length === 0 && !More}>
        {displaced.map((region) => (
          <ToolbarMoreSection key={region} label={t(REGION_LABEL_KEYS[region])}>
            {renderRegion(region, 'menu')}
          </ToolbarMoreSection>
        ))}
        {More ? (
          <ToolbarMoreSection label={t('widgets.canvas.toolbar.regions.more')}>
            <More
              key={contentKey}
              engine={engine}
              isSurfaceInteractionLocked={isSurfaceInteractionLocked}
              placement="menu"
            />
          </ToolbarMoreSection>
        ) : null}
      </ToolbarMoreMenu>
      <Box flex="1" minW="0" />
      <RegionSlot
        id="status"
        label={t(REGION_LABEL_KEYS.status)}
        placement="bar"
        width={layout.status === 'full' ? TOOLBAR_REGION_WIDTH_PX.status : TOOLBAR_REGION_WIDTH_PX.statusCompact}
      >
        <Status
          key={contentKey}
          compact={layout.status === 'compact'}
          engine={engine}
          isExternalInteractionLocked={isSurfaceInteractionLocked}
        />
      </RegionSlot>
    </Flex>
  );
};

const Identity = ({ compact, icon, name }: { compact: boolean; icon?: ComponentType; name: string }) => {
  const content = (
    <Flex
      align="center"
      data-region="identity"
      flexShrink={0}
      gap="2"
      h="full"
      overflow="hidden"
      w={`${compact ? TOOLBAR_REGION_WIDTH_PX.identityCompact : TOOLBAR_REGION_WIDTH_PX.identity}px`}
    >
      {icon ? <Icon as={icon} boxSize="4" color="fg.muted" flexShrink={0} /> : null}
      {compact ? (
        <VisuallyHidden>{name}</VisuallyHidden>
      ) : (
        <Text fontSize="xs" fontWeight="medium" minW="0" truncate>
          {name}
        </Text>
      )}
    </Flex>
  );
  return compact ? <Tooltip content={name}>{content}</Tooltip> : content;
};

const EmptyToolbar = ({ width }: { width: number }) => {
  const { t } = useTranslation();
  const layout = resolveToolbarLayout({ ...IDLE_LAYOUT_INPUT, width });
  return (
    <>
      <Identity compact={layout.identity === 'compact'} name="" />
      {TOOLBAR_REGION_ORDER.map((region) => (
        <RegionSlot
          key={region}
          empty
          id={region}
          label={t(REGION_LABEL_KEYS[region])}
          placement={layout.regions[region]}
          width={regionSlotWidth(region, layout.regions[region])}
        >
          {null}
        </RegionSlot>
      ))}
      <ToolbarMoreMenu empty />
      <Box flex="1" minW="0" />
      <RegionSlot
        id="status"
        label={t(REGION_LABEL_KEYS.status)}
        placement="bar"
        width={layout.status === 'full' ? TOOLBAR_REGION_WIDTH_PX.status : TOOLBAR_REGION_WIDTH_PX.statusCompact}
      >
        <ToolbarStatus compact={layout.status === 'compact'} />
      </RegionSlot>
    </>
  );
};

/**
 * The canvas context toolbar: one fixed-height row at the top of the canvas
 * widget with seven regions in a stable order — identity, geometry,
 * intensity, color, modes (with the More menu at its right edge), a spacer,
 * and status. The shell never unmounts for a tool or an operation; each region
 * keeps its width and position, and only its content changes. Regions that do
 * not fit the measured width move into the More menu in a fixed priority
 * (`resolveToolbarLayout`), so the bar never wraps or changes height.
 */
export const CanvasContextToolbar = ({
  engine,
  isSurfaceInteractionLocked,
}: {
  engine: CanvasToolOptionsEngine | null;
  isSurfaceInteractionLocked: boolean;
}) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(ref);
  return (
    <Flex
      ref={ref}
      align="center"
      aria-label={t('widgets.canvas.toolbar.label')}
      aria-orientation="horizontal"
      bg="bg.subtle"
      borderBottomWidth="1px"
      borderColor="border.subtle"
      data-canvas-context-toolbar=""
      flexShrink={0}
      h={`${TOOLBAR_HEIGHT_PX}px`}
      overflow="hidden"
      px={`${TOOLBAR_INSET_PX}px`}
      role="toolbar"
      w="full"
    >
      {engine ? (
        <ConnectedToolbar engine={engine} isSurfaceInteractionLocked={isSurfaceInteractionLocked} width={width} />
      ) : (
        <EmptyToolbar width={width} />
      )}
    </Flex>
  );
};
