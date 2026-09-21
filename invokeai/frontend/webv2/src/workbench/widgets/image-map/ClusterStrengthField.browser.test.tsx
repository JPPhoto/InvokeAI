import type { SettingFieldProps } from '@platform/ui/settings/contracts';

import { ChakraProvider } from '@chakra-ui/react';
import { system } from '@theme/system';
import { imageMapStore } from '@workbench/image-map/imageMapStore';
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import { imageMapSettingsContribution } from './settingsContribution';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'settingsDialog.fields.clusterStrength': 'Clustering strength',
        'settingsDialog.fields.clusterStrengthAuto': 'auto',
        'settingsDialog.fields.clusterStrengthHint': 'Higher values create larger clusters',
      })[key] ?? key,
  }),
}));

// A real subscribable stand-in for the widget's persisted values: committing
// has to re-render the field, which is how the box learns the edit landed.
const settings = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let value: number | null = null;

  return {
    get: () => value,
    patch: vi.fn((values: Record<string, unknown>) => {
      value = (values.clusterEps as number | null) ?? null;
      for (const listener of listeners) {
        listener();
      }
    }),
    reset: () => {
      value = null;
      listeners.clear();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
});

vi.mock('@workbench/settings/useWidgetSettingsTarget', () => ({
  useWidgetSettingsTarget: () => ({
    disabled: false,
    patch: settings.patch,
    value: useSyncExternalStore(settings.subscribe, settings.get, settings.get),
  }),
}));

const { ClusterStrengthField } = await import('./ClusterStrengthField');

let host: HTMLDivElement | null = null;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Longer than the field's own debounce, so a commit has certainly fired. */
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 900);
    });
  });

const field = imageMapSettingsContribution.fields.find((entry) => entry.id === 'clusterEps')!;

/** `resolved` is what the server says it clustered with. */
const render = async (resolved: number | null) => {
  imageMapStore.setSnapshot({
    clusterLabels: null,
    clusterLabelsHash: null,
    data: {
      clusterEps: resolved,
      modelName: null,
      pointCount: 1,
      points: [],
      stale: false,
      state: 'ready',
      updatedAt: null,
      visibleHash: null,
    },
    error: null,
    indexCounts: null,
    indexUpdatedAt: null,
    loadState: 'loaded',
    renderError: null,
  });

  await act(() =>
    root?.render(
      <ChakraProvider value={system}>
        <ClusterStrengthField field={field} surface="dialog" {...({} as Partial<SettingFieldProps>)} />
      </ChakraProvider>
    )
  );
};

/** The "auto" badge is hidden rather than unmounted, to keep the row from shifting. */
const autoBadgeShown = (): boolean => {
  const badge = host?.querySelector('[data-testid="cluster-strength-auto"]');

  return badge instanceof HTMLElement && globalThis.getComputedStyle(badge).visibility === 'visible';
};

const spinner = (): HTMLInputElement => {
  const input = host?.querySelector('input[type="number"]');

  if (!(input instanceof HTMLInputElement)) {
    throw new Error('the clustering-strength spinner is not in the document');
  }

  return input;
};

beforeEach(() => {
  settings.reset();
  settings.patch.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe('ClusterStrengthField', () => {
  it('shows the strength the server derived, marked as not the user’s', async () => {
    await render(0.0945);

    expect(spinner().value).toBe('0.095');
    expect(autoBadgeShown()).toBe(true);
    expect(host?.textContent).toContain('Higher values create larger clusters');
  });

  it('commits a typed strength once, after the edit settles', async () => {
    await render(0.0945);

    await userEvent.fill(spinner(), '0.25');
    expect(settings.patch).not.toHaveBeenCalled();

    await settle();

    expect(settings.patch).toHaveBeenCalledTimes(1);
    expect(settings.patch).toHaveBeenCalledWith({ clusterEps: 0.25 });
    expect(autoBadgeShown()).toBe(false);
  });

  it('hands the choice back to the heuristic when cleared', async () => {
    await render(0.0945);
    await userEvent.fill(spinner(), '0.25');
    await settle();
    settings.patch.mockClear();

    await userEvent.clear(spinner());
    await settle();

    expect(settings.patch).toHaveBeenCalledWith({ clusterEps: null });
    // And the box refills with the derived value rather than staying empty.
    expect(spinner().value).toBe('0.095');
    expect(autoBadgeShown()).toBe(true);
  });

  it('does not mistake a half-typed number for a cleared box', async () => {
    // `type="number"` reports an empty value for "0." too. Reading that as
    // "use the heuristic" would throw the user's setting away mid-keystroke.
    await render(0.0945);
    await userEvent.fill(spinner(), '0.25');
    await settle();
    settings.patch.mockClear();

    await userEvent.clear(spinner());
    await userEvent.type(spinner(), '.');
    // The box reads as empty here, which is the whole trap.
    expect(spinner().value).toBe('');
    expect(spinner().validity.badInput).toBe(true);

    await settle();

    expect(settings.patch).not.toHaveBeenCalled();
  });

  it('does not complain on the way through an incomplete number', async () => {
    // "0.15" passes through "0", which is below the minimum. Validating per
    // keystroke would flash a range error at a user typing a fine value.
    await render(0.0945);
    await userEvent.clear(spinner());
    await userEvent.type(spinner(), '0.15');

    expect(host?.textContent).not.toContain('clusterStrengthRange');

    await settle();

    expect(settings.patch).toHaveBeenCalledWith({ clusterEps: 0.15 });
  });

  it('refuses a strength the endpoint would reject', async () => {
    await render(0.0945);

    await userEvent.fill(spinner(), '9');
    await settle();

    expect(settings.patch).not.toHaveBeenCalled();
    expect(host?.textContent).toContain('clusterStrengthRange');
  });
});
