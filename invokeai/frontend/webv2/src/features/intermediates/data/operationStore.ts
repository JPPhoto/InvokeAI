import { registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';

/**
 * The operation the manager is following. Kept outside the component so closing Settings while a cleanup runs and
 * reopening it later shows the same operation, its result and its retry affordance.
 */
export const activeOperationStore = createExternalStore<{ operationId: string | null }>({ operationId: null });

registerAccountOwnedResource({
  clear: () => activeOperationStore.setSnapshot({ operationId: null }),
  name: 'intermediates-active-operation',
});

export const followIntermediatesOperation = (operationId: string | null): void => {
  activeOperationStore.setSnapshot({ operationId });
};
