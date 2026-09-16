import type { WorkflowRecordDTO } from '@features/workflow/data/api';

import { savedWorkflowDetailQueryOptions } from '@features/workflow/data/savedWorkflowQueries';
import { getInvocationTemplatesSnapshot, subscribeInvocationTemplates } from '@features/workflow/data/templates';
import { useWorkflowProjectSelector, useWorkflowUi } from '@features/workflow/ui/WorkflowUiContext';
import {
  CALL_SAVED_WORKFLOW_DYNAMIC_FIELD_PREFIX,
  getSavedWorkflowDynamicEdgeIdsToRemove,
  getSavedWorkflowDynamicFields,
  getSelectedSavedWorkflow,
  parseWorkflowJson,
} from '@features/workflow/utility';
import { useMountEffect } from '@platform/react/useMountEffect';
import { useQueryClient } from '@tanstack/react-query';
import { useEffectEvent } from 'react';

const hasSameFieldType = (left: unknown, right: unknown): boolean => {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }

  const leftType = (left as { type?: unknown }).type;
  const rightType = (right as { type?: unknown }).type;

  if (!leftType || !rightType || typeof leftType !== 'object' || typeof rightType !== 'object') {
    return false;
  }

  return (
    (leftType as { name?: unknown }).name === (rightType as { name?: unknown }).name &&
    (leftType as { cardinality?: unknown }).cardinality === (rightType as { cardinality?: unknown }).cardinality &&
    (leftType as { batch?: unknown }).batch === (rightType as { batch?: unknown }).batch
  );
};

const needsDynamicFieldSync = (
  node: Parameters<typeof getSavedWorkflowDynamicEdgeIdsToRemove>[0]['nodes'][number],
  fields: ReturnType<typeof getSavedWorkflowDynamicFields>,
  edgeIdsToRemove: string[],
  edges: Parameters<typeof getSavedWorkflowDynamicEdgeIdsToRemove>[0]['edges']
): boolean => {
  if (node.type !== 'invocation') {
    return false;
  }

  const currentTemplates = node.data.dynamicInputTemplates ?? {};
  const currentDynamicNames = new Set([
    ...Object.keys(currentTemplates),
    ...Object.keys(node.data.inputs).filter((name) => name.startsWith(CALL_SAVED_WORKFLOW_DYNAMIC_FIELD_PREFIX)),
  ]);

  if (currentDynamicNames.size !== fields.length || fields.some((field) => !currentDynamicNames.has(field.fieldName))) {
    return true;
  }

  if (
    fields.some((field) => {
      const currentTemplate = currentTemplates[field.fieldName];
      const currentInstance = node.data.inputs[field.fieldName];

      return (
        !currentTemplate ||
        !currentInstance ||
        !hasSameFieldType(currentTemplate, field.fieldTemplate) ||
        JSON.stringify(currentTemplate) !== JSON.stringify(field.fieldTemplate) ||
        currentInstance.label !== field.label ||
        (currentInstance.description ?? '') !== field.description
      );
    })
  ) {
    return true;
  }

  return edgeIdsToRemove.some((edgeId) => edges.some((edge) => edge.id === edgeId));
};

/** Reconciles asynchronously loaded child workflow forms into the project document. */
export const CallSavedWorkflowSyncRuntime = () => {
  const queryClient = useQueryClient();
  const projectGraph = useWorkflowProjectSelector((snapshot) => snapshot.projectGraph);
  const { commands, project: projectPort } = useWorkflowUi();
  const reconcile = useEffectEvent(() => {
    const templatesSnapshot = getInvocationTemplatesSnapshot();

    if (templatesSnapshot.status !== 'loaded') {
      return;
    }

    const document = projectGraph;

    for (const node of document.nodes) {
      if (node.type !== 'invocation' || node.data.type !== 'call_saved_workflow') {
        continue;
      }

      const workflowId =
        typeof node.data.inputs.workflow_id?.value === 'string' ? node.data.inputs.workflow_id.value : '';

      if (!workflowId) {
        const hasDynamicFields =
          Object.keys(node.data.dynamicInputTemplates ?? {}).length > 0 ||
          Object.keys(node.data.inputs).some((name) => name.startsWith(CALL_SAVED_WORKFLOW_DYNAMIC_FIELD_PREFIX));

        if (hasDynamicFields) {
          commands.editGraph({ edgeIdsToRemove: [], fields: [], nodeId: node.id, type: 'syncCallSavedWorkflowFields' });
        }
        continue;
      }

      const detailOptions = savedWorkflowDetailQueryOptions(workflowId);
      const record = queryClient.getQueryData<WorkflowRecordDTO>(detailOptions.queryKey);

      if (!record) {
        void queryClient.ensureQueryData(detailOptions).catch(() => undefined);
        continue;
      }

      const selectedWorkflow = getSelectedSavedWorkflow(workflowId, record);
      let childDocument;

      try {
        childDocument = selectedWorkflow ? parseWorkflowJson(selectedWorkflow.workflow).document : undefined;
      } catch {
        childDocument = undefined;
      }

      if (!childDocument) {
        continue;
      }

      const fields = getSavedWorkflowDynamicFields(childDocument, templatesSnapshot.templates);
      const edgeIdsToRemove = getSavedWorkflowDynamicEdgeIdsToRemove(
        document,
        node.id,
        fields,
        templatesSnapshot.templates
      );

      if (needsDynamicFieldSync(node, fields, edgeIdsToRemove, document.edges)) {
        commands.editGraph({ edgeIdsToRemove, fields, nodeId: node.id, type: 'syncCallSavedWorkflowFields' });
      }
    }
  });

  /* eslint-disable react-hooks/rules-of-hooks -- useMountEffect is the repository's explicit useEffect wrapper */
  useMountEffect(() => {
    reconcile();

    const unsubscribeProject = projectPort.subscribe(reconcile);
    const unsubscribeTemplates = subscribeInvocationTemplates(reconcile);
    const unsubscribeQueries = queryClient.getQueryCache().subscribe(reconcile);

    return () => {
      unsubscribeProject();
      unsubscribeTemplates();
      unsubscribeQueries();
    };
  });
  /* eslint-enable react-hooks/rules-of-hooks */

  return null;
};
