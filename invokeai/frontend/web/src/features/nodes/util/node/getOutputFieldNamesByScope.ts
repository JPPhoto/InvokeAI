import type { FieldOutputTemplate } from 'features/nodes/types/field';
import { getSortedFilteredFieldNames } from 'features/nodes/util/node/getSortedFilteredFieldNames';

export type OutputFieldNamesByScope = {
  all: string[];
  unscoped: string[];
  iteration: string[];
  final: string[];
};

export const getOutputFieldNamesByScope = (fields: FieldOutputTemplate[]): OutputFieldNamesByScope => {
  const all = getSortedFilteredFieldNames(fields);
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));

  return {
    all,
    unscoped: all.filter((name) => !fieldsByName.get(name)?.output_scope),
    iteration: all.filter((name) => fieldsByName.get(name)?.output_scope === 'iteration'),
    final: all.filter((name) => fieldsByName.get(name)?.output_scope === 'final'),
  };
};
