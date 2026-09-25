import { getAuthSession } from '@features/identity';
import { useMountEffect } from '@platform/react/useMountEffect';
import { socketHub } from '@platform/transport/socketHub';
import {
  attachRecallParametersRuntime,
  attachVideoRecallRuntime,
} from '@workbench/image-actions/recallParametersBridge';
import { openWorkbenchWidget } from '@workbench/useOpenWorkbenchWidget';
import { useWorkbenchInternalStore } from '@workbench/WorkbenchContext';
import { useWorkbenchWidgetRegistry } from '@workbench/WorkbenchWidgetRegistryContext';
import { useTranslation } from 'react-i18next';

/** Single-user servers tag events with a system user id, so only multi-user sessions can be fenced. */
const getSessionUserId = (): string | null => {
  const session = getAuthSession();
  return session.multiuserEnabled ? (session.user?.user_id ?? null) : null;
};

/**
 * App-owned composition: external `POST /api/v1/recall` updates land in the active project's Generate panel, and
 * `POST /api/v1/recall/video` updates in its Video panel.
 */
export const RecallParametersRuntime = () => {
  const store = useWorkbenchInternalStore();
  const { getWidgetsForRegion } = useWorkbenchWidgetRegistry();
  // Captured once at mount; i18next resolves it against the current language at each call.
  const { t } = useTranslation();

  useMountEffect(() => {
    const recall = attachRecallParametersRuntime({
      commands: store.commands,
      getSessionUserId,
      hub: socketHub,
      queries: store.queries,
      t,
    });
    const videoRecall = attachVideoRecallRuntime({
      commands: store.commands,
      getSessionUserId,
      hub: socketHub,
      openVideoWidget: () => {
        openWorkbenchWidget(store.commands.widgets, getWidgetsForRegion, 'video', { preferredRegions: ['left'] });
      },
      queries: store.queries,
      t,
    });

    return () => {
      recall.dispose();
      videoRecall.dispose();
    };
  });

  return null;
};
