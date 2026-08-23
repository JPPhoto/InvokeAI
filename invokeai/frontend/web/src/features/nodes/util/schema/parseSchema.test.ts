import { omit, pick } from 'es-toolkit/compat';
import {
  call_saved_workflow,
  for_loop,
  for_return,
  schema,
  templates,
  workflow_return,
} from 'features/nodes/store/util/testUtils';
import type { InvocationTemplate } from 'features/nodes/types/invocation';
import { parseSchema } from 'features/nodes/util/schema/parseSchema';
import type { OpenAPIV3_1 } from 'openapi-types';
import { describe, expect, it } from 'vitest';

import generatedSchemaJSON from '../../../../../openapi.json?raw';

const stripUndefinedDeep = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const normalizeInputUiHidden = (template: InvocationTemplate): InvocationTemplate => ({
  ...template,
  inputs: Object.fromEntries(
    Object.entries(template.inputs).map(([name, input]) => [name, { ...input, ui_hidden: input.ui_hidden ?? false }])
  ),
});

describe('parseSchema', () => {
  it('should parse the schema', () => {
    const parsed = parseSchema(schema);
    expect(stripUndefinedDeep(parsed)).toEqual(stripUndefinedDeep(templates));
  });
  it('should omit denied nodes', () => {
    const parsed = parseSchema(schema, undefined, ['add']);
    expect(stripUndefinedDeep(parsed)).toEqual(stripUndefinedDeep(omit(templates, 'add')));
  });
  it('should include only allowed nodes', () => {
    const parsed = parseSchema(schema, ['add']);
    expect(stripUndefinedDeep(parsed)).toEqual(stripUndefinedDeep(pick(templates, 'add')));
  });
  it('should parse the call_saved_workflow node template', () => {
    const parsed = parseSchema(schema);
    expect(stripUndefinedDeep(parsed.call_saved_workflow)).toEqual(stripUndefinedDeep(call_saved_workflow));
    const template = parsed.call_saved_workflow;
    if (!template) {
      throw new Error('Expected call_saved_workflow template');
    }
    const workflowIdInput = template.inputs.workflow_id;
    if (!workflowIdInput) {
      throw new Error('Expected workflow_id input');
    }
    expect(workflowIdInput.type.name).toBe('SavedWorkflowField');
    expect(workflowIdInput.ui_type).toBe('SavedWorkflowField');
  });
  it('should parse the workflow_return node template', () => {
    const parsed = parseSchema(schema);
    expect(stripUndefinedDeep(parsed.workflow_return)).toEqual(stripUndefinedDeep(workflow_return));
    const template = parsed.workflow_return;
    if (!template) {
      throw new Error('Expected workflow_return template');
    }
    const collectionInput = template.inputs.collection;
    if (!collectionInput) {
      throw new Error('Expected collection input');
    }
    expect(collectionInput.type.name).toBe('CollectionField');
    expect(collectionInput.ui_type).toBe('CollectionField');
  });
  it('should keep the loop test templates aligned with the generated schema', () => {
    const generatedSchema = JSON.parse(generatedSchemaJSON) as OpenAPIV3_1.Document;
    const parsed = parseSchema(generatedSchema, ['for', 'for_return']);

    expect(
      stripUndefinedDeep(
        Object.fromEntries(Object.entries(parsed).map(([type, template]) => [type, normalizeInputUiHidden(template)]))
      )
    ).toEqual(
      stripUndefinedDeep({
        for: normalizeInputUiHidden(for_loop),
        for_return: normalizeInputUiHidden(for_return),
      })
    );

    expect(parsed.for_return?.version).toBe('1.2.0');
    expect(parsed.for_return?.inputs.continue_condition).toMatchObject({
      input: 'any',
      required: false,
      default: true,
      type: { name: 'BooleanField' },
    });
  });
});
