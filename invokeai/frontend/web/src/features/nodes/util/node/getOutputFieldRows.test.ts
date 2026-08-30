import { getOutputFieldRows } from 'features/nodes/util/node/getOutputFieldRows';
import { describe, expect, it } from 'vitest';

describe(getOutputFieldRows.name, () => {
  it('returns ordinary outputs without section headers', () => {
    expect(
      getOutputFieldRows({
        all: ['value', 'metadata'],
        unscoped: ['value', 'metadata'],
        iteration: [],
        final: [],
      })
    ).toEqual([
      { type: 'field', fieldName: 'value' },
      { type: 'field', fieldName: 'metadata' },
    ]);
  });

  it('groups scoped outputs under iteration and final section headers', () => {
    expect(
      getOutputFieldRows({
        all: ['value', 'item', 'state', 'output_collection', 'final_state'],
        unscoped: ['value'],
        iteration: ['item', 'state'],
        final: ['output_collection', 'final_state'],
      })
    ).toEqual([
      { type: 'field', fieldName: 'value' },
      { type: 'header', scope: 'iteration' },
      { type: 'field', fieldName: 'item' },
      { type: 'field', fieldName: 'state' },
      { type: 'header', scope: 'final' },
      { type: 'field', fieldName: 'output_collection' },
      { type: 'field', fieldName: 'final_state' },
    ]);
  });
});
