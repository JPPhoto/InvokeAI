import type {
  ToolbarRegionProps,
  ToolPresentationAdapter,
} from '@workbench/widgets/canvas/context-toolbar/toolbarContracts';

import { lookupDocumentLeaf } from '@workbench/canvas-engine/api';
import { ToolbarNumberField, useNumberCommit } from '@workbench/widgets/canvas/context-toolbar/ToolbarPrimitives';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { MoveIcon } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

interface SelectedTransform {
  id: string;
  x: number;
  y: number;
}

/**
 * Numeric X / Y of the selected layer in document pixels. Reads the committed
 * transform and writes each edit through the engine's structural history, so
 * it shares the undo stack with drags and nudges. Disabled with no editable
 * selection.
 */
const MovePosition = ({ engine }: ToolbarRegionProps) => {
  const { t } = useTranslation();
  const commitPrepared = usePreparedCommit(engine);
  const selected = useActiveProjectSelector(
    (project): SelectedTransform | null => {
      const { document } = project.canvas;
      const leaf = document.selectedLayerId ? lookupDocumentLeaf(document, document.selectedLayerId) : null;
      return leaf && !leaf.effectiveLocked
        ? { id: leaf.id, x: leaf.layer.transform.x, y: leaf.layer.transform.y }
        : null;
    },
    (a, b) => a?.id === b?.id && a?.x === b?.x && a?.y === b?.y
  );

  const commitAxis = useCallback(
    (axis: 'x' | 'y', value: number) => {
      if (!selected) {
        return;
      }
      const next = Math.round(value);
      if (next === selected[axis]) {
        return;
      }
      commitPrepared(t('widgets.canvas.toolOptions.movePosition'), (model) =>
        model.prepare({
          id: selected.id,
          patch: { transform: axis === 'x' ? { x: next } : { y: next } },
          type: 'patch',
        })
      );
    },
    [commitPrepared, selected, t]
  );
  const onX = useNumberCommit(useCallback((value: number) => commitAxis('x', value), [commitAxis]));
  const onY = useNumberCommit(useCallback((value: number) => commitAxis('y', value), [commitAxis]));

  return (
    <>
      <ToolbarNumberField
        aria-label={t('widgets.canvas.toolOptions.positionX')}
        disabled={!selected}
        label={t('widgets.canvas.toolOptions.positionX')}
        value={selected ? String(Math.round(selected.x)) : ''}
        onValueCommit={onX}
      />
      <ToolbarNumberField
        aria-label={t('widgets.canvas.toolOptions.positionY')}
        disabled={!selected}
        label={t('widgets.canvas.toolOptions.positionY')}
        value={selected ? String(Math.round(selected.y)) : ''}
        onValueCommit={onY}
      />
    </>
  );
};

export const moveAdapter: ToolPresentationAdapter = {
  geometry: MovePosition,
  icon: MoveIcon,
  id: 'move',
  primary: 'geometry',
};
