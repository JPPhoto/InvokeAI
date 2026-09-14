/* oxlint-disable react-perf/jsx-no-new-object-as-prop */
import type { GenerateSettings, MainModelConfig } from '@features/generation/core/types';

import { ChakraProvider } from '@chakra-ui/react';
import { seedArchitectureCapabilities } from '@features/generation/core/architectureCapabilities.testing';
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
            // Verbatim from `public/locales/en.json`: Ideogram 4's overrides really are labelled
            // "Steps" and "Guidance", the same as the shared controls beside them. Inventing
            // distinct names here would hide that from the one test that renders both at once.
            ideogram4ColorHelp: 'Comma-separated color terms folded into the caption.',
            ideogram4ColorPalette: 'Color palette',
            ideogram4GuidanceScale: 'Guidance',
            ideogram4Mu: 'Mu',
            ideogram4MuHelp: 'Timestep shift. Higher values spend more of the schedule at high noise.',
            ideogram4PresetDerived: 'Set by the sampler preset unless overridden.',
            ideogram4SamplerPreset: 'Sampler preset',
            ideogram4Steps: 'Steps',
            newSeed: 'New seed',
            override: 'Override',
            recentSeeds: 'Recent seeds',
            render: 'Render',
            scheduler: 'Scheduler',
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
            useModelDefaultField: 'Use model default {{field}}',
            useModelDefaultScheduler: 'Use model default scheduler',
            useModelDefaultSteps: 'Use model default steps',
          },
        },
      },
    },
  },
});

/**
 * FLUX Fill's own recommendation is `guidance=30`, well past the guidance slider's practical top of
 * 10. That is the case the number input's looser `numberInputMax` exists for: without it the field
 * clamps to the slider's bound the first time it loses focus, and the model's own default is gone
 * before the user has touched anything.
 */
const fluxFillModel: MainModelConfig = {
  base: 'flux',
  default_settings: { cfg_scale: 1, guidance: 30 },
  format: 'diffusers',
  key: 'flux-fill',
  name: 'FLUX Fill',
  type: 'main',
};

/** `flux2_denoise.guidance` is `le=20`, which the capability table serves as `guidance_max`. */
const flux2Model: MainModelConfig = {
  base: 'flux2',
  format: 'diffusers',
  key: 'flux2',
  name: 'FLUX.2 dev',
  type: 'main',
  variant: 'dev',
};

/** `ernie_image_denoise.guidance_scale` is `ge=1.0`, served as `guidance_min`. */
const ernieModel: MainModelConfig = {
  base: 'ernie-image',
  format: 'diffusers',
  key: 'ernie',
  name: 'ERNIE Image',
  type: 'main',
};

const ideogram4Model: MainModelConfig = {
  base: 'ideogram-4',
  format: 'diffusers',
  key: 'ideogram-4',
  name: 'Ideogram 4',
  type: 'main',
};

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

const render = async (model: MainModelConfig, settings: Partial<GenerateSettings> = {}) => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const onCommit = vi.fn();

  await settle(() => {
    root?.render(
      // The seed field observes the dynamic prompts expansion query.
      <QueryClientProvider client={new QueryClient()}>
        <ChakraProvider value={system}>
          <I18nextProvider i18n={i18n}>
            <GenerateRenderSection
              selectedModel={model}
              settings={{ ...getDefaultGenerateSettings(model), ...settings }}
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

const renderSeed = (overrides: Partial<GenerateSettings>) => render(sd1Model, { seed: 42, ...overrides });
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
    await renderSeed({ seedMode: 'random' });

    expect(seedInput()?.disabled).toBe(true);
    expect(seedInput()?.value).toBe('42');
    expect(host?.querySelector<HTMLButtonElement>('button[aria-label="New seed"]')?.disabled).toBe(true);
    expect(modeTrigger()?.getAttribute('aria-label')).toBe('Seed mode: Random');
    expect(preview()).toBeNull();
  });

  it('commits a mode chosen from the menu without touching the seed', async () => {
    const onCommit = await renderSeed({ seedMode: 'random' });

    await settle(() => modeTrigger()?.click());
    const increment = menuItem('Increment');

    expect(increment?.getAttribute('aria-checked')).toBe('false');
    expect(menuItem('Random')?.getAttribute('aria-checked')).toBe('true');
    expect(increment?.textContent).toContain('Use successive seeds, increasing by 1.');

    await settle(() => increment?.click());

    expect(onCommit).toHaveBeenCalledWith({ seedMode: 'increment' });
  });

  it('is operable from the keyboard and returns focus to the trigger', async () => {
    const onCommit = await renderSeed({ seedMode: 'random' });
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
    await renderSeed({ batchCount: 3, seedMode: 'increment' });

    expect(seedInput()?.disabled).toBe(false);
    expect(preview()).toBe('Next batch: 42 → 44');
    expect(document.getElementById(seedInput()?.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Next batch: 42 → 44'
    );
  });

  it('previews a single-seed batch without a range', async () => {
    await renderSeed({ batchCount: 1, seedMode: 'decrement' });

    expect(preview()).toBe('Next batch: 42');
  });

  it('pins a recent seed by switching to fixed', async () => {
    const onCommit = await renderSeed({ seedMode: 'increment' });

    await settle(() => host?.querySelector<HTMLButtonElement>('button[aria-label="Use seed 888"]')?.click());

    expect(onCommit).toHaveBeenCalledWith({ seed: 888, seedMode: 'fixed' });
  });

  it('names the active mode in the collapsed summary', async () => {
    await renderSeed({ seedMode: 'decrement' });

    expect(host?.textContent).toContain('Decrement · 42');
  });
});

/**
 * The thumb is the tooltip trigger, so `role="slider"` is the stable selector rather than
 * `[data-part="thumb"]`. Guidance is the second slider in the section; steps is the first.
 */
const guidanceThumb = (label = 'Guidance'): Element | undefined =>
  [...(host?.querySelectorAll('[role="slider"]') ?? [])].find(
    (candidate) => candidate.getAttribute('aria-label') === label
  );

describe('GenerateRenderSection guidance field', () => {
  // The guidance label and the model's stored guidance both come from the served table now,
  // and the resolver returns nothing without it -- the field would render empty.
  seedArchitectureCapabilities();

  it('does not clamp a model default above the slider track when the field loses focus', async () => {
    const onCommit = await render(fluxFillModel);
    const input = host?.querySelector<HTMLInputElement>('input[aria-label="Guidance"]');

    expect(input?.value).toBe('30');

    await settle(() => input?.focus());
    await settle(() => input?.blur());

    // The commit is the observable, not the input's value: the field is controlled, so the value
    // prop puts 30 back either way and only the caller sees the clamp. Dropping numberInputMax
    // makes this a commit of 10, which is then the value every subsequent graph is compiled with.
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('still holds the guidance slider itself to its practical range', async () => {
    await render(fluxFillModel);

    expect(guidanceThumb()?.getAttribute('aria-valuenow')).toBe('10');
    expect(guidanceThumb()?.getAttribute('aria-valuemax')).toBe('10');
  });

  it('clamps a typed guidance to the ceiling the architecture declares', async () => {
    // The reported failure, from the other side: a project that stored FLUX Fill's 30 and then
    // selected a FLUX.2 model. With a fixed input maximum of 100 the 30 persisted and was submitted
    // to `flux2_denoise.guidance` (le=20), which rejects it at enqueue with nothing said in the UI.
    const onCommit = await render(flux2Model, { cfgScale: 30 });
    const input = host?.querySelector<HTMLInputElement>('input[aria-label="Guidance"]');

    await settle(() => input?.focus());
    await settle(() => input?.blur());

    expect(onCommit).toHaveBeenCalledWith({ cfgScale: 20 });
  });

  it('starts the guidance track at the floor the architecture declares', async () => {
    // `ernie_image_denoise.guidance_scale` is ge=1: dragging the slider to 0, or typing 0.5, used
    // to persist and be forwarded unchanged by graph.ts.
    const onCommit = await render(ernieModel, { cfgScale: 0.5 });
    const input = host?.querySelector<HTMLInputElement>('input[aria-label="CFG"]');

    expect(guidanceThumb('CFG')?.getAttribute('aria-valuemin')).toBe('1');

    await settle(() => input?.focus());
    await settle(() => input?.blur());

    expect(onCommit).toHaveBeenCalledWith({ cfgScale: 1 });
  });

  it('holds the Ideogram 4 overrides to their own node bounds', async () => {
    // Not the shared slider: `ideogram4_denoise` takes preset-derived optional overrides whose
    // constraints sit on the numeric branch of an `anyOf` -- guidance ge=1/le=20, steps ge=2, mu
    // ge=-4/le=4. The guidance control offered 0 and the mu control 0..10, both forwarded verbatim.
    await render(ideogram4Model, { ideogram4GuidanceScale: 5, ideogram4Mu: 1, ideogram4Steps: 48 });
    const ranges = (label: string) =>
      [...(host?.querySelectorAll('[role="slider"]') ?? [])]
        .filter((thumb) => thumb.getAttribute('aria-label') === label)
        .map((thumb) => [thumb.getAttribute('aria-valuemin'), thumb.getAttribute('aria-valuemax')]);

    // Two per name: the shared control first, then Ideogram's override. They carry the same
    // accessible name in the product, which is its own (pre-existing) problem — asserting both
    // ranges at once is what keeps this test honest about which is which.
    expect(ranges('Guidance')).toEqual([
      ['0', '10'],
      ['1', '20'],
    ]);
    expect(ranges('Steps')).toEqual([
      ['1', '100'],
      ['2', '100'],
    ]);
    expect(ranges('Mu')).toEqual([['-4', '4']]);
  });

  it('names the broken bound on the field, not only in the Invoke button tooltip', async () => {
    // Model selection clamps, so this is what a recalled or previously persisted value looks like:
    // the field shows 30, Invoke is disabled elsewhere, and without this the only explanation is a
    // tooltip on a button in another panel.
    await render(flux2Model, { cfgScale: 30 });

    expect(host?.querySelector('[role="alert"]')?.textContent).toBe('Guidance must be at most 20 for FLUX.2 dev.');
    expect(host?.querySelector<HTMLInputElement>('input[aria-label="Guidance"]')?.value).toBe('30');
  });

  it('says nothing on the field while the value is inside the architecture bound', async () => {
    await render(flux2Model, { cfgScale: 7 });

    expect(host?.querySelector('[role="alert"]')).toBeNull();
  });

  it('drops the model-default mark the guidance track cannot place', async () => {
    // FLUX Fill's default of 30 has no position on a track that stops at 10. Steps keeps its own
    // mark (30 of 100), so this is the out-of-range mark going, not marks in general.
    await render(fluxFillModel);
    const [stepsSlider, guidanceSlider] = [
      ...(host?.querySelectorAll('[data-scope="slider"][data-part="root"]') ?? []),
    ];

    expect(stepsSlider?.querySelectorAll('[data-part="marker"]')).toHaveLength(1);
    expect(guidanceSlider?.querySelectorAll('[data-part="marker"]')).toHaveLength(0);
  });
});

describe('GenerateRenderSection before the capability table arrives', () => {
  // No `seedArchitectureCapabilities()` here on purpose. Generation is blocked outright without the
  // table, so the fallback guidance range is deliberately the widest one: tightening it would clamp
  // a stored value the user legitimately had while the capabilities are still in flight.
  it('keeps the guidance field permissive rather than guessing a bound', async () => {
    const onCommit = await render(fluxFillModel, { cfgScale: 30 });
    const input = host?.querySelector<HTMLInputElement>('input[aria-label="CFG"]');

    expect(input?.value).toBe('30');
    expect(host?.querySelector('[role="alert"]')).toBeNull();

    await settle(() => input?.focus());
    await settle(() => input?.blur());

    expect(onCommit).not.toHaveBeenCalled();
  });
});
