import type { SettingFieldProps } from '@platform/ui/settings/contracts';

import { Box } from '@chakra-ui/react';
import { useAuthSession, useCapabilities } from '@features/identity';

import { IntermediatesManager } from './IntermediatesManager';

/** The Settings section body: a filling editor that owns its own scrolling. */
export const IntermediatesSettingsField = (_props: SettingFieldProps) => {
  const session = useAuthSession();
  const { canClearOthersIntermediates } = useCapabilities();
  const currentUserId = session.phase === 'ready' ? (session.user?.user_id ?? null) : null;

  return (
    <Box display="flex" flex="1" flexDirection="column" minH="0">
      <IntermediatesManager canClearOthersIntermediates={canClearOthersIntermediates} currentUserId={currentUserId} />
    </Box>
  );
};
