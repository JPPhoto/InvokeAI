import type { InvocationSourceId } from '@workbench/invocationContracts';
import type { BuiltInLayoutPresetId } from '@workbench/layoutContracts';

/**
 * Apply URL intent once to the fresh draft: presets choose arrangement, intents choose the more specific
 * invocation source. Keep built-in ids here so both routes validate without loading full preset snapshots.
 */

export type LaunchpadIntentId = 'generate' | 'canvas' | 'upscale' | 'video' | 'workflow';

export interface LaunchpadIntent {
  id: LaunchpadIntentId;
  presetId: BuiltInLayoutPresetId;
  sourceId: InvocationSourceId;
}

export const LAUNCHPAD_INTENT_IDS: readonly LaunchpadIntentId[] = [
  'generate',
  'canvas',
  'upscale',
  'video',
  'workflow',
];

const INTENTS: Record<LaunchpadIntentId, LaunchpadIntent> = {
  canvas: { id: 'canvas', presetId: 'edit', sourceId: 'canvas' },
  generate: { id: 'generate', presetId: 'compose', sourceId: 'generate' },
  upscale: { id: 'upscale', presetId: 'compose', sourceId: 'upscale' },
  video: { id: 'video', presetId: 'video', sourceId: 'video' },
  workflow: { id: 'workflow', presetId: 'automate', sourceId: 'workflow' },
};

export const isLaunchpadIntentId = (value: unknown): value is LaunchpadIntentId =>
  typeof value === 'string' && LAUNCHPAD_INTENT_IDS.includes(value as LaunchpadIntentId);

/** Launchpad can select built-ins only; custom presets require the mounted account workbench. */
export const LAUNCHPAD_LAYOUT_IDS: readonly BuiltInLayoutPresetId[] = ['compose', 'edit', 'video', 'automate'];

/** Share built-in labels without loading widget-region snapshots; layoutPresets derives its labels from this map. */
export const BUILT_IN_LAYOUT_PRESET_LABELS: Record<BuiltInLayoutPresetId, string> = {
  automate: 'Automate',
  compose: 'Compose',
  edit: 'Edit',
  video: 'Video',
};

export const isLaunchpadLayoutId = (value: unknown): value is BuiltInLayoutPresetId =>
  typeof value === 'string' && LAUNCHPAD_LAYOUT_IDS.includes(value as BuiltInLayoutPresetId);

/**
 * `null` for anything unrecognised — a hand-edited or stale URL should open a
 * plain draft rather than fail.
 */
export const resolveLaunchpadIntent = (value: unknown): LaunchpadIntent | null =>
  isLaunchpadIntentId(value) ? INTENTS[value] : null;
