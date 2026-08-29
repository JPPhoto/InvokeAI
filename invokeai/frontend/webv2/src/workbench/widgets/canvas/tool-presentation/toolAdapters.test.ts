import type { ToolId } from '@workbench/canvas-engine/api';

import { describe, expect, it } from 'vitest';

import { hasToolRegions, OPERATION_PRESENTATION_ADAPTERS, TOOL_PRESENTATION_ADAPTERS } from './toolAdapters';

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
const en = Object.values(englishCatalogModules)[0] as {
  widgets: {
    canvas: {
      toolHints: Record<string, string>;
      tools: Record<string, string>;
    };
    properties: { rows: Record<string, string>; sections: Record<string, string> };
  };
};

describe('tool presentation adapters', () => {
  it('registers every tool under its own id with a name in the English catalog', () => {
    for (const toolId of TOOL_IDS) {
      const adapter = TOOL_PRESENTATION_ADAPTERS[toolId];
      expect(adapter.id, toolId).toBe(toolId);
      expect(en.widgets.canvas.tools[toolId], toolId).toEqual(expect.any(String));
    }
  });

  it('hints exactly the tools without a control', () => {
    for (const toolId of TOOL_IDS) {
      const adapter = TOOL_PRESENTATION_ADAPTERS[toolId];
      if (hasToolRegions(adapter)) {
        expect(en.widgets.canvas.toolHints[toolId], toolId).toBeUndefined();
      } else {
        expect(en.widgets.canvas.toolHints[toolId], toolId).toEqual(expect.any(String));
      }
    }
  });

  it('names every Properties row and section in the catalog', () => {
    for (const row of ['geometry', 'intensity', 'color', 'modes', 'more']) {
      expect(en.widgets.properties.rows[row], row).toEqual(expect.any(String));
    }
    expect(en.widgets.properties.sections.tool).toEqual(expect.any(String));
    expect(en.widgets.properties.sections.operation).toEqual(expect.any(String));
  });

  it('gives both guarded operations a status region so Apply and Cancel stay in place', () => {
    expect(Object.keys(OPERATION_PRESENTATION_ADAPTERS).sort()).toEqual(['filter', 'select-object']);
    for (const adapter of Object.values(OPERATION_PRESENTATION_ADAPTERS)) {
      expect(adapter.status).toBeDefined();
      expect(adapter.modes).toBeDefined();
    }
  });
});
