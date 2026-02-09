import type { SystemStyleObject } from '@invoke-ai/ui-library';
import { Box, Tooltip } from '@invoke-ai/ui-library';
import { Handle, Position } from '@xyflow/react';
import { getFieldColor } from 'features/nodes/components/flow/edges/util/getEdgeColor';
import {
  useConnectionErrorTKey,
  useIsConnectionInProgress,
  useIsConnectionStartField,
} from 'features/nodes/hooks/useFieldConnectionState';
import { useNodeType } from 'features/nodes/hooks/useNodeType';
import { useOutputFieldTemplate } from 'features/nodes/hooks/useOutputFieldTemplate';
import { useFieldTypeName } from 'features/nodes/hooks/usePrettyFieldType';
import {
  FLOW_CONTROL_HANDLE_COLOR,
  FLOW_CONTROL_SOURCE_FALSE_HANDLE_ID,
  FLOW_CONTROL_SOURCE_TRUE_HANDLE_ID,
  HANDLE_TOOLTIP_OPEN_DELAY,
} from 'features/nodes/types/constants';
import type { FieldOutputTemplate } from 'features/nodes/types/field';
import { isModelFieldType } from 'features/nodes/types/field';
import type { CSSProperties } from 'react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

type Props = {
  nodeId: string;
  fieldName: string;
};

const sx = {
  position: 'relative',
  width: 'full',
  height: 'full',
  borderStyle: 'solid',
  borderWidth: 4,
  pointerEvents: 'none',
  '&[data-cardinality="SINGLE"]': {
    borderWidth: 0,
  },
  borderRadius: '100%',
  '&[data-is-model-field="true"], &[data-is-batch-field="true"]': {
    borderRadius: 4,
  },
  '&[data-is-batch-field="true"]': {
    transform: 'rotate(45deg)',
  },
  '&[data-is-connection-in-progress="true"][data-is-connection-start-field="false"][data-is-connection-valid="false"]':
    {
      filter: 'opacity(0.4) grayscale(0.7)',
      cursor: 'not-allowed',
    },
  '&[data-is-connection-in-progress="true"][data-is-connection-start-field="true"][data-is-connection-valid="false"]': {
    cursor: 'grab',
  },
  '&[data-is-connection-in-progress="false"] &[data-is-connection-valid="true"]': {
    cursor: 'crosshair',
  },
} satisfies SystemStyleObject;

const handleStyles = {
  position: 'absolute',
  width: '1rem',
  height: '1rem',
  zIndex: 1,
  background: 'none',
  border: 'none',
  insetInlineEnd: '-0.5rem',
} satisfies CSSProperties;

const flowControlHandleStyles = {
  position: 'absolute',
  width: '12px',
  height: '10px',
  zIndex: 1,
  background: 'none',
  border: 'none',
  insetInlineEnd: '-6px',
} satisfies CSSProperties;

const flowControlBoxSx = {
  width: '12px',
  height: '10px',
  borderRadius: 0,
  backgroundColor: FLOW_CONTROL_HANDLE_COLOR,
  clipPath: 'polygon(0 0, 0 100%, 100% 50%)',
  pointerEvents: 'none',
  '&[data-is-connection-in-progress="true"][data-is-connection-start-field="false"][data-is-connection-valid="false"]':
    {
      filter: 'opacity(0.4) grayscale(0.7)',
      cursor: 'not-allowed',
    },
  '&[data-is-connection-in-progress="true"][data-is-connection-start-field="true"][data-is-connection-valid="false"]': {
    cursor: 'grab',
  },
  '&[data-is-connection-in-progress="false"] &[data-is-connection-valid="true"]': {
    cursor: 'crosshair',
  },
} satisfies SystemStyleObject;

export const OutputFieldHandle = memo(({ nodeId, fieldName }: Props) => {
  const fieldTemplate = useOutputFieldTemplate(fieldName);
  const nodeType = useNodeType();
  const fieldTypeName = useFieldTypeName(fieldTemplate.type);
  const fieldColor = useMemo(() => getFieldColor(fieldTemplate.type), [fieldTemplate.type]);
  const isModelField = useMemo(() => isModelFieldType(fieldTemplate.type), [fieldTemplate.type]);
  const isConnectionInProgress = useIsConnectionInProgress();
  const isIfFlowControlOutput =
    nodeType === 'if' &&
    (fieldName === FLOW_CONTROL_SOURCE_TRUE_HANDLE_ID || fieldName === FLOW_CONTROL_SOURCE_FALSE_HANDLE_ID);

  if (isConnectionInProgress) {
    return (
      <ConnectionInProgressHandle
        nodeId={nodeId}
        fieldName={fieldName}
        fieldTemplate={fieldTemplate}
        fieldTypeName={fieldTypeName}
        fieldColor={fieldColor}
        isModelField={isModelField}
        isIfFlowControlOutput={isIfFlowControlOutput}
      />
    );
  }

  return (
    <IdleHandle
      nodeId={nodeId}
      fieldName={fieldName}
      fieldTemplate={fieldTemplate}
      fieldTypeName={fieldTypeName}
      fieldColor={fieldColor}
      isModelField={isModelField}
      isIfFlowControlOutput={isIfFlowControlOutput}
    />
  );
});

OutputFieldHandle.displayName = 'OutputFieldHandle';

type HandleCommonProps = {
  nodeId: string;
  fieldName: string;
  fieldTemplate: FieldOutputTemplate;
  fieldTypeName: string;
  fieldColor: string;
  isModelField: boolean;
  isIfFlowControlOutput: boolean;
};

const IdleHandle = memo(
  ({ fieldTemplate, fieldTypeName, fieldColor, isModelField, isIfFlowControlOutput }: HandleCommonProps) => {
    if (isIfFlowControlOutput) {
      return (
        <Tooltip label={fieldTypeName} placement="start" openDelay={HANDLE_TOOLTIP_OPEN_DELAY}>
          <Handle type="source" id={fieldTemplate.name} position={Position.Right} style={flowControlHandleStyles}>
            <Box
              sx={flowControlBoxSx}
              data-is-connection-in-progress={false}
              data-is-connection-start-field={false}
              data-is-connection-valid={false}
            />
          </Handle>
        </Tooltip>
      );
    }

    return (
      <Tooltip label={fieldTypeName} placement="start" openDelay={HANDLE_TOOLTIP_OPEN_DELAY}>
        <Handle type="source" id={fieldTemplate.name} position={Position.Right} style={handleStyles}>
          <Box
            sx={sx}
            data-cardinality={fieldTemplate.type.cardinality}
            data-is-batch-field={fieldTemplate.type.batch}
            data-is-model-field={isModelField}
            data-is-connection-in-progress={false}
            data-is-connection-start-field={false}
            data-is-connection-valid={false}
            backgroundColor={fieldTemplate.type.cardinality === 'SINGLE' ? fieldColor : 'base.900'}
            borderColor={fieldColor}
          />
        </Handle>
      </Tooltip>
    );
  }
);
IdleHandle.displayName = 'IdleHandle';

const ConnectionInProgressHandle = memo(
  ({
    nodeId,
    fieldName,
    fieldTemplate,
    fieldTypeName,
    fieldColor,
    isModelField,
    isIfFlowControlOutput,
  }: HandleCommonProps) => {
    const { t } = useTranslation();
    const isConnectionStartField = useIsConnectionStartField(nodeId, fieldName, 'target');
    const connectionErrorTKey = useConnectionErrorTKey(nodeId, fieldName, 'target');

    const tooltip = useMemo(() => {
      if (connectionErrorTKey !== null) {
        return t(connectionErrorTKey);
      }
      return fieldTypeName;
    }, [fieldTypeName, t, connectionErrorTKey]);

    if (isIfFlowControlOutput) {
      return (
        <Tooltip label={tooltip} placement="start" openDelay={HANDLE_TOOLTIP_OPEN_DELAY}>
          <Handle type="source" id={fieldTemplate.name} position={Position.Right} style={flowControlHandleStyles}>
            <Box
              sx={flowControlBoxSx}
              data-is-connection-in-progress={true}
              data-is-connection-start-field={isConnectionStartField}
              data-is-connection-valid={connectionErrorTKey === null}
            />
          </Handle>
        </Tooltip>
      );
    }

    return (
      <Tooltip label={tooltip} placement="start" openDelay={HANDLE_TOOLTIP_OPEN_DELAY}>
        <Handle type="source" id={fieldTemplate.name} position={Position.Right} style={handleStyles}>
          <Box
            sx={sx}
            data-cardinality={fieldTemplate.type.cardinality}
            data-is-batch-field={fieldTemplate.type.batch}
            data-is-model-field={isModelField}
            data-is-connection-in-progress={true}
            data-is-connection-start-field={isConnectionStartField}
            data-is-connection-valid={connectionErrorTKey === null}
            backgroundColor={fieldTemplate.type.cardinality === 'SINGLE' ? fieldColor : 'base.900'}
            borderColor={fieldColor}
          />
        </Handle>
      </Tooltip>
    );
  }
);
ConnectionInProgressHandle.displayName = 'ConnectionInProgressHandle';
