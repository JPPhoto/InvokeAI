import type { AnyNode, ConnectorNode } from 'features/nodes/types/invocation';
import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_INPUT_HANDLE,
  CONNECTOR_OUTPUT_HANDLE,
  getConnectorDeletionSpliceConnections,
  getConnectorInputEdge,
  getConnectorOutputEdges,
  getEdgesWithLoopLinkageAliases,
  resolveConnectorSource,
  resolveConnectorSourceFieldType,
  resolveLoopLinkagePath,
  resolvePendingConnectionSource,
} from './connectorTopology';
import { add, buildEdge, buildNode, for_loop, for_return, img_resize, sub, templates } from './testUtils';

const buildConnectorNode = (id: string): ConnectorNode => ({
  id,
  type: 'connector',
  position: { x: 0, y: 0 },
  data: {
    id,
    type: 'connector',
    label: 'Connector',
    isOpen: true,
  },
});

describe('connectorTopology', () => {
  it('resolves pending connector source metadata, including output scope', () => {
    const source = buildNode(for_loop);
    const connector = buildConnectorNode('connector-1');
    const pendingConnection = {
      nodeId: connector.id,
      handleId: CONNECTOR_OUTPUT_HANDLE,
      handleType: 'source' as const,
      fieldTemplate: {
        name: CONNECTOR_OUTPUT_HANDLE,
        title: 'Connector Output',
        description: '',
        fieldKind: 'output' as const,
        ui_hidden: false,
        type: { name: 'AnyField', cardinality: 'SINGLE' as const, batch: false },
      },
    };
    const nodes: AnyNode[] = [source, connector];
    const edges = [buildEdge(source.id, 'item', connector.id, CONNECTOR_INPUT_HANDLE)];

    expect(resolvePendingConnectionSource(pendingConnection, nodes, edges, { ...templates, for: for_loop })).toEqual({
      nodeId: source.id,
      fieldName: 'item',
      outputScope: 'iteration',
    });
  });

  it('resolves the effective upstream source through one connector', () => {
    const source = buildNode(add);
    const connector = buildConnectorNode('connector-1');
    const target = buildNode(sub);
    const nodes: AnyNode[] = [source, connector, target];
    const edges = [
      buildEdge(source.id, 'value', connector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, target.id, 'a'),
    ];

    expect(resolveConnectorSource(connector.id, nodes, edges)).toEqual({
      nodeId: source.id,
      fieldName: 'value',
    });
    expect(resolveConnectorSourceFieldType(connector.id, nodes, edges, templates)).toEqual(add.outputs.value?.type);
  });

  it('resolves the effective upstream source through chained connectors', () => {
    const source = buildNode(add);
    const connectorA = buildConnectorNode('connector-a');
    const connectorB = buildConnectorNode('connector-b');
    const nodes: AnyNode[] = [source, connectorA, connectorB];
    const edges = [
      buildEdge(source.id, 'value', connectorA.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connectorA.id, CONNECTOR_OUTPUT_HANDLE, connectorB.id, CONNECTOR_INPUT_HANDLE),
    ];

    expect(resolveConnectorSource(connectorB.id, nodes, edges)).toEqual({
      nodeId: source.id,
      fieldName: 'value',
    });
  });

  it('resolves a one-to-one connector loop linkage path', () => {
    const forNode = buildNode(for_loop);
    const connector = buildConnectorNode('connector-1');
    const returnNode = buildNode(for_return);
    const inputEdge = buildEdge(forNode.id, 'loop_linkage', connector.id, CONNECTOR_INPUT_HANDLE);
    const outputEdge = buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage');
    const nodes: AnyNode[] = [forNode, connector, returnNode];

    expect(resolveLoopLinkagePath(outputEdge, nodes, [inputEdge, outputEdge])).toEqual({
      forNodeId: forNode.id,
      returnNodeId: returnNode.id,
      edgeIds: [inputEdge.id, outputEdge.id],
      connectorNodeIds: [connector.id],
    });
  });

  it('resolves a connector loop linkage path through a connector chain', () => {
    const forNode = buildNode(for_loop);
    const firstConnector = buildConnectorNode('connector-1');
    const secondConnector = buildConnectorNode('connector-2');
    const returnNode = buildNode(for_return);
    const firstInputEdge = buildEdge(forNode.id, 'loop_linkage', firstConnector.id, CONNECTOR_INPUT_HANDLE);
    const chainEdge = buildEdge(firstConnector.id, CONNECTOR_OUTPUT_HANDLE, secondConnector.id, CONNECTOR_INPUT_HANDLE);
    const outputEdge = buildEdge(secondConnector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage');
    const nodes: AnyNode[] = [forNode, firstConnector, secondConnector, returnNode];

    expect(resolveLoopLinkagePath(outputEdge, nodes, [firstInputEdge, chainEdge, outputEdge])).toEqual({
      forNodeId: forNode.id,
      returnNodeId: returnNode.id,
      edgeIds: [firstInputEdge.id, chainEdge.id, outputEdge.id],
      connectorNodeIds: [firstConnector.id, secondConnector.id],
    });
  });

  it('marks every complete connector loop linkage segment for dashed rendering', () => {
    const forNode = buildNode(for_loop);
    const connector = buildConnectorNode('connector-1');
    const returnNode = buildNode(for_return);
    const inputEdge = buildEdge(forNode.id, 'loop_linkage', connector.id, CONNECTOR_INPUT_HANDLE);
    const outputEdge = buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage');
    const edges = [inputEdge, outputEdge];

    expect(getEdgesWithLoopLinkageAliases([forNode, connector, returnNode], edges)).toEqual([
      { ...inputEdge, type: 'loop_linkage' },
      { ...outputEdge, type: 'loop_linkage' },
    ]);
    expect(edges).toEqual([inputEdge, outputEdge]);
  });

  it('marks every segment in a chained connector loop linkage for dashed rendering', () => {
    const forNode = buildNode(for_loop);
    const firstConnector = buildConnectorNode('connector-1');
    const secondConnector = buildConnectorNode('connector-2');
    const returnNode = buildNode(for_return);
    const edges = [
      buildEdge(forNode.id, 'loop_linkage', firstConnector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(firstConnector.id, CONNECTOR_OUTPUT_HANDLE, secondConnector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(secondConnector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage'),
    ];

    expect(getEdgesWithLoopLinkageAliases([forNode, firstConnector, secondConnector, returnNode], edges)).toEqual(
      edges.map((edge) => ({ ...edge, type: 'loop_linkage' }))
    );
  });

  it('leaves an incomplete connector loop linkage path as a default edge', () => {
    const forNode = buildNode(for_loop);
    const connector = buildConnectorNode('connector-1');
    const edges = [buildEdge(forNode.id, 'loop_linkage', connector.id, CONNECTOR_INPUT_HANDLE)];

    expect(getEdgesWithLoopLinkageAliases([forNode, connector], edges)).toEqual(edges);
  });

  it('rejects a connector loop linkage path that fans out', () => {
    const forNode = buildNode(for_loop);
    const connector = buildConnectorNode('connector-1');
    const firstReturnNode = buildNode(for_return);
    const secondReturnNode = buildNode(for_return);
    const inputEdge = buildEdge(forNode.id, 'loop_linkage', connector.id, CONNECTOR_INPUT_HANDLE);
    const firstOutputEdge = buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, firstReturnNode.id, 'loop_linkage');
    const secondOutputEdge = buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, secondReturnNode.id, 'loop_linkage');
    const nodes: AnyNode[] = [forNode, connector, firstReturnNode, secondReturnNode];

    expect(resolveLoopLinkagePath(firstOutputEdge, nodes, [inputEdge, firstOutputEdge, secondOutputEdge])).toBe(null);
  });

  it('returns no source or type for an unresolved connector chain', () => {
    const connectorA = buildConnectorNode('connector-a');
    const connectorB = buildConnectorNode('connector-b');
    const nodes: AnyNode[] = [connectorA, connectorB];
    const edges = [buildEdge(connectorA.id, CONNECTOR_OUTPUT_HANDLE, connectorB.id, CONNECTOR_INPUT_HANDLE)];

    expect(resolveConnectorSource(connectorB.id, nodes, edges)).toBe(null);
    expect(resolveConnectorSourceFieldType(connectorB.id, nodes, edges, templates)).toBe(null);
  });

  it('enumerates multiple outgoing edges for a connector', () => {
    const source = buildNode(add);
    const connector = buildConnectorNode('connector-1');
    const targetA = buildNode(sub);
    const targetB = buildNode(img_resize);
    const incoming = buildEdge(source.id, 'value', connector.id, CONNECTOR_INPUT_HANDLE);
    const outgoingA = buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, targetA.id, 'a');
    const outgoingB = buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, targetB.id, 'width');
    const edges = [incoming, outgoingA, outgoingB];

    expect(getConnectorInputEdge(connector.id, edges)).toEqual(incoming);
    expect(getConnectorOutputEdges(connector.id, edges)).toEqual([outgoingA, outgoingB]);
  });

  it('rejects connector deletion splice-through when any downstream target would be invalid', () => {
    const source = buildNode(add);
    const connector = buildConnectorNode('connector-1');
    const target = buildNode(img_resize);
    const nodes: AnyNode[] = [source, connector, target];
    const edges = [
      buildEdge(source.id, 'value', connector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, target.id, 'image'),
    ];

    expect(getConnectorDeletionSpliceConnections(connector.id, nodes, edges, templates)).toBe(null);
  });

  it('builds connector deletion splice-through edges when every downstream target remains valid', () => {
    const source = buildNode(add);
    const connector = buildConnectorNode('connector-1');
    const target = buildNode(sub);
    const nodes: AnyNode[] = [source, connector, target];
    const edges = [
      buildEdge(source.id, 'value', connector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, target.id, 'a'),
    ];

    expect(getConnectorDeletionSpliceConnections(connector.id, nodes, edges, templates)).toEqual([
      {
        source: source.id,
        sourceHandle: 'value',
        target: target.id,
        targetHandle: 'a',
      },
    ]);
  });

  it('splices a terminal loop linkage connector to its immediate upstream connector', () => {
    const forNode = buildNode(for_loop);
    const firstConnector = buildConnectorNode('connector-a');
    const terminalConnector = buildConnectorNode('connector-b');
    const returnNode = buildNode(for_return);
    const edges = [
      buildEdge(forNode.id, 'loop_linkage', firstConnector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(firstConnector.id, CONNECTOR_OUTPUT_HANDLE, terminalConnector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(terminalConnector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage'),
    ];

    expect(
      getConnectorDeletionSpliceConnections(
        terminalConnector.id,
        [forNode, firstConnector, terminalConnector, returnNode],
        edges,
        { ...templates, for: for_loop, for_return }
      )
    ).toEqual([
      {
        source: firstConnector.id,
        sourceHandle: CONNECTOR_OUTPUT_HANDLE,
        target: returnNode.id,
        targetHandle: 'loop_linkage',
      },
    ]);
  });

  it('does not splice a loop linkage connector with an invalid ordinary fanout', () => {
    const forNode = buildNode(for_loop);
    const connector = buildConnectorNode('connector');
    const returnNode = buildNode(for_return);
    const ordinaryTarget = buildNode(sub);
    const edges = [
      buildEdge(forNode.id, 'loop_linkage', connector.id, CONNECTOR_INPUT_HANDLE),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, returnNode.id, 'loop_linkage'),
      buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, ordinaryTarget.id, 'a'),
    ];

    expect(
      getConnectorDeletionSpliceConnections(connector.id, [forNode, connector, returnNode, ordinaryTarget], edges, {
        ...templates,
        for: for_loop,
        for_return,
      })
    ).toBe(null);
  });

  it('returns no splice-through edges when a connector has downstream targets but no upstream source', () => {
    const connector = buildConnectorNode('connector-1');
    const target = buildNode(sub);
    const nodes: AnyNode[] = [connector, target];
    const edges = [buildEdge(connector.id, CONNECTOR_OUTPUT_HANDLE, target.id, 'a')];

    expect(getConnectorDeletionSpliceConnections(connector.id, nodes, edges, templates)).toBe(null);
  });
});
