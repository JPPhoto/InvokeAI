import type { SystemStyleObject } from '@invoke-ai/ui-library';
import { Flex, Grid, GridItem, Text } from '@invoke-ai/ui-library';
import { InputFieldGate } from 'features/nodes/components/flow/nodes/Invocation/fields/InputFieldGate';
import { OutputFieldGate } from 'features/nodes/components/flow/nodes/Invocation/fields/OutputFieldGate';
import { OutputFieldNodesEditorView } from 'features/nodes/components/flow/nodes/Invocation/fields/OutputFieldNodesEditorView';
import {
  useInputFieldNamesAnyOrDirect,
  useInputFieldNamesConnection,
  useInputFieldNamesMissing,
} from 'features/nodes/hooks/useInputFieldNamesByStatus';
import { useOutputFieldNamesByScope } from 'features/nodes/hooks/useOutputFieldNames';
import { useWithFooter } from 'features/nodes/hooks/useWithFooter';
import { getOutputFieldRows } from 'features/nodes/util/node/getOutputFieldRows';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { InputFieldEditModeNodes } from './fields/InputFieldEditModeNodes';
import InvocationNodeFooter from './InvocationNodeFooter';
import InvocationNodeHeader from './InvocationNodeHeader';

type Props = {
  nodeId: string;
  isOpen: boolean;
};

const sx: SystemStyleObject = {
  flexDirection: 'column',
  w: 'full',
  h: 'full',
  py: 2,
  gap: 1,
  borderBottomRadius: 'base',
  '&[data-with-footer="true"]': {
    borderBottomRadius: 0,
  },
  '&[data-with-footer="false"]': {
    pb: 4,
  },
};

const InvocationNode = ({ nodeId, isOpen }: Props) => {
  const withFooter = useWithFooter();

  return (
    <>
      <InvocationNodeHeader nodeId={nodeId} isOpen={isOpen} />
      {isOpen && (
        <>
          <Flex layerStyle="nodeBody" sx={sx} data-with-footer={withFooter}>
            <Flex flexDir="column" px={2} w="full" h="full">
              <Grid gridTemplateColumns="1fr auto" gridAutoRows="1fr">
                <ConnectionFields nodeId={nodeId} />
                <OutputFields nodeId={nodeId} />
              </Grid>
              <AnyOrDirectFields nodeId={nodeId} />
              <MissingFields nodeId={nodeId} />
            </Flex>
          </Flex>
          {withFooter && <InvocationNodeFooter nodeId={nodeId} />}
        </>
      )}
    </>
  );
};

export default memo(InvocationNode);

const ConnectionFields = memo(({ nodeId }: { nodeId: string }) => {
  const fieldNames = useInputFieldNamesConnection();
  return (
    <>
      {fieldNames.map((fieldName, i) => (
        <GridItem gridColumnStart={1} gridRowStart={i + 1} key={`${nodeId}.${fieldName}.input-field`}>
          <InputFieldGate nodeId={nodeId} fieldName={fieldName}>
            <InputFieldEditModeNodes nodeId={nodeId} fieldName={fieldName} />
          </InputFieldGate>
        </GridItem>
      ))}
    </>
  );
});
ConnectionFields.displayName = 'ConnectionFields';

const AnyOrDirectFields = memo(({ nodeId }: { nodeId: string }) => {
  const fieldNames = useInputFieldNamesAnyOrDirect();
  return (
    <>
      {fieldNames.map((fieldName) => (
        <InputFieldGate key={`${nodeId}.${fieldName}.input-field`} nodeId={nodeId} fieldName={fieldName}>
          <InputFieldEditModeNodes nodeId={nodeId} fieldName={fieldName} />
        </InputFieldGate>
      ))}
    </>
  );
});
AnyOrDirectFields.displayName = 'AnyOrDirectFields';

const MissingFields = memo(({ nodeId }: { nodeId: string }) => {
  const fieldNames = useInputFieldNamesMissing();
  return (
    <>
      {fieldNames.map((fieldName) => (
        <InputFieldGate key={`${nodeId}.${fieldName}.input-field`} nodeId={nodeId} fieldName={fieldName}>
          <InputFieldEditModeNodes nodeId={nodeId} fieldName={fieldName} />
        </InputFieldGate>
      ))}
    </>
  );
});
MissingFields.displayName = 'MissingFields';

const OutputFields = memo(({ nodeId }: { nodeId: string }) => {
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
