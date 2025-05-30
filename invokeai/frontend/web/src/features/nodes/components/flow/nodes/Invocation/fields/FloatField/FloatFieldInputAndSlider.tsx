import { CompositeNumberInput, CompositeSlider } from '@invoke-ai/ui-library';
import { useFloatField } from 'features/nodes/components/flow/nodes/Invocation/fields/FloatField/useFloatField';
import type { FieldComponentProps } from 'features/nodes/components/flow/nodes/Invocation/fields/inputs/types';
import { NO_DRAG_CLASS } from 'features/nodes/types/constants';
import type { FloatFieldInputInstance, FloatFieldInputTemplate } from 'features/nodes/types/field';
import type { NodeFieldFloatSettings } from 'features/nodes/types/workflow';
import { memo } from 'react';

export const FloatFieldInputAndSlider = memo(
  (
    props: FieldComponentProps<FloatFieldInputInstance, FloatFieldInputTemplate, { settings?: NodeFieldFloatSettings }>
  ) => {
    const { nodeId, field, fieldTemplate, settings } = props;
    const { defaultValue, onChange, min, max, step, fineStep } = useFloatField(
      nodeId,
      field.name,
      fieldTemplate,
      settings
    );

    return (
      <>
        <CompositeSlider
          defaultValue={defaultValue}
          onChange={onChange}
          value={field.value}
          min={min}
          max={max}
          step={step}
          fineStep={fineStep}
          className={NO_DRAG_CLASS}
          marks
          withThumbTooltip
          flex="1 1 0"
        />
        <CompositeNumberInput
          defaultValue={defaultValue}
          onChange={onChange}
          value={field.value}
          min={min}
          max={max}
          step={step}
          fineStep={fineStep}
          className={NO_DRAG_CLASS}
          flex="1 1 0"
        />
      </>
    );
  }
);

FloatFieldInputAndSlider.displayName = 'FloatFieldInputAndSlider ';
