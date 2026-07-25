import { createSelector } from '@reduxjs/toolkit';
import { useAppSelector } from 'app/store/storeHooks';
import { useInvocationNodeContext } from 'features/nodes/components/flow/nodes/Invocation/context';
import { getOutputFieldNamesByScope } from 'features/nodes/util/node/getOutputFieldNamesByScope';
import { useMemo } from 'react';

export const useOutputFieldNames = (): string[] => {
  const ctx = useInvocationNodeContext();
  const selector = useMemo(
    () =>
      createSelector(
        [ctx.selectNodeTemplateOrThrow],
        (template) => getOutputFieldNamesByScope(Object.values(template.outputs)).all
      ),
    [ctx]
  );
  return useAppSelector(selector);
};
