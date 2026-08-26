import type { ToolId } from '@workbench/canvas-engine/api';
import type { CanvasOperationState } from '@workbench/canvas-operations/api';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import type { ComponentType } from 'react';

import { HStack, Text } from '@chakra-ui/react';
import { BboxDetailsBar } from '@workbench/widgets/canvas/BboxDetailsBar';
import { CanvasFloatingBarDivider } from '@workbench/widgets/canvas/CanvasFloatingBar';
import { useCanvasActiveTool, useCanvasOperation } from '@workbench/widgets/canvas/engineStoreHooks';
import { useTranslation } from 'react-i18next';

import { BboxOptions } from './BboxOptions';
import { BrushOptions } from './BrushOptions';
import { CanvasOperationBar } from './CanvasOperationBar';
import { CanvasOptionsBar } from './CanvasOptionsBar';
import { EraserOptions } from './EraserOptions';
import { GradientOptions } from './GradientOptions';
import { LassoOptions } from './LassoOptions';
import { MarqueeOptions } from './MarqueeOptions';
import { MoveOptions } from './MoveOptions';
import { ShapeOptions } from './ShapeOptions';
import { TextOptions } from './TextOptions';
import { TransformOptions } from './TransformOptions';

export type CanvasToolOptionsEngine = Pick<
  CanvasEngineHandle,
  'document' | 'interaction' | 'layers' | 'projectId' | 'selection' | 'tools' | 'viewport'
>;

/** Props every per-tool options component receives — just the shared engine handle. */
export interface ToolOptionsComponentProps {
  engine: CanvasToolOptionsEngine;
}

/** Contextual options content per active tool; tools without an entry show their hint instead. */
export const TOOL_OPTIONS_COMPONENTS: Partial<Record<ToolId, ComponentType<ToolOptionsComponentProps>>> = {
  bbox: BboxOptions,
  brush: BrushOptions,
  eraser: EraserOptions,
  gradient: GradientOptions,
  lasso: LassoOptions,
  marquee: MarqueeOptions,
  move: MoveOptions,
  shape: ShapeOptions,
  text: TextOptions,
  transform: TransformOptions,
};

export type ToolOptionsBarContent =
  | { kind: 'operation' }
  | { kind: 'options'; tool: ToolId; component: ComponentType<ToolOptionsComponentProps> }
  | { kind: 'hint'; tool: ToolId };

export const resolveToolOptionsBarContent = (
  operation: Pick<CanvasOperationState, 'status'>,
  activeTool: ToolId
): ToolOptionsBarContent => {
  if (operation.status === 'active') {
    return { kind: 'operation' };
  }
  const component = TOOL_OPTIONS_COMPONENTS[activeTool];
  return component ? { component, kind: 'options', tool: activeTool } : { kind: 'hint', tool: activeTool };
};

/**
 * The canvas's floating tool-options bar (bottom-center over the surface): the
 * active tool's identity followed by its contextual controls, or its usage hint
 * when it has none, so the bar keeps its place across tool switches.
 * Tool options read and write the engine's transient option stores directly
 * (`useBrushOptions` / `useEraserOptions` + `engine.interaction.set(...)`) —
 * there is no React state mirror. Positioned by {@link CanvasWidgetView};
 * shares its look with the staging bar via {@link CanvasFloatingBar}.
 */
export const ToolOptionsBar = ({ engine }: { engine: CanvasToolOptionsEngine }) => {
  const { t } = useTranslation();
  const activeTool = useCanvasActiveTool(engine);
  const operation = useCanvasOperation(engine);
  const content = resolveToolOptionsBarContent(operation, activeTool);
  if (content.kind === 'operation' && operation.status === 'active') {
    return <CanvasOperationBar engine={engine} isExternalInteractionLocked={false} operation={operation} />;
  }
  const OptionsComponent = content.kind === 'options' ? content.component : undefined;
  const hasBboxDetails = activeTool === 'bbox';

  return (
    <CanvasOptionsBar>
      <HStack align="center" gap="3" minW="0" overflow="hidden">
        <Text color="fg.muted" flexShrink={0} fontSize="xs" whiteSpace="nowrap">
          {t(`widgets.canvas.tools.${activeTool}`)}
        </Text>
        <CanvasFloatingBarDivider />
        {hasBboxDetails ? <BboxDetailsBar engine={engine} /> : null}
        {hasBboxDetails && OptionsComponent ? <CanvasFloatingBarDivider /> : null}
        {OptionsComponent ? (
          <OptionsComponent engine={engine} />
        ) : (
          <Text color="fg.subtle" fontSize="xs" minW="0" truncate>
            {t(`widgets.canvas.toolHints.${activeTool}`)}
          </Text>
        )}
      </HStack>
    </CanvasOptionsBar>
  );
};
