import { $templates } from 'features/nodes/store/nodesSlice';
import type { Templates } from 'features/nodes/store/types';
import { for_loop, for_return } from 'features/nodes/store/util/testUtils';
import type { InvocationTemplate } from 'features/nodes/types/invocation';
import { isWorkflowInvocationNode } from 'features/nodes/types/workflow';
import { buildNodesGraph } from 'features/nodes/util/graph/buildNodesGraph';
import { getOutputFieldNamesByScope } from 'features/nodes/util/node/getOutputFieldNamesByScope';
import { graphToWorkflow } from 'features/nodes/util/workflow/graphToWorkflow';
import type { NonNullableGraph } from 'services/api/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const imageCollectionTemplate = {
  title: 'Image Collection Primitive',
  type: 'image_collection',
  version: '1.0.2',
  tags: ['primitives', 'image', 'collection'],
  description: 'A collection of image primitive values',
  outputType: 'image_collection_output',
  inputs: {
    collection: {
      name: 'collection',
      title: 'Collection',
      required: false,
      description: 'An optional image collection to append to',
      fieldKind: 'input',
      input: 'connection',
      ui_hidden: false,
      type: { name: 'ImageField', cardinality: 'COLLECTION', batch: false },
      default: undefined,
    },
    images: {
      name: 'images',
      title: 'Images',
      required: false,
      description: 'The images to append to the collection',
      fieldKind: 'input',
      input: 'direct',
      ui_hidden: false,
      type: { name: 'ImageField', cardinality: 'COLLECTION', batch: false },
      default: undefined,
    },
  },
  outputs: {
    collection: {
      fieldKind: 'output',
      name: 'collection',
      title: 'Collection',
      description: 'The output images',
      type: { name: 'ImageField', cardinality: 'COLLECTION', batch: false },
      ui_hidden: false,
    },
  },
  useCache: true,
  nodePack: 'invokeai',
  classification: 'stable',
  category: 'primitives',
} satisfies InvocationTemplate;

describe('graphToWorkflow', () => {
  const originalTemplates = $templates.get();
  const loopTemplates: Templates = { for: for_loop, for_return };

  beforeEach(() => {
    $templates.set({ image_collection: imageCollectionTemplate, ...loopTemplates });
  });

  afterEach(() => {
    $templates.set(originalTemplates);
  });

  it('moves legacy image_collection graph collection values to the visible images field', () => {
    const images = [{ image_name: 'legacy.png' }];
    const graph: NonNullableGraph = {
      id: 'graph',
      nodes: {
        image_collection: {
          id: 'image_collection',
          type: 'image_collection',
          collection: images,
        },
      },
      edges: [],
    };

    const workflow = graphToWorkflow(graph, false);
    const node = workflow.nodes[0];

    if (!node || !isWorkflowInvocationNode(node)) {
      throw new Error('Expected an image_collection workflow node');
    }
    expect(node.data.inputs.images?.value).toEqual(images);
    expect(node.data.inputs.collection?.value).toEqual([]);
  });

  it('preserves legacy image_collection graph collection values when collection is connected', () => {
    const images = [{ image_name: 'shadowed.png' }];
    const graph: NonNullableGraph = {
      id: 'graph',
      nodes: {
        source: {
          id: 'source',
          type: 'image_collection',
        },
        target: {
          id: 'target',
          type: 'image_collection',
          collection: images,
        },
      },
      edges: [
        {
          source: { node_id: 'source', field: 'collection' },
          destination: { node_id: 'target', field: 'collection' },
        },
      ],
    };

    const workflow = graphToWorkflow(graph, false);
    const node = workflow.nodes[1];

    if (!node || !isWorkflowInvocationNode(node)) {
      throw new Error('Expected an image_collection workflow node');
    }
    expect(node.data.inputs.images?.value).toBeUndefined();
    expect(node.data.inputs.collection?.value).toEqual(images);
  });

  it('round-trips For and ForReturn nodes and resolves scoped outputs from their templates', () => {
    const graph = {
      id: 'graph',
      nodes: {
        for: {
          id: 'for',
          type: 'for',
          collection: ['alpha', 'beta'],
          state: null,
          index: -1,
        },
        return: {
          id: 'return',
          type: 'for_return',
          output: null,
          state: null,
        },
      },
      edges: [
        {
          source: { node_id: 'for', field: 'item' },
          destination: { node_id: 'return', field: 'output' },
        },
      ],
    } satisfies NonNullableGraph;

    const workflow = graphToWorkflow(graph, false);
    const forNode = workflow.nodes.find((node) => node.id === 'for');
    const returnNode = workflow.nodes.find((node) => node.id === 'return');
    if (!isWorkflowInvocationNode(forNode) || !isWorkflowInvocationNode(returnNode)) {
      throw new Error('Expected For and ForReturn invocation nodes');
    }

    expect(forNode.data.inputs.collection?.value).toEqual(['alpha', 'beta']);
    expect(forNode.data.inputs.state?.value).toBeNull();
    expect(forNode.data.inputs.index?.value).toBe(-1);
    expect(returnNode.data.inputs.state?.value).toBeNull();
    expect(workflow.edges).toHaveLength(1);
    expect(workflow.edges[0]).toMatchObject({
      source: 'for',
      sourceHandle: 'item',
      target: 'return',
      targetHandle: 'output',
    });
    expect(getOutputFieldNamesByScope(Object.values(for_loop.outputs))).toEqual({
      all: ['item', 'index', 'total', 'state', 'output_collection', 'final_state'],
      unscoped: [],
      iteration: ['item', 'index', 'total', 'state'],
      final: ['output_collection', 'final_state'],
    });

    const rootState = {
      nodes: {
        past: [],
        future: [],
        present: {
          _version: 1,
          formFieldInitialValues: {},
          ...workflow,
        },
      },
      gallery: {
        autoAddBoardId: 'none',
      },
    } as never;
    const rebuiltGraph = buildNodesGraph(rootState, loopTemplates);

    expect(rebuiltGraph.nodes.for).toMatchObject({
      type: 'for',
      collection: ['alpha', 'beta'],
      state: null,
      index: -1,
    });
    expect(rebuiltGraph.nodes.return).toMatchObject({
      type: 'for_return',
      state: null,
    });
    expect(rebuiltGraph.edges).toEqual(graph.edges);
  });
});
