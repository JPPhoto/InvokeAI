import type { SocketHub } from '@platform/transport/socketHub';
import type { WorkbenchCommands, WorkbenchQueries } from '@workbench/workbenchStore';
import type { TFunction } from 'i18next';

import { getProjectWidgetValues } from '@workbench/widgetState';

import type { PendingRecallEvent, RecallRuntime } from './recallEventRuntime';

import { executeRecallParameters } from './executeRecallParameters';
import { createRecallEventRuntime } from './recallEventRuntime';
import { isRecallParametersUpdatedEvent } from './recallParameters';

/** Apply `recall_parameters_updated` events to their arrival-time project's Generate panel. */
export const createRecallParametersRuntime = ({
  commands,
  getSessionUserId,
  hub,
  queries,
  replay,
  t,
}: {
  commands: Pick<WorkbenchCommands, 'generation' | 'notifications'>;
  getSessionUserId?: () => string | null;
  hub: Pick<SocketHub, 'on'>;
  queries: Pick<WorkbenchQueries, 'getProject' | 'getSnapshot'>;
  replay?: readonly PendingRecallEvent[];
  /** Resolves against the current language at call time; captured once, at attach. */
  t: TFunction;
}): RecallRuntime =>
  createRecallEventRuntime({
    apply: ({ parameters }, { models, owner, projectId }) =>
      executeRecallParameters({
        commands,
        t,
        getGenerateValues: () => {
          const project = queries.getProject(projectId);
          return project ? getProjectWidgetValues(project, 'generate') : null;
        },
        models,
        owner,
        parameters,
        projectId,
      }),
    area: 'recall-parameters',
    commands,
    eventName: 'recall_parameters_updated',
    getSessionUserId,
    hub,
    isEvent: isRecallParametersUpdatedEvent,
    queries,
    replay,
  });
