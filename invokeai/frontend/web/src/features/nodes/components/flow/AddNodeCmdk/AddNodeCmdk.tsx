import type { SystemStyleObject } from '@invoke-ai/ui-library';
import {
  Box,
  Button,
  Flex,
  Icon,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalOverlay,
  Spacer,
  Text,
} from '@invoke-ai/ui-library';
import { useStore } from '@nanostores/react';
import type { EdgeChange, NodeChange } from '@xyflow/react';
import { useAppSelector, useAppStore } from 'app/store/storeHooks';
import { CommandEmpty, CommandItem, CommandList, CommandRoot } from 'cmdk';
import { IAINoContentFallback } from 'common/components/IAIImageFallback';
import ScrollableContent from 'common/components/OverlayScrollbars/ScrollableContent';
import { capitalize } from 'es-toolkit';
import { memoize } from 'es-toolkit/compat';
import { useBuildNode } from 'features/nodes/hooks/useBuildNode';
import {
  $addNodeCmdk,
  $cursorPos,
  $edgePendingUpdate,
  $pendingConnection,
  $templates,
  edgesChanged,
  nodesChanged,
} from 'features/nodes/store/nodesSlice';
import { selectNodesSlice } from 'features/nodes/store/selectors';
import type { PendingConnection, Templates } from 'features/nodes/store/types';
import { resolvePendingConnectionSource } from 'features/nodes/store/util/connectorTopology';
import { findUnoccupiedPosition } from 'features/nodes/store/util/findUnoccupiedPosition';
import { getFirstValidConnection } from 'features/nodes/store/util/getFirstValidConnection';
import { createLoopBodyIdentity, getLoopBodyIdentity } from 'features/nodes/store/util/loopIdentity';
import { connectionToEdge } from 'features/nodes/store/util/reactFlowUtil';
import { validateConnectionTypes } from 'features/nodes/store/util/validateConnectionTypes';
import { selectShouldGroupNodesByCategory } from 'features/nodes/store/workflowSettingsSlice';
import type { AnyEdge, AnyNode, InvocationTemplate } from 'features/nodes/types/invocation';
import { isInvocationNode } from 'features/nodes/types/invocation';
import { useRegisteredHotkeys } from 'features/system/components/HotkeysModal/useHotkeyData';
import { toast } from 'features/toast/toast';
import { selectActiveTab } from 'features/ui/store/uiSelectors';
import { computed } from 'nanostores';
import type { ChangeEvent, Dispatch, SetStateAction } from 'react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PiCaretDownBold,
  PiCaretRightBold,
  PiCircuitryBold,
  PiFlaskBold,
  PiHammerBold,
  PiLightningFill,
} from 'react-icons/pi';
import type { S } from 'services/api/types';
import { useDebounce } from 'use-debounce';

const useAddNode = () => {
  const { t } = useTranslation();
  const store = useAppStore();
  const buildInvocation = useBuildNode();
  const templates = useStore($templates);
  const pendingConnection = useStore($pendingConnection);

  const addNode = useCallback(
    (nodeType: string): void => {
      const node = buildInvocation(nodeType);
      if (!node) {
        const errorMessage = t('nodes.unknownNode', {
          nodeType: nodeType,
        });
        toast({
          status: 'error',
          title: errorMessage,
        });
        return;
      }

      // Find a cozy spot for the node
      const cursorPos = $cursorPos.get();
      const { nodes, edges } = selectNodesSlice(store.getState());
      node.position = findUnoccupiedPosition(nodes, cursorPos?.x ?? node.position.x, cursorPos?.y ?? node.position.y);
      node.selected = true;

      const forReturnBodyIdentity =
        isInvocationNode(node) && node.data.type === 'for_return'
          ? getForReturnBodyIdentity(pendingConnection, nodes, edges, templates)
          : null;

      // Deselect all other nodes and edges
      const nodeChanges: NodeChange<AnyNode>[] = [{ type: 'add', item: node }];
      if (forReturnBodyIdentity) {
        const sourceNode = nodes.find((candidate) => candidate.id === forReturnBodyIdentity.sourceNodeId);
        const sourceBodyIdInput =
          sourceNode && isInvocationNode(sourceNode) ? sourceNode.data.inputs.body_id : undefined;
        const returnBodyIdInput = isInvocationNode(node) ? node.data.inputs.body_id : undefined;
        if (sourceNode && isInvocationNode(sourceNode) && sourceBodyIdInput && returnBodyIdInput) {
          returnBodyIdInput.value = forReturnBodyIdentity.bodyId;
          nodeChanges.unshift({
            type: 'replace',
            id: sourceNode.id,
            item: {
              ...sourceNode,
              data: {
                ...sourceNode.data,
                inputs: {
                  ...sourceNode.data.inputs,
                  body_id: { ...sourceBodyIdInput, value: forReturnBodyIdentity.bodyId },
                },
              },
            },
          });
        }
      }
      const edgeChanges: EdgeChange<AnyEdge>[] = [];
      nodes.forEach(({ id, selected }) => {
        if (selected) {
          nodeChanges.push({ type: 'select', id, selected: false });
        }
      });
      edges.forEach(({ id, selected }) => {
        if (selected) {
          edgeChanges.push({ type: 'select', id, selected: false });
        }
      });

      // Onwards!
      if (nodeChanges.length > 0) {
        store.dispatch(nodesChanged(nodeChanges));
      }
      if (edgeChanges.length > 0) {
        store.dispatch(edgesChanged(edgeChanges));
      }

      // Auto-connect an edge if we just added a node and have a pending connection
      if (pendingConnection && isInvocationNode(node)) {
        const edgePendingUpdate = $edgePendingUpdate.get();
        const { handleType } = pendingConnection;

        const source = handleType === 'source' ? pendingConnection.nodeId : node.id;
        const sourceHandle = handleType === 'source' ? pendingConnection.handleId : null;
        const target = handleType === 'target' ? pendingConnection.nodeId : node.id;
        const targetHandle = handleType === 'target' ? pendingConnection.handleId : null;

        const { nodes, edges } = selectNodesSlice(store.getState());
        const connection = getFirstValidConnection(
          source,
          sourceHandle,
          target,
          targetHandle,
          nodes,
          edges,
          templates,
          edgePendingUpdate
        );
        if (connection) {
          const newEdge = connectionToEdge(connection);
          store.dispatch(edgesChanged([{ type: 'add', item: newEdge }]));
        }
      }
    },
    [buildInvocation, pendingConnection, store, t, templates]
  );

  return addNode;
};

const cmdkRootSx: SystemStyleObject = {
  '[cmdk-root]': {
    w: 'full',
    h: 'full',
  },
  '[cmdk-list]': {
    w: 'full',
    h: 'full',
  },
};

export const AddNodeCmdk = memo(() => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const addNode = useAddNode();
  const tab = useAppSelector(selectActiveTab);
  // Filtering the list is expensive - debounce the search term to avoid stutters
  const [debouncedSearchTerm] = useDebounce(searchTerm, 300);
  const isOpen = useStore($addNodeCmdk);
  const open = useCallback(() => {
    $addNodeCmdk.set(true);
  }, []);
  const close = useCallback(() => {
    $addNodeCmdk.set(false);
  }, []);

  useRegisteredHotkeys({
    id: 'addNode',
    category: 'workflows',
    callback: open,
    options: { enabled: tab === 'workflows', preventDefault: true },
    dependencies: [open, tab],
  });

  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());

  const onChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value);
  }, []);

  const onClose = useCallback(() => {
    close();
    setSearchTerm('');
    setExpandedCategories(new Set());
    $pendingConnection.set(null);
  }, [close]);

  const toggleCategory = useCallback((category: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }, []);

  const onSelect = useCallback(
    (value: string) => {
      // Category headers have a special prefix
      if (value.startsWith('__category__:')) {
        const category = value.slice('__category__:'.length);
        toggleCategory(category);
        return;
      }
      addNode(value);
      onClose();
    },
    [addNode, onClose, toggleCategory]
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} useInert={false} initialFocusRef={inputRef} size="xl" isCentered>
      <ModalOverlay />
      <ModalContent h="512" maxH="70%">
        <ModalBody p={2} h="full" sx={cmdkRootSx}>
          <CommandRoot loop shouldFilter={false}>
            <Flex flexDir="column" h="full" gap={2}>
              <Input ref={inputRef} value={searchTerm} onChange={onChange} placeholder={t('nodes.nodeSearch')} />
              <Box w="full" h="full">
                <ScrollableContent>
                  <CommandEmpty>
                    <IAINoContentFallback
                      position="absolute"
                      top={0}
                      right={0}
                      bottom={0}
                      left={0}
                      icon={null}
                      label={t('common.noMatchingItems')}
                    />
                  </CommandEmpty>
                  <CommandList>
                    <NodeCommandList
                      searchTerm={debouncedSearchTerm}
                      onSelect={onSelect}
                      expandedCategories={expandedCategories}
                      setExpandedCategories={setExpandedCategories}
                    />
                  </CommandList>
                </ScrollableContent>
              </Box>
            </Flex>
          </CommandRoot>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
});

AddNodeCmdk.displayName = 'AddNodeCmdk';

const cmdkItemSx: SystemStyleObject = {
  '&[data-selected="true"]': {
    bg: 'base.700',
  },
};

type NodeCommandItemData = {
  value: string;
  label: string;
  description: string;
  classification: S['Classification'];
  nodePack: string;
  category: string;
};

/**
 * An array of all templates, excluding deprecated ones.
 */
const $templatesArray = computed($templates, (templates) =>
  Object.values(templates).filter((template) => template.classification !== 'deprecated')
);

const createRegex = memoize(
  (inputValue: string) =>
    new RegExp(
      inputValue
        .trim()
        .replace(/[-[\]{}()*+!<=:?./\\^$|#,]/g, '')
        .split(' ')
        .join('.*'),
      'gi'
    )
);

// Filterable items are a subset of Invocation template - we also want to filter for notes or current image node,
// so we are using a less specific type instead of `InvocationTemplate`
type FilterableItem = {
  type: string;
  title: string;
  description: string;
  tags: string[];
  classification: S['Classification'];
  nodePack: string;
  category: string;
};

const filter = memoize(
  (item: FilterableItem, searchTerm: string) => {
    const regex = createRegex(searchTerm);

    if (!searchTerm) {
      return true;
    }

    if (item.title.includes(searchTerm) || regex.test(item.title)) {
      return true;
    }

    if (item.type.includes(searchTerm) || regex.test(item.type)) {
      return true;
    }

    if (item.description.includes(searchTerm) || regex.test(item.description)) {
      return true;
    }

    if (item.nodePack.includes(searchTerm) || regex.test(item.nodePack)) {
      return true;
    }

    if (item.classification.includes(searchTerm) || regex.test(item.classification)) {
      return true;
    }

    if (item.category.includes(searchTerm) || regex.test(item.category)) {
      return true;
    }

    for (const tag of item.tags) {
      if (tag.includes(searchTerm) || regex.test(tag)) {
        return true;
      }
    }

    return false;
  },
  (item: FilterableItem, searchTerm: string) => `${item.type}-${searchTerm}`
);

type PendingConnectionContext = {
  nodes: AnyNode[];
  edges: AnyEdge[];
  templates: Templates;
};

const isForIterationOutputConnection = (
  pendingConnection: PendingConnection | null,
  context?: PendingConnectionContext
) => {
  if (!pendingConnection || pendingConnection.handleType !== 'source') {
    return false;
  }

  const resolvedSource = context
    ? resolvePendingConnectionSource(pendingConnection, context.nodes, context.edges, context.templates)
    : null;
  if (resolvedSource && context) {
    const sourceNode = context.nodes.find((node) => node.id === resolvedSource.nodeId);
    return (
      isInvocationNode(sourceNode) &&
      sourceNode.data.type === 'for' &&
      (resolvedSource.outputScope === 'iteration' ||
        (resolvedSource.nodeId === pendingConnection.nodeId &&
          pendingConnection.fieldTemplate.fieldKind === 'output' &&
          pendingConnection.fieldTemplate.output_scope === 'iteration'))
    );
  }

  return (
    pendingConnection.fieldTemplate.fieldKind === 'output' &&
    pendingConnection.fieldTemplate.output_scope === 'iteration'
  );
};

export const getForReturnBodyIdentity = (
  pendingConnection: PendingConnection | null,
  nodes: AnyNode[],
  edges: AnyEdge[] = [],
  templates?: Templates
): { sourceNodeId: string; bodyId: string } | null => {
  if (!pendingConnection || pendingConnection.handleType !== 'source') {
    return null;
  }

  const pendingSource = nodes.find((node) => node.id === pendingConnection.nodeId);
  const resolvedSource = resolvePendingConnectionSource(pendingConnection, nodes, edges, templates);
  const sourceNode = resolvedSource ? nodes.find((node) => node.id === resolvedSource.nodeId) : pendingSource;
  if (!isInvocationNode(sourceNode) || sourceNode.data.type !== 'for') {
    return null;
  }

  const isIterationOutput = resolvedSource
    ? resolvedSource.outputScope === 'iteration' ||
      (resolvedSource.nodeId === pendingConnection.nodeId && isForIterationOutputConnection(pendingConnection))
    : isForIterationOutputConnection(pendingConnection);
  if (!isIterationOutput) {
    return null;
  }

  const bodyId = getLoopBodyIdentity(sourceNode);
  return {
    sourceNodeId: sourceNode.id,
    bodyId: bodyId ?? createLoopBodyIdentity(),
  };
};

export const getPendingConnectionNodeItems = (
  templatesArray: InvocationTemplate[],
  pendingConnection: PendingConnection,
  searchTerm: string,
  context?: PendingConnectionContext
): NodeCommandItemData[] => {
  const items: NodeCommandItemData[] = [];

  for (const template of templatesArray) {
    if (!filter(template, searchTerm)) {
      continue;
    }

    const candidateFields = pendingConnection.handleType === 'source' ? template.inputs : template.outputs;
    for (const fieldTemplate of Object.values(candidateFields)) {
      const sourceType =
        pendingConnection.handleType === 'source' ? pendingConnection.fieldTemplate.type : fieldTemplate.type;
      const targetType =
        pendingConnection.handleType === 'target' ? pendingConnection.fieldTemplate.type : fieldTemplate.type;

      if (validateConnectionTypes(sourceType, targetType)) {
        items.push({
          label: template.title,
          value: template.type,
          description: template.description,
          classification: template.classification,
          nodePack: template.nodePack,
          category: template.category,
        });
        break;
      }
    }
  }

  return sortNodeCommandItems(items, searchTerm, pendingConnection, context);
};

export const sortNodeCommandItems = (
  items: NodeCommandItemData[],
  searchTerm: string,
  pendingConnection: PendingConnection | null,
  context?: PendingConnectionContext
): NodeCommandItemData[] => {
  const sortedItems = [...items];
  const shouldPromoteForReturn = isForIterationOutputConnection(pendingConnection, context);
  const lowerSearch = searchTerm.toLowerCase();

  sortedItems.sort((a, b) => {
    // Contextual ForReturn priority is a hard first key, including when For is an exact title match.
    if (shouldPromoteForReturn) {
      if (a.value === 'for_return' && b.value !== 'for_return') {
        return -1;
      }
      if (a.value !== 'for_return' && b.value === 'for_return') {
        return 1;
      }
    }

    if (searchTerm) {
      const aExact = a.label.toLowerCase() === lowerSearch;
      const bExact = b.label.toLowerCase() === lowerSearch;
      if (aExact && !bExact) {
        return -1;
      }
      if (!aExact && bExact) {
        return 1;
      }
    }

    return 0;
  });

  return sortedItems;
};

const categoryItemSx: SystemStyleObject = {
  cursor: 'pointer',
  userSelect: 'none',
  '&[data-selected="true"]': {
    bg: 'base.750',
  },
};

const NodeCommandItem = memo(
  ({
    item,
    onSelect,
    isGrouped,
  }: {
    item: NodeCommandItemData;
    onSelect: (value: string) => void;
    isGrouped?: boolean;
  }) => (
    <CommandItem value={item.value} onSelect={onSelect} asChild>
      <Flex role="button" flexDir="column" sx={cmdkItemSx} py={1} px={2} ps={isGrouped ? 6 : 2} borderRadius="base">
        <Flex alignItems="center" gap={2}>
          {item.classification === 'beta' && <Icon boxSize={4} color="invokeYellow.300" as={PiHammerBold} />}
          {item.classification === 'prototype' && <Icon boxSize={4} color="invokeRed.300" as={PiFlaskBold} />}
          {item.classification === 'internal' && <Icon boxSize={4} color="invokePurple.300" as={PiCircuitryBold} />}
          {item.classification === 'special' && <Icon boxSize={4} color="invokeGreen.300" as={PiLightningFill} />}
          <Text fontWeight="semibold">{item.label}</Text>
          <Spacer />
          <Text variant="subtext" fontWeight="semibold">
            {item.nodePack}
          </Text>
        </Flex>
        {item.description && <Text color="base.200">{item.description}</Text>}
      </Flex>
    </CommandItem>
  )
);

NodeCommandItem.displayName = 'NodeCommandItem';

const NodeCommandList = memo(
  ({
    searchTerm,
    onSelect,
    expandedCategories,
    setExpandedCategories,
  }: {
    searchTerm: string;
    onSelect: (value: string) => void;
    expandedCategories: Set<string>;
    setExpandedCategories: Dispatch<SetStateAction<Set<string>>>;
  }) => {
    const { t } = useTranslation();
    const templatesArray = useStore($templatesArray);
    const templates = useStore($templates);
    const pendingConnection = useStore($pendingConnection);
    const { nodes, edges } = useAppSelector(selectNodesSlice);
    const pendingConnectionContext = useMemo<PendingConnectionContext>(
      () => ({ nodes, edges, templates }),
      [nodes, edges, templates]
    );
    const shouldGroupNodesByCategory = useAppSelector(selectShouldGroupNodesByCategory);
    const currentImageFilterItem = useMemo<FilterableItem>(
      () => ({
        type: 'current_image',
        title: t('nodes.currentImage'),
        description: t('nodes.currentImageDescription'),
        tags: ['progress', 'image', 'current'],
        classification: 'stable',
        nodePack: 'invokeai',
        category: 'image',
      }),
      [t]
    );
    const notesFilterItem = useMemo<FilterableItem>(
      () => ({
        type: 'notes',
        title: t('nodes.notes'),
        description: t('nodes.notesDescription'),
        tags: ['notes'],
        classification: 'stable',
        nodePack: 'invokeai',
        category: 'other',
      }),
      [t]
    );

    const items = useMemo<NodeCommandItemData[]>(() => {
      // If we have a connection in progress, we need to filter the node choices
      const _items: NodeCommandItemData[] = [];

      if (!pendingConnection) {
        for (const template of templatesArray) {
          if (filter(template, searchTerm)) {
            _items.push({
              label: template.title,
              value: template.type,
              description: template.description,
              classification: template.classification,
              nodePack: template.nodePack,
              category: template.category,
            });
          }
        }

        for (const item of [currentImageFilterItem, notesFilterItem]) {
          if (filter(item, searchTerm)) {
            _items.push({
              label: item.title,
              value: item.type,
              description: item.description,
              classification: item.classification,
              nodePack: item.nodePack,
              category: item.category,
            });
          }
        }
      } else {
        _items.push(
          ...getPendingConnectionNodeItems(templatesArray, pendingConnection, searchTerm, pendingConnectionContext)
        );
      }

      return sortNodeCommandItems(_items, searchTerm, pendingConnection, pendingConnectionContext);
    }, [
      pendingConnection,
      templatesArray,
      pendingConnectionContext,
      searchTerm,
      currentImageFilterItem,
      notesFilterItem,
    ]);

    const groupedItems = useMemo(() => {
      const groups: Record<string, NodeCommandItemData[]> = {};
      for (const item of items) {
        const cat = item.category;
        if (!groups[cat]) {
          groups[cat] = [];
        }
        groups[cat].push(item);
      }
      // Sort categories alphabetically, but put "other" last.
      // When searching, prioritize categories that contain an exact title match.
      const lowerSearch = searchTerm.toLowerCase();
      return Object.entries(groups).sort(([a, aItems], [b, bItems]) => {
        if (searchTerm) {
          const aHasExact = aItems.some((item) => item.label.toLowerCase() === lowerSearch);
          const bHasExact = bItems.some((item) => item.label.toLowerCase() === lowerSearch);
          if (aHasExact && !bHasExact) {
            return -1;
          }
          if (!aHasExact && bHasExact) {
            return 1;
          }
        }
        if (a === 'other') {
          return 1;
        }
        if (b === 'other') {
          return -1;
        }
        return a.localeCompare(b);
      });
    }, [items, searchTerm]);

    // When searching, auto-expand all categories; when not searching, use manual state
    const isSearching = searchTerm.length > 0;
    const shouldPromoteForReturn = isForIterationOutputConnection(pendingConnection, pendingConnectionContext);

    const expandAll = useCallback(() => {
      setExpandedCategories(new Set(groupedItems.map(([cat]) => cat)));
    }, [groupedItems, setExpandedCategories]);

    const collapseAll = useCallback(() => {
      setExpandedCategories(new Set());
    }, [setExpandedCategories]);

    if (!shouldGroupNodesByCategory) {
      return (
        <>
          {items.map((item) => (
            <NodeCommandItem key={item.value} item={item} onSelect={onSelect} />
          ))}
        </>
      );
    }

    return (
      <>
        {!isSearching && (
          <Flex gap={1} px={2} pb={1}>
            <Button size="sm" variant="ghost" onClick={expandAll}>
              {t('common.expandAll')}
            </Button>
            <Button size="sm" variant="ghost" onClick={collapseAll}>
              {t('common.collapseAll')}
            </Button>
          </Flex>
        )}
        {groupedItems.map(([category, categoryItems]) => {
          const isExpanded =
            isSearching ||
            expandedCategories.has(category) ||
            (shouldPromoteForReturn && categoryItems.some((item) => item.value === 'for_return'));
          return (
            <Box key={category}>
              <CommandItem value={`__category__:${category}`} onSelect={onSelect} asChild>
                <Flex role="button" alignItems="center" gap={2} px={2} py={1.5} borderRadius="base" sx={categoryItemSx}>
                  <Icon boxSize={3} as={isExpanded ? PiCaretDownBold : PiCaretRightBold} color="base.400" />
                  <Text fontSize="sm" fontWeight="bold" color="base.400">
                    {capitalize(category)}
                  </Text>
                  <Text fontSize="xs" color="base.500">
                    ({categoryItems.length})
                  </Text>
                </Flex>
              </CommandItem>
              {isExpanded &&
                categoryItems.map((item) => (
                  <NodeCommandItem key={item.value} item={item} onSelect={onSelect} isGrouped />
                ))}
            </Box>
          );
        })}
      </>
    );
  }
);

NodeCommandList.displayName = 'CommandListItems';
