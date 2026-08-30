import { GridItem, Text } from '@invoke-ai/ui-library';
import { OutputFieldGate } from 'features/nodes/components/flow/nodes/Invocation/fields/OutputFieldGate';
import { OutputFieldNodesEditorView } from 'features/nodes/components/flow/nodes/Invocation/fields/OutputFieldNodesEditorView';
import { useOutputFieldNamesByScope } from 'features/nodes/hooks/useOutputFieldNames';
import { getOutputFieldRows } from 'features/nodes/util/node/getOutputFieldRows';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

export const OutputFields = memo(({ nodeId }: { nodeId: string }) => {
  const { t } = useTranslation();
  const fieldNames = useOutputFieldNamesByScope();
  const rows = getOutputFieldRows(fieldNames);
  return (
    <>
      {rows.map((row, i) =>
        row.type === 'header' ? (
          <GridItem gridColumnStart={2} gridRowStart={i + 1} key={`${nodeId}.${row.scope}.output-header`} px={2} pt={1}>
            <Text variant="subtext" fontSize="xs" fontWeight="semibold" textAlign="end">
              {row.scope === 'iteration' ? t('nodes.iterationOutputs') : t('nodes.finalOutputs')}
            </Text>
          </GridItem>
        ) : (
          <GridItem gridColumnStart={2} gridRowStart={i + 1} key={`${nodeId}.${row.fieldName}.output-field`}>
            <OutputFieldGate nodeId={nodeId} fieldName={row.fieldName}>
              <OutputFieldNodesEditorView nodeId={nodeId} fieldName={row.fieldName} />
            </OutputFieldGate>
          </GridItem>
        )
      )}
    </>
  );
});
OutputFields.displayName = 'OutputFields';
