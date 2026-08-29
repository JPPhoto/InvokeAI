import type { WidgetViewProps } from '@workbench/widgetContracts';

import { Flex, Stack, Text } from '@chakra-ui/react';
import { Scrollable } from '@platform/ui';
import { isCanvasInteractionLocked } from '@workbench/widgets/canvas/canvasInteractionLock';
import { useCanvasActiveTool, useCanvasOperation } from '@workbench/widgets/canvas/engineStoreHooks';
import {
  hasToolRegions,
  OPERATION_PRESENTATION_ADAPTERS,
  TOOL_PRESENTATION_ADAPTERS,
} from '@workbench/widgets/canvas/tool-presentation/toolAdapters';
import { useCanvasEngine, type CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { GroupSelectedNotice } from './GroupSelectedNotice';
import { PropertiesRow, PropertiesSection } from './PropertiesSection';

const REGION_LABEL_KEYS = {
  color: 'widgets.properties.rows.color',
  geometry: 'widgets.properties.rows.geometry',
  intensity: 'widgets.properties.rows.intensity',
  modes: 'widgets.properties.rows.modes',
  more: 'widgets.properties.rows.more',
} as const;

/**
 * Full editors for what the canvas is doing: the running operation first, then
 * the active tool's settings. Reads and writes the engine's option stores and
 * document transactions through the same adapters the canvas registers; it
 * mirrors no state of its own.
 */
export const PropertiesWidgetView = (_props: WidgetViewProps) => {
  const { t } = useTranslation();
  const engine = useCanvasEngine();
  const isSurfaceInteractionLocked = useActiveProjectSelector((project) =>
    isCanvasInteractionLocked(project.canvas, project.queue.items)
  );

  if (!engine) {
    return (
      <Flex align="center" color="fg.muted" fontSize="xs" h="full" justify="center" p="4">
        {t('widgets.properties.noCanvas')}
      </Flex>
    );
  }

  return (
    <Scrollable h="full">
      <ConnectedProperties engine={engine} isSurfaceInteractionLocked={isSurfaceInteractionLocked} />
    </Scrollable>
  );
};

const ConnectedProperties = ({
  engine,
  isSurfaceInteractionLocked,
}: {
  engine: CanvasEngineHandle;
  isSurfaceInteractionLocked: boolean;
}) => {
  const { t } = useTranslation();
  const activeTool = useCanvasActiveTool(engine);
  const operation = useCanvasOperation(engine);
  const running = operation.status === 'active' ? OPERATION_PRESENTATION_ADAPTERS[operation.identity.kind] : null;
  const tool = TOOL_PRESENTATION_ADAPTERS[activeTool];
  const toolName = t(`widgets.canvas.tools.${tool.id}`);
  const ToolStatus = tool.status;
  const regionProps = { engine, isSurfaceInteractionLocked };
  const rows = (
    [
      ['geometry', tool.geometry],
      ['intensity', tool.intensity],
      ['color', tool.color],
      ['modes', tool.modes],
      ['more', tool.more],
    ] as const
  ).filter((entry): entry is [keyof typeof REGION_LABEL_KEYS, NonNullable<(typeof entry)[1]>] => !!entry[1]);

  // `inert` will blur a focused tool control once an operation starts; hand focus to the operation's Cancel first.
  const root = useRef<HTMLDivElement>(null);
  const toolSection = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (running && toolSection.current?.contains(document.activeElement)) {
      root.current?.querySelector<HTMLElement>('[data-toolbar-action="cancel"]')?.focus();
    }
  }, [running]);

  return (
    <Stack ref={root} gap="0">
      {running ? (
        <PropertiesSection
          subtitle={t(
            running.kind === 'filter' ? 'widgets.layers.rasterFilter.title' : 'widgets.layers.selectObject.title'
          )}
          title={t('widgets.properties.sections.operation')}
        >
          {running.modes ? <running.modes {...regionProps} /> : null}
          {running.more ? <running.more {...regionProps} /> : null}
          <running.status engine={engine} isExternalInteractionLocked={isSurfaceInteractionLocked} />
        </PropertiesSection>
      ) : null}
      <PropertiesSection
        ref={toolSection}
        disabled={isSurfaceInteractionLocked || running !== null}
        subtitle={toolName}
        title={t('widgets.properties.sections.tool')}
      >
        {tool.paintsLeaf && !running ? <GroupSelectedNotice /> : null}
        {hasToolRegions(tool) ? (
          rows.map(([region, Region]) => (
            <PropertiesRow
              key={`${tool.id}:${region}`}
              label={t(tool.rowLabels?.[region] ?? REGION_LABEL_KEYS[region])}
            >
              <Region {...regionProps} />
            </PropertiesRow>
          ))
        ) : (
          <Text color="fg.muted" fontSize="xs">
            {t(`widgets.canvas.toolHints.${tool.id}`)}
          </Text>
        )}
        {ToolStatus ? <ToolStatus engine={engine} isExternalInteractionLocked={isSurfaceInteractionLocked} /> : null}
      </PropertiesSection>
    </Stack>
  );
};
