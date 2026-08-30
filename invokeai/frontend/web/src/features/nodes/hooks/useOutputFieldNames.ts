import { createSelector } from '@reduxjs/toolkit';
import { useAppSelector } from 'app/store/storeHooks';
import { useInvocationNodeContext } from 'features/nodes/components/flow/nodes/Invocation/context';
import {
  getOutputFieldNamesByScope,
  type OutputFieldNamesByScope,
} from 'features/nodes/util/node/getOutputFieldNamesByScope';
import { useMemo } from 'react';

export const useOutputFieldNamesByScope = (): OutputFieldNamesByScope => {
  const ctx = useInvocationNodeContext();
  const selector = useMemo(
    () =>
      createSelector([ctx.selectNodeTemplateOrThrow], (template) =>
        getOutputFieldNamesByScope(Object.values(template.outputs))
      ),
    [ctx]
  );
  return useAppSelector(selector);
};

export const useOutputFieldNames = (): string[] => useOutputFieldNamesByScope().all;
