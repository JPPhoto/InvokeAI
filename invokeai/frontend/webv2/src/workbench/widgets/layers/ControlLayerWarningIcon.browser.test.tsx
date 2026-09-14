import type { CanvasLayerContract } from '@workbench/canvas-engine/api';

import { ChakraProvider } from '@chakra-ui/react';
import {
  resetArchitectureCapabilities,
  setArchitectureCapabilities,
} from '@features/generation/core/architectureCapabilities';
import { architectureCapabilitiesFixture } from '@features/generation/core/architectureCapabilities.testing';
import { applyThemeToRoot } from '@theme/applyTheme';
import { system } from '@theme/system';
import { createInstance } from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ControlLayerWarningIcon } from './ControlLayerWarningIcon';

// Stable identities, as the real stores hand out: a fresh array or model per render would change an
// input React Compiler memoises on, and re-read the table by accident rather than by subscription.
const catalog = vi.hoisted(() => ({
  mainModel: { base: 'sd-1', key: 'sd1-main', name: 'SD 1.5', type: 'main' },
  models: [{ base: 'sd-1', key: 'sd1-controlnet', name: 'SD 1.5 ControlNet', type: 'controlnet' }],
}));

vi.mock('@features/models', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useModelsSelector: (selector: (snapshot: { models: typeof catalog.models }) => unknown) =>
    selector({ models: catalog.models }),
}));
vi.mock('./useSelectedMainModel', () => ({ useSelectedMainModel: () => catalog.mainModel }));

const i18n = createInstance();
void i18n.use(initReactI18next).init({ fallbackLng: 'en', initAsync: false, lng: 'en', resources: {} });

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

const layer = {
  adapter: {
    beginEndStepPct: [0, 1],
    controlMode: 'balanced',
    kind: 'controlnet',
    model: 'sd1-controlnet',
    weight: 1,
  },
  id: 'control-1',
  isEnabled: true,
  isLocked: false,
  name: 'Control 1',
  opacity: 1,
  type: 'control',
} as unknown as CanvasLayerContract;

const render = async () => {
  applyThemeToRoot('classic');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <ControlLayerWarningIcon layer={layer} />
        </ChakraProvider>
      </I18nextProvider>
    );
  });
};

const warning = () => host!.querySelector('[aria-label="widgets.layers.control.needsAttention"]');

afterEach(async () => {
  await act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  resetArchitectureCapabilities();
});

describe('ControlLayerWarningIcon and the capability table', () => {
  it('drops the "unsupported adapter" warning once a retried load succeeds, without remounting', async () => {
    // Without the table every adapter kind reads as unsupported. The row used to keep that answer
    // until the layer or model changed, so a healthy SD-1 ControlNet layer stayed flagged.
    await render();
    expect(warning()).not.toBeNull();

    await act(() => {
      setArchitectureCapabilities(architectureCapabilitiesFixture);
    });

    expect(warning()).toBeNull();
  });
});
