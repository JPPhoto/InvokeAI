import type { OutputFieldNamesByScope } from 'features/nodes/util/node/getOutputFieldNamesByScope';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { OutputFields } from './OutputFields';

const mocks = vi.hoisted(() => ({
  fieldNames: {
    all: ['item', 'output_collection'],
    unscoped: [],
    iteration: ['item'],
    final: ['output_collection'],
  } as OutputFieldNamesByScope,
}));

vi.mock('@invoke-ai/ui-library', () => ({
  GridItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('features/nodes/hooks/useOutputFieldNames', () => ({
  useOutputFieldNamesByScope: () => mocks.fieldNames,
}));

vi.mock('features/nodes/components/flow/nodes/Invocation/fields/OutputFieldGate', () => ({
  OutputFieldGate: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('features/nodes/components/flow/nodes/Invocation/fields/OutputFieldNodesEditorView', () => ({
  OutputFieldNodesEditorView: ({ fieldName }: { fieldName: string }) => <span data-field={fieldName}>{fieldName}</span>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe(OutputFields.name, () => {
  it('renders scoped outputs under localized section headings', () => {
    const html = renderToStaticMarkup(<OutputFields nodeId="for" />);

    expect(html).toContain('nodes.iterationOutputs');
    expect(html).toContain('nodes.finalOutputs');
    expect(html.indexOf('nodes.iterationOutputs')).toBeLessThan(html.indexOf('data-field="item"'));
    expect(html.indexOf('nodes.finalOutputs')).toBeLessThan(html.indexOf('data-field="output_collection"'));
  });

  it('renders ordinary outputs without scope headings', () => {
    mocks.fieldNames = {
      all: ['value'],
      unscoped: ['value'],
      iteration: [],
      final: [],
    };

    const html = renderToStaticMarkup(<OutputFields nodeId="ordinary" />);

    expect(html).toContain('data-field="value"');
    expect(html).not.toContain('nodes.iterationOutputs');
    expect(html).not.toContain('nodes.finalOutputs');
  });
});
