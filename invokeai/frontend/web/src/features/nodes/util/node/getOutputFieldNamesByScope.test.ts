import { for_return } from 'features/nodes/store/util/testUtils';
import type { FieldOutputTemplate } from 'features/nodes/types/field';
import { getOutputFieldNamesByScope } from 'features/nodes/util/node/getOutputFieldNamesByScope';
import { describe, expect, it } from 'vitest';

const buildOutput = (
  name: string,
  output_scope: FieldOutputTemplate['output_scope'],
  ui_order: number,
  ui_hidden = false
): FieldOutputTemplate => ({
  fieldKind: 'output',
  name,
  title: name,
  description: name,
  type: { name: 'AnyField', cardinality: 'SINGLE', batch: false },
  ui_hidden,
  ui_order,
  output_scope,
});

describe(getOutputFieldNamesByScope.name, () => {
  it('sorts visible output fields and partitions them by scope', () => {
    const fields = [
      buildOutput('output_collection', 'final', 3),
      buildOutput('hidden_iteration_value', 'iteration', 0, true),
      buildOutput('value', null, 2),
      buildOutput('item', 'iteration', 1),
    ];

    expect(getOutputFieldNamesByScope(fields)).toEqual({
      all: ['item', 'value', 'output_collection'],
      unscoped: ['value'],
      iteration: ['item'],
      final: ['output_collection'],
    });
  });

  it('hides ForReturn scheduler outputs from the node UI', () => {
    expect(getOutputFieldNamesByScope(Object.values(for_return.outputs))).toEqual({
      all: [],
      unscoped: [],
      iteration: [],
      final: [],
    });
    expect(for_return.inputs.output.ui_hidden).toBe(false);
    expect(for_return.inputs.state.ui_hidden).toBe(false);
  });
});
