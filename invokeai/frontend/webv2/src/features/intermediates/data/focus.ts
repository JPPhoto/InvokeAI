import { registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';

/**
 * What an entry point wants the manager to start on: a project to preselect, or an account to filter by. Consumed
 * once by the manager when it mounts, so a stale intent never resurfaces on a later visit.
 */
export interface IntermediatesFocus {
  projectId?: string;
  ownerId?: string;
}

const focusStore = createExternalStore<{ focus: IntermediatesFocus | null }>({ focus: null });

registerAccountOwnedResource({
  clear: () => focusStore.setSnapshot({ focus: null }),
  name: 'intermediates-focus',
});

export const requestIntermediatesFocus = (focus: IntermediatesFocus): void => {
  focusStore.setSnapshot({ focus });
};

export const takeIntermediatesFocus = (): IntermediatesFocus | null => {
  const { focus } = focusStore.getSnapshot();

  focusStore.setSnapshot({ focus: null });

  return focus;
};
