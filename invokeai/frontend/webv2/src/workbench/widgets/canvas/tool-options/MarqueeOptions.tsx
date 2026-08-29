import type { SelectValueChangeDetails } from '@chakra-ui/react';
import type { MarqueeToolOptions, SelectionOp } from '@workbench/canvas-engine/api';
import type {
  ToolbarRegionProps,
  ToolPresentationAdapter,
} from '@workbench/widgets/canvas/context-toolbar/toolbarContracts';

import { createListCollection } from '@chakra-ui/react';
import { Select } from '@platform/ui';
import { useMarqueeOptions } from '@workbench/widgets/canvas/engineStoreHooks';
import { SquareDashedIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { SELECTION_MODES_WIDTH_PX, SelectionActions, SelectionModes } from './SelectionOptionsRow';

type MarqueeKind = MarqueeToolOptions['kind'];

const SELECT_POSITIONING = { placement: 'bottom-start', sameWidth: false } as const;
const SELECT_TRIGGER_PROPS = { minW: '6rem', w: '6rem' } as const;

/** The shape the next drag traces (rectangle / ellipse), then the shared selection op mode. */
const MarqueeModes = ({ engine, isSurfaceInteractionLocked, placement }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const options = useMarqueeOptions(engine);
  const kindCollection = useMemo(
    () =>
      createListCollection<{ label: string; value: MarqueeKind }>({
        items: [
          { label: t('widgets.canvas.toolOptions.shapeRect'), value: 'rect' },
          { label: t('widgets.canvas.toolOptions.shapeEllipse'), value: 'ellipse' },
        ],
      }),
    [t]
  );
  const kindValue = useMemo(() => [options.kind], [options.kind]);
  const onKindChange = useCallback(
    ({ value }: SelectValueChangeDetails<{ label: string; value: MarqueeKind }>) => {
      const next = value[0] as MarqueeKind | undefined;
      if (next && next !== options.kind) {
        engine.interaction.set('marqueeOptions', { ...options, kind: next });
      }
    },
    [engine, options]
  );
  const onModeChange = useCallback(
    (mode: SelectionOp) => engine.interaction.set('marqueeOptions', { ...options, mode }),
    [engine, options]
  );
  return (
    <>
      <Select
        aria-label={t('widgets.canvas.toolOptions.marqueeKind')}
        collection={kindCollection}
        positioning={SELECT_POSITIONING}
        size="xs"
        flexShrink={0}
        triggerProps={SELECT_TRIGGER_PROPS}
        w="6rem"
        value={kindValue}
        onValueChange={onKindChange}
      />
      <SelectionModes
        engine={engine}
        hintKey="widgets.canvas.toolOptions.marqueeHint"
        isSurfaceInteractionLocked={isSurfaceInteractionLocked}
        mode={options.mode}
        placement={placement}
        onModeChange={onModeChange}
      />
    </>
  );
};

export const marqueeAdapter: ToolPresentationAdapter = {
  icon: SquareDashedIcon,
  id: 'marquee',
  modes: { component: MarqueeModes, width: 96 + 8 + SELECTION_MODES_WIDTH_PX },
  more: SelectionActions,
  primary: 'modes',
};
