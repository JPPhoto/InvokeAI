import type { OutputFieldNamesByScope } from 'features/nodes/util/node/getOutputFieldNamesByScope';

export type OutputFieldRow = { type: 'field'; fieldName: string } | { type: 'header'; scope: 'iteration' | 'final' };

const getFieldRows = (fieldNames: string[]): OutputFieldRow[] =>
  fieldNames.map((fieldName) => ({ type: 'field', fieldName }));

export const getOutputFieldRows = (fieldNames: OutputFieldNamesByScope): OutputFieldRow[] => {
  if (fieldNames.iteration.length === 0 && fieldNames.final.length === 0) {
    return getFieldRows(fieldNames.all);
  }

  const rows = getFieldRows(fieldNames.unscoped);
  if (fieldNames.iteration.length > 0) {
    rows.push({ type: 'header', scope: 'iteration' }, ...getFieldRows(fieldNames.iteration));
  }
  if (fieldNames.final.length > 0) {
    rows.push({ type: 'header', scope: 'final' }, ...getFieldRows(fieldNames.final));
  }
  return rows;
};
