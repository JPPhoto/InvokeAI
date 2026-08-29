import { Flex, Text } from '@chakra-ui/react';
import { Button } from '@platform/ui';
import { collectSubtreeLeaves, getDocumentNode } from '@workbench/canvas-engine/api';
import { useCanvasProjectMutationDispatch } from '@workbench/useCanvasProjectMutationDispatch';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/** Leaf tools and editors cannot act on a group: name the way out instead of silently refusing. */
export const GroupSelectedNotice = ({ hint }: { hint?: string }) => {
  const { t } = useTranslation();
  const dispatch = useCanvasProjectMutationDispatch();
  const group = useActiveProjectSelector(
    (project) => {
      const { document } = project.canvas;
      const node = getDocumentNode(document, document.selectedLayerId);
      return node?.type === 'group' ? { firstLeafId: collectSubtreeLeaves(node)[0]?.id ?? null, id: node.id } : null;
    },
    (a, b) => a?.id === b?.id && a?.firstLeafId === b?.firstLeafId
  );
  const selectFirstLeaf = useCallback(() => {
    if (group?.firstLeafId) {
      dispatch({ id: group.firstLeafId, type: 'setCanvasSelectedLayer' });
    }
  }, [dispatch, group]);

  if (!group) {
    return null;
  }
  return (
    <Flex align="center" gap="2">
      <Text color="fg.muted" fontSize="xs" minW="0">
        {hint ?? t('widgets.layers.groupSelectedHint')}
      </Text>
      {group.firstLeafId ? (
        <Button flexShrink={0} size="2xs" variant="subtle" onClick={selectFirstLeaf}>
          {t('widgets.layers.actions.selectFirstChild')}
        </Button>
      ) : null}
    </Flex>
  );
};
