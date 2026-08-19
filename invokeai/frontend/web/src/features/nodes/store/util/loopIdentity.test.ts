import { buildNode, for_loop, for_return } from 'features/nodes/store/util/testUtils';
import { describe, expect, it } from 'vitest';

import { getLoopBodyIdentity, reassignCopiedLoopBodyIdentities } from './loopIdentity';

const setBodyId = (node: ReturnType<typeof buildNode>, bodyId: string) => {
  const input = node.data.inputs.body_id;
  if (!input) {
    throw new Error('Expected body_id input');
  }
  input.value = bodyId;
};

describe('loopIdentity', () => {
  it('assigns one fresh identity to each copied For and ForReturn pair', () => {
    const forNode = buildNode(for_loop);
    const returnNode = buildNode(for_return);
    setBodyId(forNode, 'body-1');
    setBodyId(returnNode, 'body-1');

    const copied = reassignCopiedLoopBodyIdentities([forNode, returnNode], () => 'body-2');

    expect(getLoopBodyIdentity(copied[0])).toBe('body-2');
    expect(getLoopBodyIdentity(copied[1])).toBe('body-2');
    expect(getLoopBodyIdentity(forNode)).toBe('body-1');
    expect(getLoopBodyIdentity(returnNode)).toBe('body-1');
  });

  it('clears an identity when only one loop boundary is copied', () => {
    const forNode = buildNode(for_loop);
    setBodyId(forNode, 'body-1');

    const copied = reassignCopiedLoopBodyIdentities([forNode], () => 'body-2');

    expect(getLoopBodyIdentity(copied[0])).toBeUndefined();
  });

  it('clears mismatched boundary identities instead of preserving stale metadata', () => {
    const forNode = buildNode(for_loop);
    const returnNode = buildNode(for_return);
    setBodyId(forNode, 'body-1');
    setBodyId(returnNode, 'body-2');

    const copied = reassignCopiedLoopBodyIdentities([forNode, returnNode], () => 'body-3');

    expect(getLoopBodyIdentity(copied[0])).toBeUndefined();
    expect(getLoopBodyIdentity(copied[1])).toBeUndefined();
  });
});
