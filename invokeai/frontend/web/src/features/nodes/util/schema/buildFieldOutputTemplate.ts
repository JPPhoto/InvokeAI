import { startCase } from 'es-toolkit/compat';
import type { FieldOutputTemplate, FieldType } from 'features/nodes/types/field';
import type { InvocationOutputFieldSchema } from 'features/nodes/types/openapi';

export const buildFieldOutputTemplate = (
  fieldSchema: InvocationOutputFieldSchema,
  fieldName: string,
  fieldType: FieldType
): FieldOutputTemplate => {
  const { title, description, ui_hidden, ui_type, ui_order, output_scope } = fieldSchema;

  const template: FieldOutputTemplate = {
    fieldKind: 'output',
    name: fieldName,
    title: title ?? (fieldName ? startCase(fieldName) : ''),
    description: description ?? '',
    type: fieldType,
    ui_hidden,
    ui_type,
    ui_order,
    output_scope,
  };

  return template;
};
