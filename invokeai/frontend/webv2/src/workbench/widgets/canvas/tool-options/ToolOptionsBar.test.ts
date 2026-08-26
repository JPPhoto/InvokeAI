import type { ToolId } from '@workbench/canvas-engine/api';
import type { ComponentProps } from 'react';

import { ChakraProvider } from '@chakra-ui/react';
import { system } from '@theme/system';
import { attachCanvasOperations } from '@workbench/canvas-operations/operationAccess';
import { createInstance } from 'i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { resolveToolOptionsBarContent, TOOL_OPTIONS_COMPONENTS, ToolOptionsBar } from './ToolOptionsBar';

const TOOL_IDS = Object.keys({
  bbox: true,
  brush: true,
  colorPicker: true,
  eraser: true,
  gradient: true,
  lasso: true,
  marquee: true,
  move: true,
  sam: true,
  shape: true,
  text: true,
  transform: true,
  view: true,
} satisfies Record<ToolId, true>) as ToolId[];

const englishCatalogModules = import.meta.glob('../../../../../public/locales/en.json', {
  eager: true,
  import: 'default',
});
const enCatalog = Object.values(englishCatalogModules)[0] as {
  widgets: { canvas: { toolHints: Record<string, string>; tools: Record<string, string> } };
};
const testI18n = createInstance();
await testI18n.init({
  initAsync: false,
  lng: 'en',
  resources: { en: { translation: enCatalog } },
});

const renderBar = (activeTool: ToolId): string => {
  const engine = {
    interaction: {
      get: (key: string) => (key === 'activeTool' ? activeTool : undefined),
      subscribe: () => () => undefined,
    },
  };
  attachCanvasOperations(engine, {
    getOperationState: () => ({ status: 'idle' }),
    subscribeOperation: () => () => undefined,
  } as never);
  return renderToStaticMarkup(
    createElement(
      ChakraProvider,
      { value: system } as ComponentProps<typeof ChakraProvider>,
      createElement(I18nextProvider, { i18n: testI18n }, createElement(ToolOptionsBar, { engine: engine as never }))
    )
  );
};

describe('TOOL_OPTIONS_COMPONENTS', () => {
  it('has an entry for exactly the tools with dedicated options today (bbox, brush, eraser, gradient, lasso, marquee, move, shape, text, transform)', () => {
    expect(Object.keys(TOOL_OPTIONS_COMPONENTS).sort()).toEqual([
      'bbox',
      'brush',
      'eraser',
      'gradient',
      'lasso',
      'marquee',
      'move',
      'shape',
      'text',
      'transform',
    ]);
  });

  it('shows the hint for the view tool instead of unmounting the bar', () => {
    expect(TOOL_OPTIONS_COMPONENTS.view).toBeUndefined();
    expect(resolveToolOptionsBarContent({ status: 'idle' }, 'view')).toEqual({ kind: 'hint', tool: 'view' });
  });

  it('shows the hint for tools without options', () => {
    for (const toolId of ['colorPicker', 'sam'] as const) {
      expect(TOOL_OPTIONS_COMPONENTS[toolId]).toBeUndefined();
      expect(resolveToolOptionsBarContent({ status: 'idle' }, toolId)).toEqual({ kind: 'hint', tool: toolId });
    }
  });

  it('names every tool and hints every tool without options in the English catalog', () => {
    const { toolHints, tools } = enCatalog.widgets.canvas;
    for (const toolId of TOOL_IDS) {
      expect(tools[toolId], toolId).toEqual(expect.any(String));
      if (!TOOL_OPTIONS_COMPONENTS[toolId]) {
        expect(toolHints[toolId], toolId).toEqual(expect.any(String));
      }
    }
  });

  it('renders the tool identity and hint for the view tool instead of unmounting the bar', () => {
    const markup = renderBar('view');
    expect(markup).toContain(enCatalog.widgets.canvas.tools.view);
    expect(markup).toContain(enCatalog.widgets.canvas.toolHints.view);
  });

  it('every registered entry is a defined component function', () => {
    const components = Object.values(TOOL_OPTIONS_COMPONENTS);
    expect(components.length).toBeGreaterThan(0);
    for (const component of components) {
      expect(typeof component).toBe('function');
    }
  });

  it('gives an active canvas operation priority over the active or temporary tool', () => {
    expect(resolveToolOptionsBarContent({ status: 'active' }, 'sam')).toEqual({ kind: 'operation' });
    expect(resolveToolOptionsBarContent({ status: 'active' }, 'view')).toEqual({ kind: 'operation' });
    expect(resolveToolOptionsBarContent({ status: 'idle' }, 'brush')).toEqual({
      component: TOOL_OPTIONS_COMPONENTS.brush,
      kind: 'options',
      tool: 'brush',
    });
  });
});
