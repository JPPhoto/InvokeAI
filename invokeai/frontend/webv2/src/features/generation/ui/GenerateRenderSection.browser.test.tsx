/* oxlint-disable react-perf/jsx-no-new-object-as-prop */
import type { GenerateSettings, MainModelConfig } from '@features/generation/core/types';

import { ChakraProvider } from '@chakra-ui/react';
import { getDefaultGenerateSettings } from '@features/generation/core/baseGenerationPolicies';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { system } from '@theme/system';
import { createInstance } from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GenerateRenderSection } from './GenerateRenderSection';

const seedHistory = [
  { seed: 777, thumbnailUrl: null },
  { seed: 888, thumbnailUrl: null },
];

vi.mock('./GenerationUiContext', () => ({
  useGenerationUi: () => ({
    queueInsights: { secondsPerRun: null, seedHistory },
    sectionPreferences: { sectionsOpen: { render: true }, setSectionOpen: vi.fn() },
  }),
}));

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  fallbackLng: 'en',
  initAsync: false,
  lng: 'en',
  resources: {
    en: {
      translation: {
        common: { seed: 'Seed' },
        widgets: {
          generate: {
            newSeed: 'New seed',
            recentSeeds: 'Recent seeds',
            render: 'Render',
            seedMode: {
              decrement: 'Decrement',
              decrementDescription: 'Use successive seeds, decreasing by 1.',
              fixed: 'Fixed',
              fixedDescription: 'Reuse the entered seed.',
              increment: 'Increment',
              incrementDescription: 'Use successive seeds, increasing by 1.',
              label: 'Seed mode',
              random: 'Random',
              randomDescription: 'Choose a fresh starting seed for each submission.',
            },
            seedNextBatch: 'Next batch: {{seed}}',
            seedNextBatchRange: 'Next batch: {{first}} → {{last}}',
            seedSummary: '{{mode}} · {{seed}}',
            steps: 'Steps',
            useSeed: 'Use seed {{seed}}',
          },
        },
      },
    },
  },
});

const sd1Model: MainModelConfig = { base: 'sd-1', key: 'sd1', name: 'SD 1.5', type: 'main' };
let host: HTMLDivElement | null = null;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settle = (action: () => void): Promise<void> =>
  act(async () => {
    action();
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 50);
    });
  });

const render = async (overrides: Partial<GenerateSettings>) => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const settings: GenerateSettings = { ...getDefaultGenerateSettings(sd1Model), seed: 42, ...overrides };
  const onCommit = vi.fn();

  await settle(() => {
    root?.render(
      <QueryClientProvider client={new QueryClient()}>
        <ChakraProvider value={system}>
          <I18nextProvider i18n={i18n}>
            <GenerateRenderSection
              selectedModel={sd1Model}
              settings={settings}
              onCommit={onCommit}
              onCommitImmediate={vi.fn()}
            />
          </I18nextProvider>
        </ChakraProvider>
      </QueryClientProvider>
    );
  });

  return onCommit;
};

const seedInput = () => host?.querySelector<HTMLInputElement>('input[aria-label="Seed"]') ?? null;
const modeTrigger = () => host?.querySelector<HTMLButtonElement>('button[aria-label^="Seed mode:"]') ?? null;
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
    item.textContent?.startsWith(label)
  ) ?? null;
const preview = () => host?.querySelector('[data-testid="seed-sequence-preview"]')?.textContent ?? null;

afterEach(async () => {
  await settle(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe('GenerateRenderSection seed field', () => {
  it('quiets the input in random mode but keeps the entered seed on show', async () => {
    await render({ seedMode: 'random' });

    expect(seedInput()?.disabled).toBe(true);
    expect(seedInput()?.value).toBe('42');
    expect(host?.querySelector<HTMLButtonElement>('button[aria-label="New seed"]')?.disabled).toBe(true);
    expect(modeTrigger()?.getAttribute('aria-label')).toBe('Seed mode: Random');
    expect(preview()).toBeNull();
  });

  it('commits a mode chosen from the menu without touching the seed', async () => {
    const onCommit = await render({ seedMode: 'random' });

    await settle(() => modeTrigger()?.click());
    const increment = menuItem('Increment');

    expect(increment?.getAttribute('aria-checked')).toBe('false');
    expect(menuItem('Random')?.getAttribute('aria-checked')).toBe('true');
    expect(increment?.textContent).toContain('Use successive seeds, increasing by 1.');

    await settle(() => increment?.click());

    expect(onCommit).toHaveBeenCalledWith({ seedMode: 'increment' });
  });

  it('is operable from the keyboard and returns focus to the trigger', async () => {
    const onCommit = await render({ seedMode: 'random' });
    const trigger = modeTrigger();

    await settle(() => trigger?.focus());
    await settle(() => trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })));
    // The menu itself takes focus and tracks the highlighted item by attribute.
    const menu = document.activeElement;

    expect(menu?.getAttribute('role')).toBe('menu');

    // Enter opens on the first mode; one step down lands on the second.
    await settle(() => menu?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' })));

    expect(document.querySelector('[role="menuitemradio"][data-highlighted]')?.getAttribute('data-value')).toBe(
      'fixed'
    );

    await settle(() => menu?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })));

    expect(onCommit).toHaveBeenCalledWith({ seedMode: 'fixed' });
    expect(document.activeElement).toBe(trigger);
  });

  it('previews the seeds the next batch will run in a stepping mode', async () => {
    await render({ batchCount: 3, seedMode: 'increment' });

    expect(seedInput()?.disabled).toBe(false);
    expect(preview()).toBe('Next batch: 42 → 44');
    expect(document.getElementById(seedInput()?.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Next batch: 42 → 44'
    );
  });

  it('previews a single-seed batch without a range', async () => {
    await render({ batchCount: 1, seedMode: 'decrement' });

    expect(preview()).toBe('Next batch: 42');
  });

  it('pins a recent seed by switching to fixed', async () => {
    const onCommit = await render({ seedMode: 'increment' });

    await settle(() => host?.querySelector<HTMLButtonElement>('button[aria-label="Use seed 888"]')?.click());

    expect(onCommit).toHaveBeenCalledWith({ seed: 888, seedMode: 'fixed' });
  });

  it('names the active mode in the collapsed summary', async () => {
    await render({ seedMode: 'decrement' });

    expect(host?.textContent).toContain('Decrement · 42');
  });
});
