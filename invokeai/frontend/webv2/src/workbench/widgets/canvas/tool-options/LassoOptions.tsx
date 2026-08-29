import type { SelectValueChangeDetails } from '@chakra-ui/react';
import type { LassoToolOptions, SelectionOp } from '@workbench/canvas-engine/api';
import type {
  ToolbarRegionProps,
  ToolPresentationAdapter,
} from '@workbench/widgets/canvas/context-toolbar/toolbarContracts';

import { createListCollection } from '@chakra-ui/react';
import { Select } from '@platform/ui';
import { useLassoOptions } from '@workbench/widgets/canvas/engineStoreHooks';
import { LassoIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { SELECTION_MODES_WIDTH_PX, SelectionActions, SelectionModes } from './SelectionOptionsRow';

type LassoShape = LassoToolOptions['shape'];

const SELECT_POSITIONING = { placement: 'bottom-start', sameWidth: false } as const;
const SELECT_TRIGGER_PROPS = { minW: '6rem', w: '6rem' } as const;

/** How the path is drawn (freehand drag / polygon clicks), then the shared selection op mode. */
const LassoModes = ({ engine, isSurfaceInteractionLocked, placement }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const options = useLassoOptions(engine);
  const shapeCollection = useMemo(
    () =>
      createListCollection<{ label: string; value: LassoShape }>({
        items: [
          { label: t('widgets.canvas.toolOptions.lassoFreehand'), value: 'freehand' },
          { label: t('widgets.canvas.toolOptions.lassoPolygon'), value: 'polygon' },
        ],
      }),
    [t]
  );
  const shapeValue = useMemo(() => [options.shape], [options.shape]);
  const onShapeChange = useCallback(
    ({ value }: SelectValueChangeDetails<{ label: string; value: LassoShape }>) => {
      const next = value[0] as LassoShape | undefined;
      if (next && next !== options.shape) {
        engine.interaction.set('lassoOptions', { ...options, shape: next });
      }
    },
    [engine, options]
  );
  const onModeChange = useCallback(
    (mode: SelectionOp) => engine.interaction.set('lassoOptions', { ...options, mode }),
    [engine, options]
  );
  return (
    <>
      <Select
        aria-label={t('widgets.canvas.toolOptions.lassoShape')}
        collection={shapeCollection}
        positioning={SELECT_POSITIONING}
        size="xs"
        flexShrink={0}
        triggerProps={SELECT_TRIGGER_PROPS}
        w="6rem"
        value={shapeValue}
        onValueChange={onShapeChange}
      />
      <SelectionModes
        engine={engine}
        hintKey={
          options.shape === 'polygon'
            ? 'widgets.canvas.toolOptions.lassoPolygonHint'
            : 'widgets.canvas.toolOptions.lassoHint'
        }
        isSurfaceInteractionLocked={isSurfaceInteractionLocked}
        mode={options.mode}
        placement={placement}
        onModeChange={onModeChange}
      />
    </>
  );
};

export const lassoAdapter: ToolPresentationAdapter = {
  icon: LassoIcon,
  id: 'lasso',
  modes: { component: LassoModes, width: 96 + 8 + SELECTION_MODES_WIDTH_PX },
  more: SelectionActions,
  primary: 'modes',
};
