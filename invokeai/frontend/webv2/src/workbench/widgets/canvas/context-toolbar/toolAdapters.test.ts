import type { ToolId } from '@workbench/canvas-engine/api';

import { describe, expect, it } from 'vitest';

import { hasToolRegions, OPERATION_PRESENTATION_ADAPTERS, TOOL_PRESENTATION_ADAPTERS } from './toolAdapters';
import { TOOLBAR_PRIMARY_MAX_WIDTH_PX, TOOLBAR_REGION_ORDER, TOOLBAR_REGION_WIDTH_PX } from './toolbarLayout';

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
      toolbar: { label: string; more: string; regions: Record<string, string> };
      tools: Record<string, string>;
    };
  };
};

describe('tool presentation adapters', () => {
  it('registers every tool under its own id with an icon and a name in the English catalog', () => {
    for (const toolId of TOOL_IDS) {
      const adapter = TOOL_PRESENTATION_ADAPTERS[toolId];
      expect(adapter.id, toolId).toBe(toolId);
      expect(adapter.icon, toolId).toBeDefined();
      expect(en.widgets.canvas.tools[toolId], toolId).toEqual(expect.any(String));
    }
  });

  it('hints exactly the tools without a control, and never names a primary region they lack', () => {
    for (const toolId of TOOL_IDS) {
      const adapter = TOOL_PRESENTATION_ADAPTERS[toolId];
      if (hasToolRegions(adapter)) {
        expect(en.widgets.canvas.toolHints[toolId], toolId).toBeUndefined();
        if (adapter.primary) {
          expect(adapter[adapter.primary], `${toolId} primary`).toBeDefined();
        }
      } else {
        expect(en.widgets.canvas.toolHints[toolId], toolId).toEqual(expect.any(String));
        expect(adapter.primary, toolId).toBeNull();
      }
    }
  });

  it('keeps the shared geometry slots on the tools that edit position: move, transform and the frame', () => {
    for (const toolId of ['bbox', 'move', 'transform'] as const) {
      expect(TOOL_PRESENTATION_ADAPTERS[toolId].primary, toolId).toBe('geometry');
    }
    for (const toolId of ['gradient', 'lasso', 'marquee', 'shape'] as const) {
      expect(TOOL_PRESENTATION_ADAPTERS[toolId].primary, toolId).toBe('modes');
    }
  });

  it('declares a positive bar width for every modes region and names every region in the catalog', () => {
    for (const adapter of [
      ...Object.values(TOOL_PRESENTATION_ADAPTERS),
      ...Object.values(OPERATION_PRESENTATION_ADAPTERS),
    ]) {
      if (adapter.modes) {
        expect(adapter.modes.width, 'id' in adapter ? adapter.id : adapter.kind).toBeGreaterThan(0);
      }
    }
    for (const region of [...TOOLBAR_REGION_ORDER, 'more', 'status']) {
      expect(en.widgets.canvas.toolbar.regions[region], region).toEqual(expect.any(String));
    }
    expect(en.widgets.canvas.toolbar.label).toEqual(expect.any(String));
    expect(en.widgets.canvas.toolbar.more).toEqual(expect.any(String));
  });

  it('keeps every tool and operation primary within the width the identity and status thresholds assume', () => {
    expect(TOOLBAR_REGION_WIDTH_PX.geometry).toBeLessThanOrEqual(TOOLBAR_PRIMARY_MAX_WIDTH_PX);
    for (const adapter of Object.values(TOOL_PRESENTATION_ADAPTERS)) {
      if (adapter.primary === 'modes') {
        expect(adapter.modes?.width, adapter.id).toBeLessThanOrEqual(TOOLBAR_PRIMARY_MAX_WIDTH_PX);
      }
    }
    for (const adapter of Object.values(OPERATION_PRESENTATION_ADAPTERS)) {
      expect(adapter.modes?.width, adapter.kind).toBeLessThanOrEqual(TOOLBAR_PRIMARY_MAX_WIDTH_PX);
    }
  });

  it('gives both guarded operations a status region so Apply and Cancel stay in place', () => {
    expect(Object.keys(OPERATION_PRESENTATION_ADAPTERS).sort()).toEqual(['filter', 'select-object']);
    for (const adapter of Object.values(OPERATION_PRESENTATION_ADAPTERS)) {
      expect(adapter.status).toBeDefined();
      expect(adapter.modes).toBeDefined();
    }
  });
});
