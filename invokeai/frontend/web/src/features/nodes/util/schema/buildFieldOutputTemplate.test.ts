import type { FieldType } from 'features/nodes/types/field';
import type { InvocationOutputFieldSchema } from 'features/nodes/types/openapi';
import { buildFieldOutputTemplate } from 'features/nodes/util/schema/buildFieldOutputTemplate';
import { describe, expect, it } from 'vitest';

const fieldType: FieldType = {
  name: 'StringField',
  cardinality: 'SINGLE',
  batch: false,
};

describe('buildFieldOutputTemplate', () => {
  it('preserves output scope metadata', () => {
    const fieldSchema = {
      field_kind: 'output',
      title: 'Item',
      description: 'The current item',
      ui_hidden: false,
      output_scope: 'iteration',
    } as InvocationOutputFieldSchema;

    const template = buildFieldOutputTemplate(fieldSchema, 'item', fieldType);

    expect(template.output_scope).toBe('iteration');
  });
});
