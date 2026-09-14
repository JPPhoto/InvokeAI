import type { CanvasControlLayerContract } from '@workbench/canvas-engine/api';

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

import { ControlLayerSettings } from './ControlLayerSettings';

// Stable identities, as the real stores hand out, so only the table's arrival can re-read the policy.
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
  filter: null,
  id: 'control-1',
  isEnabled: true,
  isLocked: false,
  name: 'Control 1',
  opacity: 1,
  type: 'control',
  withTransparencyEffect: false,
} as unknown as CanvasControlLayerContract;

const ignoreOperationStarted = (): void => undefined;

const render = async () => {
  applyThemeToRoot('classic');
  host = document.createElement('div');
  host.style.width = '260px';
  document.body.append(host);
  root = createRoot(host);
  await act(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <ControlLayerSettings engine={null} layer={layer} onOperationStarted={ignoreOperationStarted} />
        </ChakraProvider>
      </I18nextProvider>
    );
  });
};

/** The kind Select renders a hidden native select, so its offered kinds are readable without opening it. */
const offersKind = (kind: string) => host!.querySelector(`option[value="${kind}"]`) !== null;

afterEach(async () => {
  await act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  resetArchitectureCapabilities();
});

describe('ControlLayerSettings and the capability table', () => {
  it('offers the adapter kinds once a retried load succeeds, without remounting', async () => {
    // Without the table every kind reads as unsupported. The list used to be memoised on the base
    // alone, so it stayed empty after the table arrived until the model changed or the panel remounted.
    await render();
    expect(offersKind('controlnet')).toBe(false);

    await act(() => {
      setArchitectureCapabilities(architectureCapabilitiesFixture);
    });

    expect(offersKind('controlnet')).toBe(true);
  });
});
