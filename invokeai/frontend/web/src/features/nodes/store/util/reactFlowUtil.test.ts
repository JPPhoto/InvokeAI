import { describe, expect, it } from 'vitest';

import { connectionToEdge } from './reactFlowUtil';

describe('connectionToEdge', () => {
  it('creates a default edge with the expected id and endpoints', () => {
    expect(
      connectionToEdge({
        source: 'source-node',
        sourceHandle: 'value',
        target: 'target-node',
        targetHandle: 'a',
      })
    ).toEqual({
      type: 'default',
      source: 'source-node',
      sourceHandle: 'value',
      target: 'target-node',
      targetHandle: 'a',
      id: 'reactflow__edge-source-nodevalue-target-nodea',
    });
  });

  it('creates a loop linkage edge when both handles are loop linkage handles', () => {
    expect(
      connectionToEdge({
        source: 'for-node',
        sourceHandle: 'loop_linkage',
        target: 'return-node',
        targetHandle: 'loop_linkage',
      })
    ).toEqual({
      type: 'loop_linkage',
      source: 'for-node',
      sourceHandle: 'loop_linkage',
      target: 'return-node',
      targetHandle: 'loop_linkage',
      id: 'reactflow__edge-for-nodeloop_linkage-return-nodeloop_linkage',
    });
  });
});
