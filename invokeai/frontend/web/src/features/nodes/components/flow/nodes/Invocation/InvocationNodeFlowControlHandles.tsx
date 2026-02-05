import { Handle, Position } from '@xyflow/react';
import { useNodeTemplateOrThrow } from 'features/nodes/hooks/useNodeTemplateOrThrow';
import {
  FLOW_CONTROL_HANDLE_COLOR,
  FLOW_CONTROL_SOURCE_HANDLE_ID,
  FLOW_CONTROL_TARGET_HANDLE_ID,
} from 'features/nodes/types/constants';
import type { CSSProperties } from 'react';
import { memo } from 'react';

const baseHandleStyles: CSSProperties = {
  width: '12px',
  height: '10px',
  borderRadius: 0,
  borderWidth: 0,
  backgroundColor: FLOW_CONTROL_HANDLE_COLOR,
  zIndex: 2,
};

const topHandleStyles: CSSProperties = {
  ...baseHandleStyles,
  top: '-6px',
  left: '32px',
  right: 'auto',
  transform: 'none',
  clipPath: 'polygon(50% 100%, 0 0, 100% 0)',
};

const bottomHandleStyles: CSSProperties = {
  ...baseHandleStyles,
  left: 'auto',
  right: '32px',
  bottom: '-7px',
  transform: 'none',
  clipPath: 'polygon(50% 100%, 0 0, 100% 0)',
};

const InvocationNodeFlowControlHandles = () => {
  const template = useNodeTemplateOrThrow();
  const flowControl = template.flowControl ?? {};
  const showIncoming = flowControl.incoming !== false;
  const showOutgoing = flowControl.outgoing !== false;

  return (
    <>
      {showIncoming && (
        <Handle type="target" id={FLOW_CONTROL_TARGET_HANDLE_ID} position={Position.Top} style={topHandleStyles} />
      )}
      {showOutgoing && (
        <Handle
          type="source"
          id={FLOW_CONTROL_SOURCE_HANDLE_ID}
          position={Position.Bottom}
          style={bottomHandleStyles}
        />
      )}
    </>
  );
};

export default memo(InvocationNodeFlowControlHandles);
