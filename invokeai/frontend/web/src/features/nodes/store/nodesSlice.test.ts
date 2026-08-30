import { deepClone } from 'common/util/deepClone';
import type { IntegerFieldInputTemplate, StringFieldInputTemplate } from 'features/nodes/types/field';
import { buildNodeFieldElement } from 'features/nodes/types/workflow';
import { buildConnectorNode } from 'features/nodes/util/node/buildConnectorNode';
import { describe, expect, it } from 'vitest';

import {
  callSavedWorkflowDynamicFieldsChanged,
  connectorInserted,
  edgesChanged,
  fieldIntegerValueChanged,
  fieldStringValueChanged,
  fieldValueReset,
  nodeIsOpenChanged,
  nodesChanged,
  nodesSliceConfig,
} from './nodesSlice';
import { CONNECTOR_INPUT_HANDLE, CONNECTOR_OUTPUT_HANDLE } from './util/connectorTopology';
import {
  add,
  buildEdge,
  buildLoopLinkageEdge,
  buildNode,
  for_loop,
  for_return,
  sub,
  templates,
} from './util/testUtils';

const callSavedWorkflowTemplate = templates.call_saved_workflow;
const addTemplate = templates.add;

if (!callSavedWorkflowTemplate || !addTemplate || !addTemplate.inputs.a) {
  throw new Error('Expected saved workflow and add templates');
}
const addIntegerInputTemplate = addTemplate.inputs.a as IntegerFieldInputTemplate;

const buildDynamicIntegerTemplate = (fieldName: string): IntegerFieldInputTemplate => ({
  ...addIntegerInputTemplate,
  name: fieldName,
  title: 'Left Addend',
  input: 'any' as const,
});

const buildDynamicStringTemplate = (fieldName: string): StringFieldInputTemplate => ({
  name: fieldName,
  title: 'Prompt',
  required: false,
  description: 'Prompt text',
  fieldKind: 'input',
  input: 'any',
  ui_hidden: false,
  default: 'new default',
  type: {
    name: 'StringField',
    cardinality: 'SINGLE',
    batch: false,
  },
});

const buildFixedConnectorNode = (id: string) => {
  const connectorNode = buildConnectorNode({ x: 0, y: 0 });
  return {
    ...connectorNode,
    id,
    data: {
      ...connectorNode.data,
      id,
    },
  };
};

describe('callSavedWorkflowDynamicFieldsChanged', () => {
  it('seeds new dynamic fields with the source workflow values', () => {
    const state = nodesSliceConfig.getInitialState();
    const node = buildNode(callSavedWorkflowTemplate);
    state.nodes.push(node);

    const nextState = nodesSliceConfig.slice.reducer(
      state,
      callSavedWorkflowDynamicFieldsChanged({
        nodeId: node.id,
        fields: [
          {
            fieldName: 'saved_workflow_input::node-1::a',
            fieldTemplate: buildDynamicIntegerTemplate('saved_workflow_input::node-1::a'),
            label: 'Left Addend',
            description: 'The first number',
            initialValue: 23,
          },
        ],
        edgeIdsToRemove: [],
      })
    );

    const dynamicField = nextState.nodes[0];
    if (!dynamicField || dynamicField.type !== 'invocation') {
      throw new Error('Expected invocation node');
    }

    expect(dynamicField.data.inputs['saved_workflow_input::node-1::a']?.value).toBe(23);
    expect(dynamicField.data.inputs['saved_workflow_input::node-1::a']?.label).toBe('Left Addend');
    expect(dynamicField.data.dynamicInputTemplates['saved_workflow_input::node-1::a']?.title).toBe('Left Addend');
  });

  it('preserves existing dynamic field values on resync', () => {
    const state = nodesSliceConfig.getInitialState();
    const node = buildNode(callSavedWorkflowTemplate);
    state.nodes.push(node);

    const fieldName = 'saved_workflow_input::node-1::a';

    let nextState = nodesSliceConfig.slice.reducer(
      state,
      callSavedWorkflowDynamicFieldsChanged({
        nodeId: node.id,
        fields: [
          {
            fieldName,
            fieldTemplate: buildDynamicIntegerTemplate(fieldName),
            label: 'Left Addend',
            description: 'The first number',
            initialValue: 23,
          },
        ],
        edgeIdsToRemove: [],
      })
    );

    nextState = nodesSliceConfig.slice.reducer(
      nextState,
      fieldIntegerValueChanged({
        nodeId: node.id,
        fieldName,
        value: 99,
      })
    );

    nextState = nodesSliceConfig.slice.reducer(
      nextState,
      callSavedWorkflowDynamicFieldsChanged({
        nodeId: node.id,
        fields: [
          {
            fieldName,
            fieldTemplate: buildDynamicIntegerTemplate(fieldName),
            label: 'Left Addend',
            description: 'The first number',
            initialValue: 23,
          },
        ],
        edgeIdsToRemove: [],
      })
    );

    const resyncedNode = nextState.nodes[0];
    if (!resyncedNode || resyncedNode.type !== 'invocation') {
      throw new Error('Expected invocation node');
    }

    expect(resyncedNode.data.inputs[fieldName]?.value).toBe(99);
    expect(resyncedNode.data.dynamicInputTemplates[fieldName]?.name).toBe(fieldName);
  });

  it('resets an existing dynamic field value when the exposed field type changes', () => {
    const state = nodesSliceConfig.getInitialState();
    const node = buildNode(callSavedWorkflowTemplate);
    state.nodes.push(node);

    const fieldName = 'saved_workflow_input::node-1::a';

    let nextState = nodesSliceConfig.slice.reducer(
      state,
      callSavedWorkflowDynamicFieldsChanged({
        nodeId: node.id,
        fields: [
          {
            fieldName,
            fieldTemplate: buildDynamicIntegerTemplate(fieldName),
            label: 'Left Addend',
            description: 'The first number',
            initialValue: 23,
          },
        ],
        edgeIdsToRemove: [],
      })
    );

    nextState = nodesSliceConfig.slice.reducer(
      nextState,
      fieldIntegerValueChanged({
        nodeId: node.id,
        fieldName,
        value: 99,
      })
    );

    nextState = nodesSliceConfig.slice.reducer(
      nextState,
      callSavedWorkflowDynamicFieldsChanged({
        nodeId: node.id,
        fields: [
          {
            fieldName,
            fieldTemplate: buildDynamicStringTemplate(fieldName),
            label: 'Prompt',
            description: 'Prompt text',
            initialValue: 'new default',
          },
        ],
        edgeIdsToRemove: [],
      })
    );

    const resyncedNode = nextState.nodes[0];
    if (!resyncedNode || resyncedNode.type !== 'invocation') {
      throw new Error('Expected invocation node');
    }

    expect(resyncedNode.data.inputs[fieldName]?.value).toBe('new default');
    expect(resyncedNode.data.dynamicInputTemplates[fieldName]?.type.name).toBe('StringField');
  });

  it('removes stale dynamic field templates when the selected workflow fields change', () => {
    const state = nodesSliceConfig.getInitialState();
    const node = buildNode(callSavedWorkflowTemplate);
    state.nodes.push(node);

    const fieldName = 'saved_workflow_input::node-1::a';

    let nextState = nodesSliceConfig.slice.reducer(
      state,
      callSavedWorkflowDynamicFieldsChanged({
        nodeId: node.id,
        fields: [
          {
            fieldName,
            fieldTemplate: buildDynamicIntegerTemplate(fieldName),
            label: 'Left Addend',
            description: 'The first number',
            initialValue: 23,
          },
        ],
        edgeIdsToRemove: [],
      })
    );

    nextState = nodesSliceConfig.slice.reducer(
      nextState,
      callSavedWorkflowDynamicFieldsChanged({
        nodeId: node.id,
        fields: [],
        edgeIdsToRemove: [],
      })
    );

    const resyncedNode = nextState.nodes[0];
    if (!resyncedNode || resyncedNode.type !== 'invocation') {
      throw new Error('Expected invocation node');
    }

    expect(resyncedNode.data.inputs[fieldName]).toBeUndefined();
    expect(resyncedNode.data.dynamicInputTemplates[fieldName]).toBeUndefined();
  });

  it('removes specified inbound edges during dynamic field resync', () => {
    const state = nodesSliceConfig.getInitialState();
    const sourceNode = buildNode(addTemplate);
    const targetNode = buildNode(callSavedWorkflowTemplate);
    state.nodes.push(sourceNode, targetNode);
    state.edges.push({
      id: 'edge-1',
      type: 'default',
      source: sourceNode.id,
      sourceHandle: 'value',
      target: targetNode.id,
      targetHandle: 'saved_workflow_input::node-1::a',
    });

    const nextState = nodesSliceConfig.slice.reducer(
      state,
      callSavedWorkflowDynamicFieldsChanged({
        nodeId: targetNode.id,
        fields: [],
        edgeIdsToRemove: ['edge-1'],
      })
    );

    expect(nextState.edges).toHaveLength(0);
  });

  it('clears dynamic fields and inbound dynamic field edges when the selected workflow is cleared', () => {
    const state = nodesSliceConfig.getInitialState();
    const sourceNode = buildNode(addTemplate);
    const targetNode = buildNode(callSavedWorkflowTemplate);
    const workflowIdInput = targetNode.data.inputs.workflow_id;
    if (!workflowIdInput) {
      throw new Error('Expected workflow_id input');
    }
    workflowIdInput.value = 'workflow-1';
    state.nodes.push(sourceNode, targetNode);

    const fieldName = 'saved_workflow_input::node-1::a';
    state.edges.push({
      id: 'edge-1',
      type: 'default',
      source: sourceNode.id,
      sourceHandle: 'value',
      target: targetNode.id,
      targetHandle: fieldName,
    });

    let nextState = nodesSliceConfig.slice.reducer(
      state,
      callSavedWorkflowDynamicFieldsChanged({
        nodeId: targetNode.id,
        fields: [
          {
            fieldName,
            fieldTemplate: buildDynamicIntegerTemplate(fieldName),
            label: 'Left Addend',
            description: 'The first number',
            initialValue: 23,
          },
        ],
        edgeIdsToRemove: [],
      })
    );

    nextState = nodesSliceConfig.slice.reducer(
      nextState,
      fieldStringValueChanged({
        nodeId: targetNode.id,
        fieldName: 'workflow_id',
        value: '',
      })
    );

    const clearedNode = nextState.nodes.find((node) => node.id === targetNode.id);
    if (!clearedNode || clearedNode.type !== 'invocation') {
      throw new Error('Expected invocation node');
    }

    expect(clearedNode.data.inputs.workflow_id?.value).toBe('');
    expect(clearedNode.data.inputs[fieldName]).toBeUndefined();
    expect(clearedNode.data.dynamicInputTemplates[fieldName]).toBeUndefined();
    expect(nextState.edges).toHaveLength(0);
  });

  it('clears dynamic fields from the form when the selected workflow is cleared', () => {
    const state = nodesSliceConfig.getInitialState();
    const targetNode = buildNode(callSavedWorkflowTemplate);
    const workflowIdInput = targetNode.data.inputs.workflow_id;
    if (!workflowIdInput) {
      throw new Error('Expected workflow_id input');
    }
    workflowIdInput.value = 'workflow-1';
    state.nodes.push(targetNode);

    const fieldName = 'saved_workflow_input::node-1::a';
    const formElement = buildNodeFieldElement(targetNode.id, fieldName, addIntegerInputTemplate.type);
    state.form.elements[formElement.id] = {
      ...formElement,
      parentId: state.form.rootElementId,
    };
    const rootElement = state.form.elements[state.form.rootElementId];
    if (!rootElement || rootElement.type !== 'container') {
      throw new Error('Expected root container');
    }
    rootElement.data.children.push(formElement.id);
    state.formFieldInitialValues[formElement.id] = 23;

    let nextState = nodesSliceConfig.slice.reducer(
      state,
      callSavedWorkflowDynamicFieldsChanged({
        nodeId: targetNode.id,
        fields: [
          {
            fieldName,
            fieldTemplate: buildDynamicIntegerTemplate(fieldName),
            label: 'Left Addend',
            description: 'The first number',
            initialValue: 23,
          },
        ],
        edgeIdsToRemove: [],
      })
    );

    nextState = nodesSliceConfig.slice.reducer(
      nextState,
      fieldStringValueChanged({
        nodeId: targetNode.id,
        fieldName: 'workflow_id',
        value: '',
      })
    );

    expect(nextState.form.elements[formElement.id]).toBeUndefined();
    expect(nextState.formFieldInitialValues[formElement.id]).toBeUndefined();
    const nextRootElement = nextState.form.elements[nextState.form.rootElementId];
    if (!nextRootElement || nextRootElement.type !== 'container') {
      throw new Error('Expected root container');
    }
    expect(nextRootElement.data.children).not.toContain(formElement.id);
  });

  it('clears dynamic fields when the selected workflow field is reset to empty', () => {
    const state = nodesSliceConfig.getInitialState();
    const sourceNode = buildNode(addTemplate);
    const targetNode = buildNode(callSavedWorkflowTemplate);
    const workflowIdInput = targetNode.data.inputs.workflow_id;
    if (!workflowIdInput) {
      throw new Error('Expected workflow_id input');
    }
    workflowIdInput.value = 'workflow-1';
    state.nodes.push(sourceNode, targetNode);

    const fieldName = 'saved_workflow_input::node-1::a';
    const formElement = buildNodeFieldElement(targetNode.id, fieldName, addIntegerInputTemplate.type);
    state.form.elements[formElement.id] = {
      ...formElement,
      parentId: state.form.rootElementId,
    };
    const rootElement = state.form.elements[state.form.rootElementId];
    if (!rootElement || rootElement.type !== 'container') {
      throw new Error('Expected root container');
    }
    rootElement.data.children.push(formElement.id);
    state.formFieldInitialValues[formElement.id] = 23;
    state.edges.push(buildEdge(sourceNode.id, 'value', targetNode.id, fieldName));

    let nextState = nodesSliceConfig.slice.reducer(
      state,
      callSavedWorkflowDynamicFieldsChanged({
        nodeId: targetNode.id,
        fields: [
          {
            fieldName,
            fieldTemplate: buildDynamicIntegerTemplate(fieldName),
            label: 'Left Addend',
            description: 'The first number',
            initialValue: 23,
          },
        ],
        edgeIdsToRemove: [],
      })
    );

    nextState = nodesSliceConfig.slice.reducer(
      nextState,
      fieldValueReset({
        nodeId: targetNode.id,
        fieldName: 'workflow_id',
        value: '',
      })
    );

    const clearedNode = nextState.nodes.find((node) => node.id === targetNode.id);
    if (!clearedNode || clearedNode.type !== 'invocation') {
      throw new Error('Expected invocation node');
    }
    expect(clearedNode.data.inputs[fieldName]).toBeUndefined();
    expect(nextState.edges).toHaveLength(0);
    expect(nextState.form.elements[formElement.id]).toBeUndefined();
    expect(nextState.formFieldInitialValues[formElement.id]).toBeUndefined();
  });
});

describe('nodesSlice connector actions', () => {
  it('removes an unconnected connector', () => {
    const connector = buildFixedConnectorNode('connector-1');

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [connector];
    initialState.edges = [];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([{ type: 'remove', id: connector.id }])
    );

    expect(nextState.nodes).toEqual([]);
    expect(nextState.edges).toEqual([]);
  });

  it('splits a direct edge into source -> connector -> target edges when inserting a connector', () => {
    const source = buildNode(add);
    const target = buildNode(sub);
    const connector = buildFixedConnectorNode('connector-1');
    const directEdge = buildEdge(source.id, 'value', target.id, 'a');

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [source, target];
    initialState.edges = [directEdge];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      connectorInserted({
        edgeId: directEdge.id,
        connector,
      })
    );

    expect(nextState.nodes.map((node) => node.id)).toEqual([source.id, target.id, connector.id]);
    expect(nextState.edges).toEqual([
      buildEdge(source.id, 'value', connector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, target.id, 'a'),
    ]);
  });

  it('splits a direct loop linkage into a connector alias when inserting a connector', () => {
    const forNode = buildNode(for_loop);
    const returnNode = buildNode(for_return);
    const connector = buildFixedConnectorNode('connector-1');
    const directEdge = buildLoopLinkageEdge(forNode.id, returnNode.id);

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, returnNode];
    initialState.edges = [directEdge];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      connectorInserted({
        edgeId: directEdge.id,
        connector,
      })
    );

    expect(nextState.edges).toEqual([
      buildEdge(forNode.id, 'loop_linkage', connector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage'),
    ]);
  });

  it('splices connector outputs back to the resolved upstream source when removed', () => {
    const source = buildNode(add);
    const target = buildNode(sub);
    const connector = buildFixedConnectorNode('connector-1');

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [source, connector, target];
    initialState.edges = [
      buildEdge(source.id, 'value', connector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, target.id, 'a'),
    ];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([{ type: 'remove', id: connector.id }])
    );

    expect(nextState.nodes.map((node) => node.id)).toEqual([source.id, target.id]);
    expect(nextState.edges).toEqual([buildEdge(source.id, 'value', target.id, 'a')]);
  });

  it('splices one connector source back to multiple downstream targets when removed', () => {
    const source = buildNode(add);
    const targetA = buildNode(sub);
    const targetB = buildNode(sub);
    const connector = buildFixedConnectorNode('connector-1');

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [source, connector, targetA, targetB];
    initialState.edges = [
      buildEdge(source.id, 'value', connector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, targetA.id, 'a'),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, targetB.id, 'b'),
    ];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([{ type: 'remove', id: connector.id }])
    );

    expect(nextState.nodes.map((node) => node.id)).toEqual([source.id, targetA.id, targetB.id]);
    expect(nextState.edges).toEqual([
      buildEdge(source.id, 'value', targetA.id, 'a'),
      buildEdge(source.id, 'value', targetB.id, 'b'),
    ]);
  });

  it('does not create any edges when removing a connector with no downstream targets', () => {
    const source = buildNode(add);
    const connector = buildFixedConnectorNode('connector-1');

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [source, connector];
    initialState.edges = [buildEdge(source.id, 'value', connector.id, CONNECTOR_INPUT_HANDLE)];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([{ type: 'remove', id: connector.id }])
    );

    expect(nextState.nodes.map((node) => node.id)).toEqual([source.id]);
    expect(nextState.edges).toEqual([]);
  });

  it('removes a connector while preserving downstream connector edges in a chained splice case', () => {
    const source = buildNode(add);
    const connectorA = buildFixedConnectorNode('connector-a');
    const connectorB = buildFixedConnectorNode('connector-b');
    const target = buildNode(sub);

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [source, connectorA, connectorB, target];
    initialState.edges = [
      buildEdge(source.id, 'value', connectorA.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connectorA.id, CONNECTOR_OUTPUT_HANDLE, connectorB.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connectorB.id, CONNECTOR_OUTPUT_HANDLE, target.id, 'a'),
    ];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([{ type: 'remove', id: connectorA.id }])
    );

    expect(nextState.nodes.map((node) => node.id)).toEqual([source.id, connectorB.id, target.id]);
    expect(nextState.edges).toHaveLength(2);
    expect(nextState.edges).toEqual(
      expect.arrayContaining([
        buildEdge(source.id, 'value', connectorB.id, CONNECTOR_INPUT_HANDLE),
        buildEdge(connectorB.id, CONNECTOR_OUTPUT_HANDLE, target.id, 'a'),
      ])
    );
  });

  it('splices connector edges when the connector is removed through generic node removal', () => {
    const source = buildNode(add);
    const target = buildNode(sub);
    const connector = buildFixedConnectorNode('connector-1');

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [source, connector, target];
    initialState.edges = [
      buildEdge(source.id, 'value', connector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, target.id, 'a'),
    ];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([{ type: 'remove', id: connector.id }])
    );

    expect(nextState.nodes.map((node) => node.id)).toEqual([source.id, target.id]);
    expect(nextState.edges).toEqual([buildEdge(source.id, 'value', target.id, 'a')]);
  });
});

describe('nodesSlice loop boundary actions', () => {
  it('stores loop linkage as an explicit edge', () => {
    const forNode = buildNode(for_loop);
    const returnNode = buildNode(for_return);
    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, returnNode];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      edgesChanged([{ type: 'add', item: buildLoopLinkageEdge(forNode.id, returnNode.id) }])
    );
    expect(nextState.edges).toEqual([
      expect.objectContaining({
        type: 'loop_linkage',
        source: forNode.id,
        sourceHandle: 'loop_linkage',
        target: returnNode.id,
        targetHandle: 'loop_linkage',
      }),
    ]);
  });

  it('removes loop linkage when either boundary node is removed', () => {
    const oldForNode = buildNode(for_loop);
    const returnNode = buildNode(for_return);

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [oldForNode, returnNode];
    initialState.edges = [buildLoopLinkageEdge(oldForNode.id, returnNode.id)];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([{ type: 'remove', id: oldForNode.id }])
    );
    expect(nextState.edges).toEqual([]);
  });

  it('removes all connector alias edges when a For boundary is removed', () => {
    const forNode = buildNode(for_loop);
    const connector = buildFixedConnectorNode('connector-1');
    const returnNode = buildNode(for_return);

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, connector, returnNode];
    initialState.edges = [
      buildEdge(forNode.id, 'loop_linkage', connector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage'),
    ];

    const nextState = nodesSliceConfig.slice.reducer(initialState, nodesChanged([{ type: 'remove', id: forNode.id }]));

    expect(nextState.edges).toEqual([]);
  });

  it('removes all connector alias edges when a For boundary is replaced by another node type', () => {
    const forNode = buildNode(for_loop);
    const replacement = buildNode(add);
    const connector = buildFixedConnectorNode('connector-1');
    const returnNode = buildNode(for_return);
    replacement.id = forNode.id;
    replacement.data.id = forNode.id;

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, connector, returnNode];
    initialState.edges = [
      buildEdge(forNode.id, 'loop_linkage', connector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage'),
    ];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([
        { type: 'remove', id: forNode.id },
        { type: 'add', item: replacement },
      ])
    );

    expect(nextState.edges).toEqual([]);
  });

  it('removes an incomplete connector alias when a For boundary is replaced by another node type', () => {
    const forNode = buildNode(for_loop);
    const replacement = buildNode(add);
    const connector = buildFixedConnectorNode('connector-1');
    replacement.id = forNode.id;
    replacement.data.id = forNode.id;

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, connector];
    initialState.edges = [buildEdge(forNode.id, 'loop_linkage', connector.id, CONNECTOR_INPUT_HANDLE)];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([
        { type: 'remove', id: forNode.id },
        { type: 'add', item: replacement },
      ])
    );

    expect(nextState.edges).toEqual([]);
  });

  it('splices a connector loop linkage alias into a direct edge when removed', () => {
    const forNode = buildNode(for_loop);
    const connector = buildFixedConnectorNode('connector-1');
    const returnNode = buildNode(for_return);

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, connector, returnNode];
    initialState.edges = [
      buildEdge(forNode.id, 'loop_linkage', connector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage'),
    ];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([{ type: 'remove', id: connector.id }])
    );

    expect(nextState.edges).toEqual([
      expect.objectContaining({
        type: 'loop_linkage',
        source: forNode.id,
        sourceHandle: 'loop_linkage',
        target: returnNode.id,
        targetHandle: 'loop_linkage',
      }),
    ]);
  });

  it('splices a removed terminal loop linkage connector to the preceding connector', () => {
    const forNode = buildNode(for_loop);
    const firstConnector = buildFixedConnectorNode('connector-a');
    const terminalConnector = buildFixedConnectorNode('connector-b');
    const returnNode = buildNode(for_return);

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, firstConnector, terminalConnector, returnNode];
    initialState.edges = [
      buildEdge(forNode.id, 'loop_linkage', firstConnector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(firstConnector.id, CONNECTOR_OUTPUT_HANDLE, terminalConnector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(terminalConnector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage'),
    ];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([{ type: 'remove', id: terminalConnector.id }])
    );

    expect(nextState.nodes.map((node) => node.id)).toEqual([forNode.id, firstConnector.id, returnNode.id]);
    expect(nextState.edges).toEqual([
      buildEdge(forNode.id, 'loop_linkage', firstConnector.id, CONNECTOR_INPUT_HANDLE),
      expect.objectContaining({
        type: 'default',
        source: firstConnector.id,
        sourceHandle: CONNECTOR_OUTPUT_HANDLE,
        target: returnNode.id,
        targetHandle: 'loop_linkage',
      }),
    ]);
  });

  it('splices a removed interior loop linkage connector to the preceding connector', () => {
    const forNode = buildNode(for_loop);
    const firstConnector = buildFixedConnectorNode('connector-a');
    const removedConnector = buildFixedConnectorNode('connector-b');
    const terminalConnector = buildFixedConnectorNode('connector-c');
    const returnNode = buildNode(for_return);

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, firstConnector, removedConnector, terminalConnector, returnNode];
    initialState.edges = [
      buildEdge(forNode.id, 'loop_linkage', firstConnector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(firstConnector.id, CONNECTOR_OUTPUT_HANDLE, removedConnector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(removedConnector.id, CONNECTOR_OUTPUT_HANDLE, terminalConnector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(terminalConnector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage'),
    ];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([{ type: 'remove', id: removedConnector.id }])
    );

    expect(nextState.nodes.map((node) => node.id)).toEqual([
      forNode.id,
      firstConnector.id,
      terminalConnector.id,
      returnNode.id,
    ]);
    expect(nextState.edges).toEqual(
      expect.arrayContaining([
        buildEdge(forNode.id, 'loop_linkage', firstConnector.id, CONNECTOR_INPUT_HANDLE),
        buildEdge(firstConnector.id, CONNECTOR_OUTPUT_HANDLE, terminalConnector.id, CONNECTOR_INPUT_HANDLE),
        buildEdge(terminalConnector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage'),
      ])
    );
  });

  it('splices a chain when multiple loop linkage connectors are removed together', () => {
    const forNode = buildNode(for_loop);
    const firstConnector = buildFixedConnectorNode('connector-a');
    const secondConnector = buildFixedConnectorNode('connector-b');
    const returnNode = buildNode(for_return);

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, firstConnector, secondConnector, returnNode];
    initialState.edges = [
      buildEdge(forNode.id, 'loop_linkage', firstConnector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(firstConnector.id, CONNECTOR_OUTPUT_HANDLE, secondConnector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(secondConnector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage'),
    ];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([
        { type: 'remove', id: firstConnector.id },
        { type: 'remove', id: secondConnector.id },
      ])
    );

    expect(nextState.nodes.map((node) => node.id)).toEqual([forNode.id, returnNode.id]);
    expect(nextState.edges).toEqual([
      expect.objectContaining({
        type: 'loop_linkage',
        source: forNode.id,
        sourceHandle: 'loop_linkage',
        target: returnNode.id,
        targetHandle: 'loop_linkage',
      }),
    ]);
  });

  it('does not create invalid edges when removing a loop linkage connector with an ordinary fanout', () => {
    const forNode = buildNode(for_loop);
    const connector = buildFixedConnectorNode('connector');
    const returnNode = buildNode(for_return);
    const ordinaryTarget = buildNode(sub);

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, connector, returnNode, ordinaryTarget];
    initialState.edges = [
      buildEdge(forNode.id, 'loop_linkage', connector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage'),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, ordinaryTarget.id, 'a'),
    ];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([{ type: 'remove', id: connector.id }])
    );

    expect(nextState.nodes.map((node) => node.id)).toEqual([forNode.id, returnNode.id, ordinaryTarget.id]);
    expect(nextState.edges).toEqual([]);
  });

  it('preserves linkage when a boundary is replaced with the same node id', () => {
    const forNode = buildNode(for_loop);
    const replacement = buildNode(for_loop);
    const returnNode = buildNode(for_return);
    replacement.id = forNode.id;
    replacement.data.id = forNode.id;

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, returnNode];
    initialState.edges = [buildLoopLinkageEdge(forNode.id, returnNode.id)];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([
        { type: 'remove', id: forNode.id },
        { type: 'add', item: replacement },
      ])
    );
    expect(nextState.edges).toEqual([buildLoopLinkageEdge(forNode.id, returnNode.id)]);
  });

  it('removes linkage when a boundary is replaced by a different node type', () => {
    const forNode = buildNode(for_loop);
    const replacement = buildNode(add);
    const returnNode = buildNode(for_return);
    replacement.id = forNode.id;
    replacement.data.id = forNode.id;

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, returnNode];
    initialState.edges = [buildLoopLinkageEdge(forNode.id, returnNode.id)];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([
        { type: 'remove', id: forNode.id },
        { type: 'add', item: replacement },
      ])
    );

    expect(nextState.edges).toEqual([]);
  });

  it('removes linkage when its ForReturn is removed', () => {
    const forNode = buildNode(for_loop);
    const returnNode = buildNode(for_return);

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, returnNode];
    initialState.edges = [buildLoopLinkageEdge(forNode.id, returnNode.id)];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodesChanged([{ type: 'remove', id: returnNode.id }])
    );
    expect(nextState.edges).toEqual([]);
  });

  it('does not collapse loop linkage when both boundary nodes are closed', () => {
    const forNode = buildNode(for_loop);
    const returnNode = buildNode(for_return);
    returnNode.data.isOpen = false;

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, returnNode];
    initialState.edges = [buildLoopLinkageEdge(forNode.id, returnNode.id)];

    const nextState = nodesSliceConfig.slice.reducer(
      initialState,
      nodeIsOpenChanged({ nodeId: forNode.id, isOpen: false })
    );

    expect(nextState.edges).toEqual([buildLoopLinkageEdge(forNode.id, returnNode.id)]);
  });

  it('does not treat loop linkage as a hidden edge of a collapsed data-flow edge', () => {
    const forNode = buildNode(for_loop);
    const returnNode = buildNode(for_return);
    returnNode.data.isOpen = false;
    const loopLinkageEdge = buildLoopLinkageEdge(forNode.id, returnNode.id);
    const dataFlowEdge = buildEdge(forNode.id, 'item', returnNode.id, 'output');

    const initialState = deepClone(nodesSliceConfig.slice.reducer(undefined, { type: 'test/init' }));
    initialState.nodes = [forNode, returnNode];
    initialState.edges = [dataFlowEdge, loopLinkageEdge];

    const closedState = nodesSliceConfig.slice.reducer(
      initialState,
      nodeIsOpenChanged({ nodeId: forNode.id, isOpen: false })
    );
    const collapsedEdge = closedState.edges.find((edge) => edge.type === 'collapsed');
    if (!collapsedEdge) {
      throw new Error('Expected collapsed edge');
    }

    const nextState = nodesSliceConfig.slice.reducer(
      closedState,
      edgesChanged([{ type: 'remove', id: collapsedEdge.id }])
    );

    expect(nextState.edges).toEqual([loopLinkageEdge]);
  });
});
