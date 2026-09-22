/* eslint-disable react-perf/jsx-no-jsx-as-prop */
import type { ProjectRecordDTO } from '@workbench/projects/api';

import { Skeleton, Stack, Text } from '@chakra-ui/react';
import { useAuthSession, useCapabilities } from '@features/identity';
import { LAUNCHPAD_READY_MARK, markSemanticReady } from '@platform/performance/semanticReady';
import { useMountEffect } from '@platform/react/useMountEffect';
import { captureAccountScope, isAccountScopeCurrent } from '@platform/state/accountLifecycle';
import { Button } from '@platform/ui';
import { PageShell } from '@platform/ui/PageShell';
import { useNavigate } from '@tanstack/react-router';
import { IntentTiles } from '@workbench/launchpad/home/IntentTiles';
import { LivePanel } from '@workbench/launchpad/home/LivePanel';
import { RecentProjectsRow } from '@workbench/launchpad/home/RecentProjectsRow';
import { ResumeCard } from '@workbench/launchpad/home/ResumeCard';
import { KnownBrowserIssuesAlert } from '@workbench/launchpad/KnownBrowserIssuesAlert';
import { NewProjectButton } from '@workbench/launchpad/projects/NewProjectButton';
import { prunePinnedProjects, toggleProjectPinPreference } from '@workbench/launchpad/projects/projectPins';
import { getProjectLibrary, refreshProjectLibrary, useProjectLibrarySelector } from '@workbench/projects/library';
import { refreshOpenProjects } from '@workbench/projects/openProjects';
import { useImportProjectFile } from '@workbench/projects/useProjectFileActions';
import { useWorkbenchPreferenceSelector } from '@workbench/settings/store';
import { FileUpIcon } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const RECENT_PROJECT_COUNT = 4;
const BROWSER_ISSUES_BANNER = <KnownBrowserIssuesAlert />;

export const HomePage = () => {
  const session = useAuthSession();
  const { canManageModels } = useCapabilities();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const status = useProjectLibrarySelector((snapshot) => snapshot.status);
  const summaries = useProjectLibrarySelector((snapshot) => snapshot.summaries);
  const pinnedIds = useWorkbenchPreferenceSelector((preferences) => preferences.launchpadPinnedProjectIds);

  useMountEffect(() => {
    const owner = captureAccountScope();

    void refreshOpenProjects();
    void refreshProjectLibrary().then(() => {
      if (isAccountScopeCurrent(owner)) {
        prunePinnedProjects(getProjectLibrary().summaries);
        markSemanticReady(LAUNCHPAD_READY_MARK);
      }
    });
  });

  const displayName = session.user?.display_name?.trim();
  const greeting = displayName
    ? t('launchpad.projectsGreetingWithName', { name: displayName })
    : t('launchpad.projectsGreeting');

  const openImportedProject = useCallback(
    async (record: ProjectRecordDTO) => {
      await navigate({ search: { project: record.project_id }, to: '/app' });
    },
    [navigate]
  );
  const handleImportClick = useImportProjectFile(openImportedProject);

  const isFirstLoad = summaries.length === 0 && (status === 'idle' || status === 'loading');
  const [mostRecent, ...rest] = summaries;

  return (
    <PageShell
      actions={
        <>
          <Button size="xs" variant="outline" onClick={handleImportClick}>
            <FileUpIcon />
            {t('projects.importWithEllipsis')}
          </Button>
          <NewProjectButton />
        </>
      }
      banner={BROWSER_ISSUES_BANNER}
      regionLabel={t('launchpad.sections.home')}
      title={greeting}
    >
      {/*
       * Order panels by urgency. Gate model-panel mounting by capability because its catalog/install endpoints are
       * admin-only; empty panels render nothing.
       */}
      {canManageModels ? <LivePanel panel="models" /> : null}
      <LivePanel panel="queue" />

      {isFirstLoad ? (
        <Skeleton minH="24" rounded="lg" />
      ) : mostRecent ? (
        <ResumeCard
          isPinned={pinnedIds.includes(mostRecent.id)}
          summary={mostRecent}
          onTogglePin={toggleProjectPinPreference}
        />
      ) : null}

      <Stack gap="3">
        <Text fontSize="xs" fontWeight="700">
          {t('launchpad.home.intents.heading')}
        </Text>
        <IntentTiles />
      </Stack>

      <RecentProjectsRow
        pinnedIds={pinnedIds}
        summaries={rest.slice(0, RECENT_PROJECT_COUNT)}
        onTogglePin={toggleProjectPinPreference}
      />

      <LivePanel panel="outputs" />
    </PageShell>
  );
};
