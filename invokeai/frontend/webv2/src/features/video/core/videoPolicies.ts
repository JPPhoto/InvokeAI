import type {
  GenerateLora,
  GenerationModelCatalogItem as ModelConfig,
  GenerationModelTaxonomyType as ModelTaxonomyType,
  LoraModelConfig,
  MainModelConfig,
} from '@features/generation/contracts';

import {
  getCompatibleDiffusersComponentSource,
  isDiffusersMainForBase,
  isLoraCompatibleWithModel,
  isLoraModelConfig,
  isWanLoraTargetingMain,
} from '@features/generation/settings';
import { SEED_MAX } from '@platform/core/seed';

import type { VideoAspectRatioId, VideoGenerationMode, VideoSettings, VideoTargetResolution } from './types';

import {
  getVideoAspectRatioParts,
  MINIMAX_H3_FPS,
  MINIMAX_H3_NUM_FRAMES_CHOICES,
  MINIMAX_H3_NUM_FRAMES_DEFAULT,
  resolveMiniMaxH3Canvas,
  scaleAndSnapWanDimensions,
  snapMiniMaxH3NumFrames,
  snapWanNumFrames,
  WAN_A14B_PIXEL_MULTIPLE,
  WAN_FPS_DEFAULT,
  WAN_FPS_MAX,
  WAN_FPS_MIN,
  WAN_NUM_FRAMES_DEFAULT,
  WAN_NUM_FRAMES_MAX,
  WAN_NUM_FRAMES_MIN,
  WAN_NUM_FRAMES_STEP,
  WAN_TI2V_PIXEL_MULTIPLE,
  type VideoDimensions,
} from './dimensions';
import {
  applyReferenceExtendSourceVideo,
  applyReferenceExtendNumFrames,
  MIN_VIDEO_TRIM_FRAMES,
  MINIMAX_H3_HYBRID_BLOCK_RANGE,
  resolveVideoMode,
  VIDEO_ASPECT_RATIO_IDS,
} from './settings';

// Wan variants differ in conditioning, pixel grid, and experts; key capabilities by base and variant.

export type SupportedVideoBase = 'wan' | 'minimax-h3';

export type VideoNegativePromptUsage = 'always' | 'cfg-gated' | 'never';

export interface VideoTargetResolutionOption {
  id: VideoTargetResolution;
  label: string;
}

export interface VideoFramesGridPolicy {
  kind: 'grid';
  min: number;
  max: number;
  /** Valid counts are `min + k * step` (Wan: 4k + 1, from the VAE's temporal compression). */
  step: number;
  defaultValue: number;
}

export interface VideoFramesChoicesPolicy {
  kind: 'choices';
  choices: readonly number[];
  defaultValue: number;
}

export type VideoFramesPolicy = VideoFramesGridPolicy | VideoFramesChoicesPolicy;

export interface VideoFpsPolicy {
  editable: boolean;
  defaultValue: number;
  min: number;
  max: number;
}

/**
 * Family accelerator LoRAs and sampling defaults. steps describes the reference release; getAcceleratorSteps
 * resolves release-specific schedules.
 */
export interface VideoAcceleratorConfig {
  label: 'Lightning' | 'Turbo';
  steps: number;
  /**
   * Step counts for releases whose names carry no "N-step" token. First match
   * wins; consulted only when the name does not state the count itself.
   */
  stepOverrides?: readonly { pattern: RegExp; steps: number }[];
  cfgScale: number;
  cfgScaleLowNoise: number | null;
}

interface VideoVariantConfig {
  modes: readonly VideoGenerationMode[];
  pixelMultiple: number;
  targetResolutions: readonly VideoTargetResolutionOption[];
  defaults: {
    targetResolution: VideoTargetResolution;
    steps: number;
    cfgScale: number;
    cfgScaleLowNoise: number | null;
  };
  minSteps: number;
  frames: VideoFramesPolicy;
  fps: VideoFpsPolicy;
  cfg: { visible: boolean; lowNoiseVisible: boolean };
  negativePrompt: { visible: boolean; usage: VideoNegativePromptUsage };
  accelerator: VideoAcceleratorConfig | null;
  audioOutput: boolean;
  /** Ref2VA reference caps; present only on variants whose modes include 'reference'. */
  references?: { maxVideos: number; maxImages: number; extend?: boolean };
}

export const WAN_LIGHTNING_ACCELERATOR: VideoAcceleratorConfig = {
  cfgScale: 1,
  cfgScaleLowNoise: 1,
  label: 'Lightning',
  steps: 4,
};

// LightX2V H3 uses eight steps; starter display names omit that count but retain the organization token.
const LIGHTX2V_PATTERN = /(?:^|[^a-z0-9])lightx2v(?:[^a-z0-9]|$)/i;

export const MINIMAX_H3_TURBO_ACCELERATOR: VideoAcceleratorConfig = {
  cfgScale: 1,
  cfgScaleLowNoise: null,
  label: 'Turbo',
  steps: 6,
  stepOverrides: [{ pattern: LIGHTX2V_PATTERN, steps: 8 }],
};

/** Ref2VA Turbo uses a four-step reference count; LightX2V releases override it to eight. */
export const MINIMAX_H3_REF2V_TURBO_ACCELERATOR: VideoAcceleratorConfig = {
  cfgScale: 1,
  cfgScaleLowNoise: null,
  label: 'Turbo',
  steps: 4,
  stepOverrides: [{ pattern: LIGHTX2V_PATTERN, steps: 8 }],
};

const WAN_TARGET_RESOLUTION_OPTIONS: readonly VideoTargetResolutionOption[] = [
  { id: '480p', label: '480p (Wan native)' },
  { id: '720p', label: '720p (Wan native)' },
  { id: '1080p', label: '1080p (extrapolated)' },
];

const MINIMAX_H3_TARGET_RESOLUTION_OPTIONS: readonly VideoTargetResolutionOption[] = [
  { id: '768 highres', label: '768 highres (H3 native)' },
  { id: '768 lowres', label: '768 lowres (fast preview)' },
];

const WAN_FRAMES: VideoFramesGridPolicy = {
  defaultValue: WAN_NUM_FRAMES_DEFAULT,
  kind: 'grid',
  max: WAN_NUM_FRAMES_MAX,
  min: WAN_NUM_FRAMES_MIN,
  step: WAN_NUM_FRAMES_STEP,
};

const WAN_FPS: VideoFpsPolicy = { defaultValue: WAN_FPS_DEFAULT, editable: true, max: WAN_FPS_MAX, min: WAN_FPS_MIN };

// wan_video_denoise defaults: guidance_scale=5.0 (high), guidance_scale_low_noise=4.0.
const WAN_A14B_COMMON = {
  accelerator: WAN_LIGHTNING_ACCELERATOR,
  cfg: { lowNoiseVisible: true, visible: true },
  defaults: { cfgScale: 5, cfgScaleLowNoise: 4, steps: 40, targetResolution: '720p' as const },
  fps: WAN_FPS,
  frames: WAN_FRAMES,
  minSteps: 1,
  audioOutput: false,
  negativePrompt: { usage: 'cfg-gated' as const, visible: true },
  pixelMultiple: WAN_A14B_PIXEL_MULTIPLE,
  targetResolutions: WAN_TARGET_RESOLUTION_OPTIONS,
};

const WAN_VARIANTS: Record<string, VideoVariantConfig> = {
  // The T2V expert pair has no reference-image conditioning channels.
  t2v_a14b: { ...WAN_A14B_COMMON, modes: ['txt2vid'] },
  // I2V experts require a reference frame; extension uses the source's last frame through FLF2V conditioning.
  i2v_a14b: { ...WAN_A14B_COMMON, modes: ['first-frame', 'first-last', 'extend'] },
  // TI2V-5B has text/image conditioning, no end-frame channel, and one expert.
  ti2v_5b: {
    ...WAN_A14B_COMMON,
    accelerator: null,
    cfg: { lowNoiseVisible: false, visible: true },
    defaults: { cfgScale: 5, cfgScaleLowNoise: null, steps: 40, targetResolution: '720p' },
    modes: ['txt2vid', 'first-frame', 'extend'],
    pixelMultiple: WAN_TI2V_PIXEL_MULTIPLE,
  },
};

// An unknown Wan variant (new backend release) gets the most permissive A14B
// capabilities rather than being blocked: the backend probe is the authority.
const WAN_FALLBACK_VARIANT: VideoVariantConfig = {
  ...WAN_A14B_COMMON,
  modes: ['txt2vid', 'first-frame', 'first-last', 'extend'],
};

// Guidance-distilled: no CFG, no negative prompt, fixed 24 fps, audio included.
const MINIMAX_H3_FL2VA: VideoVariantConfig = {
  accelerator: MINIMAX_H3_TURBO_ACCELERATOR,
  audioOutput: true,
  cfg: { lowNoiseVisible: false, visible: false },
  defaults: { cfgScale: 1, cfgScaleLowNoise: null, steps: 50, targetResolution: '768 highres' },
  fps: { defaultValue: MINIMAX_H3_FPS, editable: false, max: MINIMAX_H3_FPS, min: MINIMAX_H3_FPS },
  frames: { choices: MINIMAX_H3_NUM_FRAMES_CHOICES, defaultValue: MINIMAX_H3_NUM_FRAMES_DEFAULT, kind: 'choices' },
  minSteps: 2,
  modes: ['txt2vid', 'first-frame', 'last-frame', 'first-last', 'extend'],
  negativePrompt: { usage: 'never', visible: false },
  pixelMultiple: 32,
  targetResolutions: MINIMAX_H3_TARGET_RESOLUTION_OPTIONS,
};

// Upstream Ref2VA declares only reference-conditioned generation.
const MINIMAX_H3_REF2VA: VideoVariantConfig = {
  ...MINIMAX_H3_FL2VA,
  accelerator: MINIMAX_H3_REF2V_TURBO_ACCELERATOR,
  modes: ['reference'],
  // Reference extension derives a linked tail reference from Initial Video; it does not frame-condition.
  references: { extend: true, maxImages: 9, maxVideos: 3 },
};

export const VIDEO_GENERATION: Record<
  SupportedVideoBase,
  { variants: Record<string, VideoVariantConfig>; fallback: VideoVariantConfig }
> = {
  // Register Ref2VA explicitly so it never inherits FL2VA fallback modes.
  'minimax-h3': { fallback: MINIMAX_H3_FL2VA, variants: { fl2va: MINIMAX_H3_FL2VA, ref2va: MINIMAX_H3_REF2VA } },
  wan: { fallback: WAN_FALLBACK_VARIANT, variants: WAN_VARIANTS },
};

export const SUPPORTED_VIDEO_BASES = Object.keys(VIDEO_GENERATION) as SupportedVideoBase[];

/**
 * Supports Wan mains and H3 folder/checkpoint mains. H3 checkpoint variant owns task identity; a Diffusers source
 * supplies its remaining components.
 */
export const isSupportedVideoModel = <T extends { base: string; type: string; format?: string }>(
  model: T
): model is T & MainModelConfig =>
  model.type === 'main' &&
  (model.base === 'wan' ||
    (model.base === 'minimax-h3' && (model.format === 'diffusers' || model.format === 'checkpoint')));

/**
 * Select runnable identity-bearing models. Components-only and Ref2VA Diffusers folders remain supported for
 * stored state but serve only as component sources, not selectable mains.
 */
export const isVideoModelSelectable = <T extends ModelConfig>(model: T): boolean =>
  isSupportedVideoModel(model) &&
  !isComponentsOnlyH3Main(model) &&
  !(model.base === 'minimax-h3' && model.format === 'diffusers' && model.variant === 'ref2va');

/** components_only folders contain tokenizer/processor/VAEs but require transformer and text-encoder overrides. */
export const isComponentsOnlyH3Main = (model: MainModelConfig): boolean =>
  // Require full configs so narrowing cannot silently omit components_only.
  model.base === 'minimax-h3' && model.format === 'diffusers' && model.components_only === true;

const getVideoVariantConfig = (
  model: Pick<MainModelConfig, 'base' | 'type' | 'variant' | 'format'> | undefined
): VideoVariantConfig | null => {
  if (!model || !isSupportedVideoModel(model)) {
    return null;
  }

  const baseEntry = VIDEO_GENERATION[model.base as SupportedVideoBase];
  const variant = typeof model.variant === 'string' ? model.variant : '';

  return baseEntry.variants[variant] ?? baseEntry.fallback;
};

// Fallback keeps UI selectors crash-safe while nothing is selected;
// isSupportedVideoModel() still blocks invocation.
const FALLBACK_VARIANT_CONFIG = WAN_FALLBACK_VARIANT;

const getVideoConfig = (
  model: Pick<MainModelConfig, 'base' | 'type' | 'variant' | 'format'> | undefined
): VideoVariantConfig => getVideoVariantConfig(model) ?? FALLBACK_VARIANT_CONFIG;

export const getVideoModes = (model: MainModelConfig | undefined): readonly VideoGenerationMode[] =>
  getVideoConfig(model).modes;

export const isVideoModeSupported = (model: MainModelConfig | undefined, mode: VideoGenerationMode): boolean =>
  getVideoModes(model).includes(mode);

export const getVideoFramesPolicy = (model: MainModelConfig | undefined): VideoFramesPolicy =>
  getVideoConfig(model).frames;

export const getVideoFpsPolicy = (model: MainModelConfig | undefined): VideoFpsPolicy => getVideoConfig(model).fps;

export const getVideoTargetResolutionOptions = (
  model: MainModelConfig | undefined
): readonly VideoTargetResolutionOption[] => getVideoConfig(model).targetResolutions;

export const getVideoAspectRatioOptions = (_model: MainModelConfig | undefined): readonly VideoAspectRatioId[] =>
  VIDEO_ASPECT_RATIO_IDS;

const coerceTargetResolution = (
  config: VideoVariantConfig,
  targetResolution: VideoTargetResolution
): VideoTargetResolution =>
  config.targetResolutions.some((option) => option.id === targetResolution)
    ? targetResolution
    : config.defaults.targetResolution;

export const snapVideoNumFrames = (model: MainModelConfig | undefined, numFrames: number): number => {
  const frames = getVideoConfig(model).frames;

  return frames.kind === 'grid' ? snapWanNumFrames(numFrames) : snapMiniMaxH3NumFrames(numFrames);
};

export const isValidVideoNumFrames = (model: MainModelConfig | undefined, numFrames: number): boolean => {
  const frames = getVideoConfig(model).frames;

  if (frames.kind === 'choices') {
    return frames.choices.includes(numFrames);
  }

  return (
    Number.isInteger(numFrames) &&
    numFrames >= frames.min &&
    numFrames <= frames.max &&
    (numFrames - frames.min) % frames.step === 0
  );
};

export type VideoDimensionSource = 'aspect-ratio' | 'first-frame' | 'last-frame' | 'source-video';

export interface ResolvedVideoDimensions extends VideoDimensions {
  source: VideoDimensionSource;
}

/**
 * Conditioning media overrides preset aspect ratio; target resolution still applies. Returns null for unsupported
 * ratios or degenerate inputs.
 */
export const getVideoDimensions = (
  model: MainModelConfig | undefined,
  settings: Pick<
    VideoSettings,
    'aspectRatioId' | 'targetResolution' | 'firstFrameImage' | 'lastFrameImage' | 'sourceVideo'
  >
): ResolvedVideoDimensions | null => {
  const config = getVideoConfig(model);
  const targetResolution = coerceTargetResolution(config, settings.targetResolution);

  const media = settings.sourceVideo
    ? { ...settings.sourceVideo, source: 'source-video' as const }
    : settings.firstFrameImage
      ? { ...settings.firstFrameImage, source: 'first-frame' as const }
      : settings.lastFrameImage
        ? { ...settings.lastFrameImage, source: 'last-frame' as const }
        : null;

  const inputs = media ?? { ...getVideoAspectRatioParts(settings.aspectRatioId), source: 'aspect-ratio' as const };

  const dimensions =
    model?.base === 'minimax-h3'
      ? resolveMiniMaxH3Canvas(inputs.width, inputs.height, targetResolution as '768 highres' | '768 lowres')
      : scaleAndSnapWanDimensions(
          inputs.width,
          inputs.height,
          targetResolution as '480p' | '720p' | '1080p',
          config.pixelMultiple
        );

  return dimensions ? { ...dimensions, source: inputs.source } : null;
};

export const getVideoPromptPolicy = (
  model: MainModelConfig | undefined,
  settings: Pick<VideoSettings, 'cfgScale' | 'cfgScaleLowNoise' | 'negativePromptEnabled' | 'wanLowNoiseModel'>
) => {
  const config = getVideoConfig(model);
  // Match wan_video_denoise.do_cfg: a second expert using CFG > 1 also consumes negative conditioning.
  const lowNoiseCfgActive =
    config.cfg.lowNoiseVisible &&
    (model?.format === 'diffusers' || settings.wanLowNoiseModel !== null) &&
    settings.cfgScaleLowNoise !== null &&
    settings.cfgScaleLowNoise > 1;
  const negativeUsedInGraph =
    settings.negativePromptEnabled &&
    (config.negativePrompt.usage === 'always' ||
      (config.negativePrompt.usage === 'cfg-gated' && (settings.cfgScale > 1 || lowNoiseCfgActive)));

  return {
    negativeVisible: config.negativePrompt.visible,
    negativeUsedInGraph,
    ...(config.negativePrompt.usage === 'cfg-gated' ? { negativeHelpTextKey: 'widgets.video.negativeCfgHelp' } : {}),
  };
};

export interface VideoModelPolicy {
  isSupported: boolean;
  modes: readonly VideoGenerationMode[];
  pixelMultiple: number;
  /** The family's floor for the steps control (validation enforces it too). */
  minSteps: number;
  aspectRatioOptions: readonly VideoAspectRatioId[];
  targetResolutions: readonly VideoTargetResolutionOption[];
  frames: VideoFramesPolicy;
  fps: VideoFpsPolicy;
  defaults: {
    targetResolution: VideoTargetResolution;
    steps: number;
    cfgScale: number;
    cfgScaleLowNoise: number | null;
  };
  prompt: {
    negativeVisible: boolean;
    negativeUsedInGraph: boolean;
    /** Translation key for the negative prompt's inline help; absent when the field needs none. */
    negativeHelpTextKey?: string;
  };
  /** Ref2VA reference caps; null unless the effective variant has a reference mode. */
  references: { maxVideos: number; maxImages: number; extend?: boolean } | null;
  ui: {
    cfgVisible: boolean;
    cfgLowNoiseVisible: boolean;
    fpsVisible: boolean;
    /** The family's distillation fast path, or null when it has none. */
    accelerator: VideoAcceleratorConfig | null;
    /** Steps for the fast path as currently configured, or null when it has none. */
    acceleratorSteps: number | null;
    audioOutput: boolean;
  };
}

export const getVideoModelPolicy = (model: MainModelConfig | undefined, settings: VideoSettings): VideoModelPolicy => {
  const config = getVideoConfig(model);

  return {
    aspectRatioOptions: getVideoAspectRatioOptions(model),
    defaults: config.defaults,
    fps: config.fps,
    frames: config.frames,
    isSupported: model ? isSupportedVideoModel(model) : false,
    minSteps: config.minSteps,
    modes: config.modes,
    pixelMultiple: config.pixelMultiple,
    prompt: getVideoPromptPolicy(model, settings),
    references: config.references ?? null,
    targetResolutions: config.targetResolutions,
    ui: {
      accelerator: config.accelerator,
      // Show the active LoRA's schedule while retaining accelerator as the family reference config.
      acceleratorSteps: config.accelerator
        ? getAcceleratorSteps(config.accelerator, getRecordedAcceleratorLoras(settings))
        : null,
      audioOutput: config.audioOutput,
      cfgLowNoiseVisible: config.cfg.lowNoiseVisible,
      cfgVisible: config.cfg.visible,
      fpsVisible: config.fps.editable,
    },
  };
};

export interface WanLightningLoraPair {
  high: LoraModelConfig;
  low: LoraModelConfig;
}

export interface FindAcceleratorLoraOptions {
  /** Require the model-family token for user-list candidates to reject look-alike or wrong-family accelerators. */
  requireFamilyName?: boolean;
}

/** MiniMax H3 only: the task variant decides which Turbo distillation qualifies. */
export interface FindMiniMaxH3TurboLoraOptions extends FindAcceleratorLoraOptions {
  /** The effective model's variant; ref2va REQUIRES the ref2v-token repack, every other variant excludes it. */
  variant?: string | null;
}

// Delimit both sides with non-alphanumerics: word boundaries miss underscore-separated tokens, while suffix
// matching accepts Slow/Thigh.
const HIGH_NOISE_PATTERN = /(?:^|[^a-z0-9])high(?:[^a-z0-9]|$)/i;
const LOW_NOISE_PATTERN = /(?:^|[^a-z0-9])low(?:[^a-z0-9]|$)/i;

/**
 * Prefer the main's family and assign experts from names. requireFamilyName rejects fallback matches, including
 * models with no known family token.
 */
export const findWanLightningLoraPair = (
  models: readonly ModelConfig[],
  mainVariant: string | null | undefined,
  { requireFamilyName = false }: FindAcceleratorLoraOptions = {}
): WanLightningLoraPair | null => {
  const candidates = models.filter(
    (model): model is ModelConfig & LoraModelConfig =>
      isLoraModelConfig(model) &&
      model.base === 'wan' &&
      /lightning/i.test(model.name) &&
      isWanLoraTargetingMain(model.variant, mainVariant)
  );

  // Delimited-token match so 'i2v' cannot score inside "TI2V".
  const familyToken = typeof mainVariant === 'string' ? mainVariant.split('_')[0] : undefined;
  const familyPattern = familyToken ? new RegExp(`(?:^|[^a-z0-9])${familyToken}(?:[^a-z0-9]|$)`, 'i') : null;
  const score = (model: LoraModelConfig): number => (familyPattern?.test(model.name) ? 0 : 1);
  const pick = (pattern: RegExp): LoraModelConfig | null =>
    candidates
      .filter((model) => pattern.test(model.name) && (!requireFamilyName || score(model) === 0))
      .sort((a, b) => score(a) - score(b))[0] ?? null;

  const high = pick(HIGH_NOISE_PATTERN);
  const low = pick(LOW_NOISE_PATTERN);

  return high && low && high.key !== low.key ? { high, low } : null;
};

const TURBO_PATTERN = /(?:^|[^a-z0-9])turbo(?:[^a-z0-9]|$)/i;
// Recognize both starter names and raw LightX2V filenames retained by URL installs.
const LIGHTX2V_RELEASE_PATTERN =
  /(?:^|[^a-z0-9])lightx2v(?:[^a-z0-9]|$)|minimax_h3_(?:fl2v|ref2v)_turbo_\d{1,2}step_v\d/i;
const MINIMAX_H3_NAME_PATTERN = /(?:^|[^a-z0-9])(?:minimax|h3)(?:[^a-z0-9]|$)/i;
// Ref2V Turbo is Ref2VA-trained and must never auto-apply to FL2VA.
const MINIMAX_H3_REF2V_PATTERN = /(?:^|[^a-z0-9])ref2va?(?:[^a-z0-9]|$)/i;

/**
 * Match delimited Turbo names, preferring family names then LightX2V releases with deterministic ties. Exclude
 * Ref2VA-trained releases for FL2VA.
 */
export const findMiniMaxH3TurboLora = (
  models: readonly ModelConfig[],
  { requireFamilyName = false, variant = 'fl2va' }: FindMiniMaxH3TurboLoraOptions = {}
): LoraModelConfig | null => {
  // Family name first (0/2), then the LightX2V generation (0/1): a family-named
  // older repack still beats a LightX2V-named look-alike that omits the family.
  const score = (model: LoraModelConfig): number =>
    (MINIMAX_H3_NAME_PATTERN.test(model.name) ? 0 : 2) + (LIGHTX2V_RELEASE_PATTERN.test(model.name) ? 0 : 1);
  // Within a tier, higher stated schedules rank newer. Ref2VA requires Ref2V-trained releases; other tasks exclude
  // them.
  const matchesTask = (name: string): boolean =>
    variant === 'ref2va' ? MINIMAX_H3_REF2V_PATTERN.test(name) : !MINIMAX_H3_REF2V_PATTERN.test(name);

  return (
    models
      .filter(
        (model): model is ModelConfig & LoraModelConfig =>
          isLoraModelConfig(model) &&
          model.base === 'minimax-h3' &&
          TURBO_PATTERN.test(model.name) &&
          matchesTask(model.name) &&
          (!requireFamilyName || MINIMAX_H3_NAME_PATTERN.test(model.name))
      )
      .sort(
        (a, b) =>
          score(a) - score(b) || getStatedStepCount(b.name) - getStatedStepCount(a.name) || a.name.localeCompare(b.name)
      )[0] ?? null
  );
};

/**
 * Return a complete candidate accelerator set or null. Pass the effective model: its H3 task variant determines
 * compatible Turbo releases.
 */
export const findAcceleratorLorasIn = (
  model: MainModelConfig,
  candidates: readonly ModelConfig[],
  options: FindAcceleratorLoraOptions = {}
): LoraModelConfig[] | null => {
  if (model.base === 'minimax-h3') {
    const turbo = findMiniMaxH3TurboLora(candidates, {
      ...options,
      variant: typeof model.variant === 'string' ? model.variant : 'fl2va',
    });

    return turbo ? [turbo] : null;
  }

  const pair = findWanLightningLoraPair(candidates, model.variant, options);

  return pair ? [pair.high, pair.low] : null;
};

// Limit schedule tokens to two digits so checkpoint tags such as step600 cannot become step counts.
const STEP_COUNT_PATTERN = /(?:^|[^a-z0-9])(\d{1,2})[ _-]?steps?(?:[^a-z0-9]|$)/i;

/** The schedule a distillation LoRA's name states, or 0 when it states none. */
const getStatedStepCount = (name: string): number => Number(STEP_COUNT_PATTERN.exec(name)?.[1] ?? 0);

/** Resolve steps from an explicit name token, then release overrides, then family defaults. */
const getLoraAcceleratorSteps = (config: VideoAcceleratorConfig, lora: LoraModelConfig): number => {
  const stated = getStatedStepCount(lora.name);

  if (stated > 0) {
    return stated;
  }

  return config.stepOverrides?.find((override) => override.pattern.test(lora.name))?.steps ?? config.steps;
};

/** Use the higher count for mismatched expert schedules to avoid under-stepping. */
export const getAcceleratorSteps = (config: VideoAcceleratorConfig, loras: readonly LoraModelConfig[]): number =>
  loras.reduce((steps, lora) => Math.max(steps, getLoraAcceleratorSteps(config, lora)), 0) || config.steps;

/** The LoRA models the user currently has switched on in the Concepts list. */
const getEnabledLoraModels = (settings: Pick<VideoSettings, 'loras'>): LoraModelConfig[] =>
  settings.loras.filter((lora) => lora.isEnabled).map((lora) => lora.model);

/** The LoRA models the accelerator toggle recorded, as they stand in the list. */
const getRecordedAcceleratorLoras = (
  settings: Pick<VideoSettings, 'acceleratorEnabled' | 'acceleratorLoraKeys' | 'loras'>
): LoraModelConfig[] => {
  const recorded = new Set(settings.acceleratorLoraKeys);

  return settings.acceleratorEnabled
    ? settings.loras.filter((lora) => recorded.has(lora.model.key)).map((lora) => lora.model)
    : [];
};

/**
 * Accept complete model-family matches or the exact catalog-selected set; the latter permits unusual names
 * installed by the toggle itself.
 */
const findAcceleratorAmong = (
  model: MainModelConfig,
  candidates: readonly LoraModelConfig[],
  models: readonly ModelConfig[]
): LoraModelConfig[] | null => {
  const named = findAcceleratorLorasIn(model, candidates, { requireFamilyName: true });

  if (named) {
    return named;
  }

  const catalogPick = findAcceleratorLorasIn(model, models);

  return catalogPick?.every((lora) => candidates.some((candidate) => candidate.key === lora.key)) ? catalogPick : null;
};

/**
 * Validate only recorded accelerator keys so another enabled candidate cannot displace the user's anchored set
 * through tie-breaking.
 */
const isRecordedAcceleratorIntact = (
  settings: Pick<VideoSettings, 'acceleratorLoraKeys' | 'loras'>,
  model: MainModelConfig,
  models: readonly ModelConfig[],
  config: VideoVariantConfig
): boolean => {
  const recorded = new Set(settings.acceleratorLoraKeys);

  if (!config.accelerator || recorded.size === 0) {
    return false;
  }

  // Deduplicate keys so repeated persisted LoRAs can still reach the unchanged reconciliation outcome.
  const live = [
    ...new Map(
      getEnabledLoraModels(settings)
        .filter((lora) => recorded.has(lora.key))
        .map((lora) => [lora.key, lora])
    ).values(),
  ];

  return live.length === recorded.size && findAcceleratorAmong(model, live, models)?.length === recorded.size;
};

/**
 * Choose only from the installed catalog; user-list names cannot reliably distinguish distillation from personal
 * style LoRAs.
 */
const findAcceleratorLoraEntries = (model: MainModelConfig, models: readonly ModelConfig[]): GenerateLora[] | null =>
  findAcceleratorLorasIn(model, models)?.map((lora) => ({ isEnabled: true, model: lora, weight: 1 })) ?? null;

export interface AcceleratorToggleResult {
  settings: VideoSettings;
  /** True when enabling was requested but the accelerator LoRA(s) are not installed. */
  missingLoras: boolean;
}

/**
 * Encode acceleration through visible LoRAs and sampling settings so graph compilation needs no hidden toggle
 * behavior.
 */
export const getAcceleratorToggleResult = (
  settings: VideoSettings,
  model: MainModelConfig,
  models: readonly ModelConfig[],
  enabled: boolean
): AcceleratorToggleResult => {
  const config = getVideoConfig(model);
  // Remove exactly the entries a previous toggle added — never a user's own
  // LoRA that happens to share a Lightning/Turbo-style name.
  const previousKeys = new Set(settings.acceleratorLoraKeys);
  const withoutAccelerators = settings.loras.filter((lora) => !previousKeys.has(lora.model.key));

  if (!enabled || !config.accelerator) {
    return {
      missingLoras: false,
      settings: {
        ...settings,
        acceleratorEnabled: false,
        acceleratorLoraKeys: [],
        cfgScale: config.defaults.cfgScale,
        cfgScaleLowNoise: config.defaults.cfgScaleLowNoise,
        loras: withoutAccelerators,
        steps: config.defaults.steps,
      },
    };
  }

  const entries = findAcceleratorLoraEntries(model, models);

  if (!entries) {
    // Never leave the flag claiming a fast path that has no LoRAs behind it.
    return {
      missingLoras: true,
      settings: settings.acceleratorEnabled
        ? { ...settings, acceleratorEnabled: false, acceleratorLoraKeys: [] }
        : settings,
    };
  }

  return {
    missingLoras: false,
    settings: {
      ...settings,
      acceleratorEnabled: true,
      acceleratorLoraKeys: entries.map((entry) => entry.model.key),
      cfgScale: config.accelerator.cfgScale,
      cfgScaleLowNoise: config.accelerator.cfgScaleLowNoise,
      loras: [
        ...withoutAccelerators.filter((lora) => !entries.some((e) => e.model.key === lora.model.key)),
        ...entries,
      ],
      steps: getAcceleratorSteps(
        config.accelerator,
        entries.map((entry) => entry.model)
      ),
    },
  };
};

export type AcceleratorLoraChangeOutcome = 'unchanged' | 'switched' | 'disabled';

export interface AcceleratorLoraChangeResult {
  settings: VideoSettings;
  outcome: AcceleratorLoraChangeOutcome;
  /** The LoRA set now driving the fast path — only set when `outcome` is 'switched'. */
  acceleratorLoras: LoraModelConfig[] | null;
}

/**
 * Repair an enabled accelerator from the edited Concepts list: reanchor a complete replacement or disable and
 * restore model defaults. Never enable from a list edit; name heuristics cannot establish that a user LoRA
 * supports distillation.
 */
export const getAcceleratorLoraChangeResult = (
  settings: VideoSettings,
  model: MainModelConfig,
  models: readonly ModelConfig[],
  loras: GenerateLora[]
): AcceleratorLoraChangeResult => {
  const config = getVideoConfig(model);
  const next: VideoSettings = { ...settings, loras };

  // Nothing to repair, and nothing this function is allowed to start.
  if (!settings.acceleratorEnabled) {
    return { acceleratorLoras: null, outcome: 'unchanged', settings: next };
  }

  // The recorded set is still running: leave everything the user tuned alone.
  if (isRecordedAcceleratorIntact(next, model, models, config)) {
    return { acceleratorLoras: null, outcome: 'unchanged', settings: next };
  }

  const replacement = config.accelerator ? findAcceleratorAmong(model, getEnabledLoraModels(next), models) : null;

  if (replacement && config.accelerator) {
    return {
      acceleratorLoras: replacement,
      outcome: 'switched',
      settings: {
        ...next,
        acceleratorEnabled: true,
        acceleratorLoraKeys: replacement.map((lora) => lora.key),
        cfgScale: config.accelerator.cfgScale,
        cfgScaleLowNoise: config.accelerator.cfgScaleLowNoise,
        steps: getAcceleratorSteps(config.accelerator, replacement),
      },
    };
  }

  return {
    acceleratorLoras: null,
    outcome: 'disabled',
    settings: {
      ...next,
      acceleratorEnabled: false,
      acceleratorLoraKeys: [],
      cfgScale: config.defaults.cfgScale,
      cfgScaleLowNoise: config.defaults.cfgScaleLowNoise,
      steps: config.defaults.steps,
    },
  };
};

export type VideoComponentValueKey =
  | 'vae'
  | 'wanT5EncoderModel'
  | 'wanLowNoiseModel'
  | 'componentSourceModel'
  | 'h3TransformerModel'
  | 'h3TextEncoderModel'
  | 'h3HybridBaseModel';

export interface VideoComponentPolicyContext {
  model: MainModelConfig;
  settings: VideoSettings;
  selectedComponents: Pick<VideoSettings, VideoComponentValueKey>;
}

export interface VideoComponentSlotPolicy {
  key: VideoComponentValueKey;
  label: string;
  modelTypes: readonly ModelTaxonomyType[];
  valueKind: 'component' | 'vae' | 'main';
  /** Translation key for the slot's inline help. The core is UI-free, so the section resolves it. */
  helpTextKey?: string;
  filter?: (candidate: ModelConfig, ctx: VideoComponentPolicyContext) => boolean;
  required?: (ctx: VideoComponentPolicyContext) => boolean;
  missingMessage?: string;
}

export interface VideoComponentSectionPolicy {
  defaultOpen: boolean;
  slots: readonly VideoComponentSlotPolicy[];
  validate: (ctx: VideoComponentPolicyContext) => string[];
}

const VIDEO_COMPONENT_SETTING_LABELS: Record<VideoComponentValueKey, string> = {
  componentSourceModel: 'Component source',
  h3HybridBaseModel: 'Hybrid quality base',
  h3TextEncoderModel: 'Text encoder (single file)',
  h3TransformerModel: 'Transformer (single file)',
  vae: 'VAE',
  wanLowNoiseModel: 'Low-noise expert',
  wanT5EncoderModel: 'Wan T5 Encoder',
};

const isTi2v5b = (variant: unknown): boolean => variant === 'ti2v_5b';

// A Diffusers Wan main bundles its own VAE and encoder; a GGUF/checkpoint main
// needs them from standalone models or a Diffusers component source.
const getWanComponentSource = (ctx: VideoComponentPolicyContext) =>
  getCompatibleDiffusersComponentSource(ctx.model, ctx.settings.componentSourceModel);

// The UMT5-XXL encoder is shared across Wan families, so any Diffusers source
// supplies it.
const isWanEncoderSatisfied = (ctx: VideoComponentPolicyContext): boolean =>
  ctx.model.format === 'diffusers' || Boolean(getWanComponentSource(ctx));

// The VAE is family-bound (wan_model_loader's source-VAE validation): a source
// only covers it when its TI2V-5B-ness matches the main's.
const isWanVaeSatisfied = (ctx: VideoComponentPolicyContext): boolean => {
  if (ctx.model.format === 'diffusers') {
    return true;
  }

  const source = getWanComponentSource(ctx);

  return Boolean(source) && isTi2v5b(source?.variant) === isTi2v5b(ctx.model.variant);
};

const validateSlots = (slots: readonly VideoComponentSlotPolicy[], ctx: VideoComponentPolicyContext): string[] =>
  slots.flatMap((slotPolicy) => {
    if (!slotPolicy.required?.(ctx)) {
      return [];
    }

    const value = ctx.selectedComponents[slotPolicy.key];
    const isValid = value && (!slotPolicy.filter || slotPolicy.filter(value as ModelConfig, ctx));

    return isValid ? [] : [slotPolicy.missingMessage ?? `Video needs a ${slotPolicy.label} for this model.`];
  });

const createComponentPolicy = (
  defaultOpen: boolean,
  slots: readonly VideoComponentSlotPolicy[]
): VideoComponentSectionPolicy => ({
  defaultOpen,
  slots,
  validate: (ctx) => validateSlots(slots, ctx),
});

const EMPTY_VIDEO_COMPONENT_POLICY = createComponentPolicy(false, []);

// Low-noise experts must be distinct single-file models of the same variant. Allow unknown variants for backend
// probing.
const isWanLowNoiseExpertCandidate = (candidate: ModelConfig, ctx: VideoComponentPolicyContext): boolean =>
  candidate.type === 'main' &&
  candidate.base === 'wan' &&
  candidate.format !== 'diffusers' &&
  candidate.key !== ctx.model.key &&
  (typeof candidate.variant !== 'string' ||
    typeof ctx.model.variant !== 'string' ||
    candidate.variant === ctx.model.variant);

// TI2V-5B requires 48 VAE channels; A14B requires 16. Allow unspecified channels. Do not await capabilities here:
// early widget sync could otherwise delete and persist a valid stored VAE.
const isWanVaeForMain = (candidate: ModelConfig, ctx: VideoComponentPolicyContext): boolean => {
  if (candidate.type !== 'vae' || candidate.base !== 'wan') {
    return false;
  }

  const latentChannels = candidate.latent_channels;

  if (typeof latentChannels !== 'number') {
    return true;
  }

  return latentChannels === (isTi2v5b(ctx.model.variant) ? 48 : 16);
};

// Both spelled out as `…Key` properties so the translation-key scan sees them.
const H3_DIFFUSERS_TEXT_ENCODER_HELP = {
  optionalKey: 'widgets.video.componentSlots.h3TextEncoderOptionalHelp',
  requiredKey: 'widgets.video.componentSlots.h3TextEncoderRequiredHelp',
} as const;

export const getVideoComponentSectionPolicy = (
  model: MainModelConfig | undefined,
  _settings: VideoSettings
): VideoComponentSectionPolicy => {
  if (!model || !isSupportedVideoModel(model)) {
    return EMPTY_VIDEO_COMPONENT_POLICY;
  }

  if (model.base === 'wan') {
    const config = getVideoConfig(model);
    const slots: VideoComponentSlotPolicy[] = [
      // Diffusers mains supply their own components and ignore this input; offer it only for single-file mains.
      ...(model.format === 'diffusers'
        ? []
        : [
            {
              filter: (candidate: ModelConfig, ctx: VideoComponentPolicyContext) =>
                isDiffusersMainForBase('wan')(candidate) && candidate.key !== ctx.model.key,
              helpTextKey: 'widgets.video.componentSlots.wanComponentSourceHelp',
              key: 'componentSourceModel',
              label: 'Component source',
              modelTypes: ['main'],
              valueKind: 'main',
            } satisfies VideoComponentSlotPolicy,
          ]),
      {
        filter: isWanVaeForMain,
        helpTextKey: 'widgets.video.componentSlots.wanOptionalWithSourceHelp',
        key: 'vae',
        label: 'VAE',
        missingMessage: 'Video needs a VAE for Wan models.',
        modelTypes: ['vae'],
        required: (ctx) => !isWanVaeSatisfied(ctx),
        valueKind: 'vae',
      },
      {
        filter: (candidate) => candidate.type === 'wan_t5_encoder',
        helpTextKey: 'widgets.video.componentSlots.wanOptionalWithSourceHelp',
        key: 'wanT5EncoderModel',
        label: 'Wan T5 Encoder',
        missingMessage: 'Video needs a Wan T5 Encoder for Wan models.',
        modelTypes: ['wan_t5_encoder'],
        required: (ctx) => !isWanEncoderSatisfied(ctx),
        valueKind: 'component',
      },
    ];

    // TI2V-5B has one expert; Diffusers A14B bundles the second. Only single-file A14B needs this slot.
    if (config.cfg.lowNoiseVisible && model.format !== 'diffusers') {
      slots.push({
        filter: isWanLowNoiseExpertCandidate,
        helpTextKey: 'widgets.video.componentSlots.wanLowNoiseHelp',
        key: 'wanLowNoiseModel',
        label: 'Transformer (Low Noise)',
        modelTypes: ['main'],
        valueKind: 'main',
      });
    }

    return createComponentPolicy(model.format !== 'diffusers', slots);
  }

  // H3 checkpoint mains require a Diffusers component source; components-only sources also require a Qwen3-VL
  // override. Full Diffusers mains bundle both.
  if (model.format === 'diffusers') {
    // Legacy components-only mains remain visible; require the missing encoder while validation requests a
    // single-file transformer main.
    const componentsOnly = isComponentsOnlyH3Main(model);

    return createComponentPolicy(componentsOnly, [
      {
        filter: (candidate) => candidate.type === 'qwen3_vl_encoder' && candidate.base === 'minimax-h3',
        helpTextKey: componentsOnly
          ? H3_DIFFUSERS_TEXT_ENCODER_HELP.requiredKey
          : H3_DIFFUSERS_TEXT_ENCODER_HELP.optionalKey,
        key: 'h3TextEncoderModel',
        label: 'Text encoder (single file)',
        missingMessage: `${model.name} is a components-only install — select a single-file Text encoder.`,
        modelTypes: ['qwen3_vl_encoder'],
        required: componentsOnly ? () => true : undefined,
        valueKind: 'component',
      },
    ]);
  }

  return createComponentPolicy(true, [
    {
      filter: (candidate) =>
        candidate.type === 'main' && candidate.base === 'minimax-h3' && candidate.format === 'diffusers',
      helpTextKey: 'widgets.video.componentSlots.h3ComponentSourceHelp',
      key: 'componentSourceModel',
      label: 'Model components',
      missingMessage: `${model.name} is a single-file transformer — select a Diffusers MiniMax H3 install under Model Components.`,
      modelTypes: ['main'],
      required: () => true,
      valueKind: 'main',
    },
    {
      filter: (candidate) => candidate.type === 'qwen3_vl_encoder' && candidate.base === 'minimax-h3',
      helpTextKey: 'widgets.video.componentSlots.h3TextEncoderCheckpointHelp',
      key: 'h3TextEncoderModel',
      label: 'Text encoder (single file)',
      missingMessage:
        'The selected Model Components install has no text-encoder weights — select a single-file Text encoder.',
      modelTypes: ['qwen3_vl_encoder'],
      required: (ctx) => !isH3TextEncoderSatisfied(ctx),
      valueKind: 'component',
    },
    // The hybrid replaces non-AdaLN weights with an FL2VA base while retaining Ref2VA task identity and
    // projections.
    ...(model.variant === 'ref2va'
      ? [
          {
            filter: isH3HybridBaseCandidate,
            helpTextKey: 'widgets.video.componentSlots.h3HybridBaseHelp',
            key: 'h3HybridBaseModel',
            label: 'Hybrid quality base (FL2VA)',
            modelTypes: ['main'],
            valueKind: 'main',
          } satisfies VideoComponentSlotPolicy,
        ]
      : []),
  ]);
};

// Pruned/full AdaLN shapes differ: require matching checkpoint kinds, leaving unspecified flags to backend
// validation.
const isH3HybridBaseCandidate = (candidate: ModelConfig, ctx: VideoComponentPolicyContext): boolean =>
  candidate.type === 'main' &&
  candidate.base === 'minimax-h3' &&
  candidate.format === 'checkpoint' &&
  candidate.variant === 'fl2va' &&
  candidate.key !== ctx.model.key &&
  (typeof candidate.pruned !== 'boolean' ||
    typeof ctx.model.pruned !== 'boolean' ||
    candidate.pruned === ctx.model.pruned);

/** The H3 Diffusers install a checkpoint main draws its components from, if a valid one is selected. */
const getH3ComponentSource = (ctx: VideoComponentPolicyContext): MainModelConfig | null => {
  const source = ctx.settings.componentSourceModel;

  return source && source.base === 'minimax-h3' && source.format === 'diffusers' ? source : null;
};

// A full Diffusers source carries text-encoder weights; a components-only one
// does not, so the single-file Qwen3-VL override becomes required.
const isH3TextEncoderSatisfied = (ctx: VideoComponentPolicyContext): boolean => {
  const source = getH3ComponentSource(ctx);

  return source !== null && !isComponentsOnlyH3Main(source);
};

const getVideoComponentPolicyContext = (
  model: MainModelConfig,
  settings: VideoSettings
): VideoComponentPolicyContext => ({
  model,
  selectedComponents: {
    componentSourceModel: settings.componentSourceModel,
    h3HybridBaseModel: settings.h3HybridBaseModel,
    h3TextEncoderModel: settings.h3TextEncoderModel,
    h3TransformerModel: settings.h3TransformerModel,
    vae: settings.vae,
    wanLowNoiseModel: settings.wanLowNoiseModel,
    wanT5EncoderModel: settings.wanT5EncoderModel,
  },
  settings,
});

export type WanExpertWiringWarning =
  | { kind: 'swapped' }
  | { kind: 'high-as-low' }
  | { kind: 'low-as-main' }
  | { kind: 'single-low' }
  | null;

const getWanExpertTag = (model: MainModelConfig | null): 'high' | 'low' | 'none' => {
  const expert = (model as Record<string, unknown> | null)?.expert;

  return expert === 'high' || expert === 'low' ? expert : 'none';
};

/**
 * Expert tags are advisory filename heuristics; explicit wiring remains authoritative and mismatches do not block
 * generation.
 */
export const getWanExpertWiringWarning = (
  model: MainModelConfig | null,
  wanLowNoiseModel: MainModelConfig | null
): WanExpertWiringWarning => {
  // Only single-file A14B mains run the explicit high/low wiring.
  if (!model || model.base !== 'wan' || model.format === 'diffusers') {
    return null;
  }

  const config = getVideoConfig(model);

  if (!config.cfg.lowNoiseVisible) {
    return null;
  }

  const mainTag = getWanExpertTag(model);
  const lowTag = getWanExpertTag(wanLowNoiseModel);

  if (wanLowNoiseModel) {
    if (mainTag === 'low' && lowTag === 'high') {
      return { kind: 'swapped' };
    }
    if (lowTag === 'high') {
      return { kind: 'high-as-low' };
    }
    if (mainTag === 'low') {
      return { kind: 'low-as-main' };
    }

    return null;
  }

  // Single expert running the whole schedule: fine for an untagged or
  // high-tagged file, but a low-tagged one is usually the wrong single pick.
  return mainTag === 'low' ? { kind: 'single-low' } : null;
};

/**
 * Prefer full H3 Diffusers installs for checkpoint components; components-only sources also qualify when no full
 * install exists.
 */
const findH3ComponentSource = (models: readonly ModelConfig[]): MainModelConfig | null => {
  const candidates = models.filter(
    (candidate): candidate is ModelConfig & MainModelConfig =>
      candidate.type === 'main' && candidate.base === 'minimax-h3' && candidate.format === 'diffusers'
  );

  return candidates.find((candidate) => !isComponentsOnlyH3Main(candidate)) ?? candidates[0] ?? null;
};

export const getDefaultVideoSettings = (
  model?: MainModelConfig,
  models: readonly ModelConfig[] = []
): VideoSettings => {
  const config = getVideoConfig(model);

  const base: VideoSettings = {
    acceleratorEnabled: false,
    acceleratorLoraKeys: [],
    aspectRatioId: '16:9',
    batchCount: 1,
    cfgScale: config.defaults.cfgScale,
    cfgScaleLowNoise: config.defaults.cfgScaleLowNoise,
    componentSourceModel:
      model && model.base === 'minimax-h3' && model.format === 'checkpoint' ? findH3ComponentSource(models) : null,
    firstFrameImage: null,
    fps: config.fps.defaultValue,
    h3HybridBaseModel: null,
    h3HybridStartBlock: MINIMAX_H3_HYBRID_BLOCK_RANGE.defaultStart,
    h3TextEncoderModel: null,
    h3TransformerModel: null,
    lastFrameImage: null,
    loras: [],
    modelKey: model?.key ?? '',
    negativePrompt: '',
    negativePromptEnabled: true,
    negativePromptHeightPx: 56,
    numFrames: config.frames.defaultValue,
    positivePrompt: '',
    positivePromptHeightPx: 96,
    references: [],
    seed: Math.floor(Math.random() * SEED_MAX),
    seedMode: 'random',
    sourceVideo: null,
    steps: config.defaults.steps,
    targetResolution: config.defaults.targetResolution,
    vae: null,
    wanLowNoiseModel: null,
    wanT5EncoderModel: null,
  };

  // Enable installed accelerators by default, matching bundled templates' practical sampling schedules.
  if (model && config.accelerator) {
    const result = getAcceleratorToggleResult(base, model, models, true);

    if (!result.missingLoras) {
      return result.settings;
    }
  }

  return base;
};

export const getVideoSettingsWithModelDefaults = (
  settings: VideoSettings,
  model: MainModelConfig,
  models: readonly ModelConfig[] = []
): VideoSettings => {
  const modelDefaults = getDefaultVideoSettings(model, models);

  const previousKeys = new Set(settings.acceleratorLoraKeys);

  return {
    ...settings,
    acceleratorEnabled: modelDefaults.acceleratorEnabled,
    acceleratorLoraKeys: modelDefaults.acceleratorLoraKeys,
    aspectRatioId: modelDefaults.aspectRatioId,
    cfgScale: modelDefaults.cfgScale,
    cfgScaleLowNoise: modelDefaults.cfgScaleLowNoise,
    componentSourceModel: modelDefaults.componentSourceModel,
    fps: modelDefaults.fps,
    h3HybridBaseModel: modelDefaults.h3HybridBaseModel,
    h3HybridStartBlock: modelDefaults.h3HybridStartBlock,
    h3TextEncoderModel: modelDefaults.h3TextEncoderModel,
    h3TransformerModel: modelDefaults.h3TransformerModel,
    loras: [
      ...settings.loras.filter(
        (lora) => !previousKeys.has(lora.model.key) && !modelDefaults.loras.some((d) => d.model.key === lora.model.key)
      ),
      ...modelDefaults.loras,
    ].map((lora) => (isLoraCompatibleWithModel(lora.model, model) ? lora : { ...lora, isEnabled: false })),
    modelKey: model.key,
    numFrames: modelDefaults.numFrames,
    // Reset references with components while preserving valid frame/source conditioning.
    references: modelDefaults.references,
    steps: modelDefaults.steps,
    targetResolution: modelDefaults.targetResolution,
    vae: modelDefaults.vae,
    wanLowNoiseModel: modelDefaults.wanLowNoiseModel,
    wanT5EncoderModel: modelDefaults.wanT5EncoderModel,
  };
};

export interface VideoModelSelectionResult {
  settings: VideoSettings;
  clearedLabels: readonly string[];
}

const addClearedLabel = (labels: string[], label: string) => {
  if (!labels.includes(label)) {
    labels.push(label);
  }
};

/**
 * Use one model-selection transition to reconcile media, sampling constraints, LoRAs, and components and report
 * cleared inputs.
 */
export const getVideoModelSelectionResult = ({
  currentSettings,
  model,
  models,
}: {
  currentSettings: VideoSettings;
  model: MainModelConfig;
  models: readonly ModelConfig[];
}): VideoModelSelectionResult => {
  const config = getVideoConfig(model);
  // Missing modelKey means healing defaults, not user choices; bootstrap selected-model defaults before
  // reconciling seeded media.
  const start = currentSettings.modelKey
    ? currentSettings
    : getVideoSettingsWithModelDefaults(currentSettings, model, models);
  const next: VideoSettings = { ...start, modelKey: model.key };
  const clearedLabels: string[] = [];
  const modes = config.modes;

  if (next.references.length > 0 && !modes.includes('reference')) {
    next.references = [];
    addClearedLabel(clearedLabels, 'References');
  }

  if (next.sourceVideo && !modes.includes('extend') && !config.references?.extend) {
    next.sourceVideo = null;
    addClearedLabel(clearedLabels, 'Initial video');
  }

  // Snap frame count before deriving reference context so cross-family switches cannot retain an undersized Wan
  // budget.
  const snappedFrames = snapVideoNumFrames(model, next.numFrames);
  const framesChanged = snappedFrames !== next.numFrames;

  if (framesChanged) {
    next.numFrames = snappedFrames;
    addClearedLabel(clearedLabels, 'Frames');
  }

  // Derive a missing source anchor on model switch; avoid resetting hand-tuned trims on task-neutral transitions.
  if (
    config.references?.extend &&
    next.sourceVideo &&
    !next.references.some((entry) => entry.kind === 'video' && entry.fromSourceVideo === true)
  ) {
    next.references = applyReferenceExtendSourceVideo(
      next.references,
      next.sourceVideo,
      config.references.maxVideos,
      next.numFrames
    );
  }

  // Rebudget inherited tails only when frame count changes, preserving trims on neutral reselection.
  if (config.references?.extend && framesChanged) {
    next.references = applyReferenceExtendNumFrames(next.references, next.numFrames);
  }

  if (next.firstFrameImage && !modes.includes('first-frame') && !modes.includes('first-last')) {
    next.firstFrameImage = null;
    addClearedLabel(clearedLabels, 'First frame');
  }

  if (next.lastFrameImage) {
    // The end-frame anchor rides the FLF2V channel whether its partner is a
    // first frame or a source video; alone it needs a dedicated last-frame mode.
    const lastFrameSupported =
      next.firstFrameImage || next.sourceVideo ? modes.includes('first-last') : modes.includes('last-frame');

    if (!lastFrameSupported) {
      next.lastFrameImage = null;
      addClearedLabel(clearedLabels, 'Last frame');
    }
  }

  if (!config.targetResolutions.some((option) => option.id === next.targetResolution)) {
    next.targetResolution = config.defaults.targetResolution;
    addClearedLabel(clearedLabels, 'Target resolution');
  }

  const clampedFps =
    config.fps.editable && Number.isFinite(next.fps)
      ? Math.min(config.fps.max, Math.max(config.fps.min, Math.round(next.fps)))
      : config.fps.defaultValue;

  if (clampedFps !== next.fps) {
    next.fps = clampedFps;
    addClearedLabel(clearedLabels, 'FPS');
  }

  if (next.acceleratorEnabled) {
    // Preserve tuned acceleration when its LoRAs remain compatible. Otherwise reapply the new family's accelerator
    // or restore normal sampling if unavailable.
    if (!isRecordedAcceleratorIntact(next, model, models, config)) {
      const targetEntries = config.accelerator ? findAcceleratorLoraEntries(model, models) : null;
      const result = getAcceleratorToggleResult(next, model, models, targetEntries !== null);

      Object.assign(next, result.settings);
      addClearedLabel(clearedLabels, 'Acceleration');
    }
  }

  if (next.cfgScaleLowNoise !== null && !config.cfg.lowNoiseVisible) {
    next.cfgScaleLowNoise = null;
    addClearedLabel(clearedLabels, 'CFG (Low Noise)');
  }

  const compatibleLoras = next.loras.filter((lora) => isLoraCompatibleWithModel(lora.model, model));

  if (compatibleLoras.length !== next.loras.length) {
    next.loras = compatibleLoras;
    addClearedLabel(clearedLabels, 'LoRAs');
  }

  const policy = getVideoComponentSectionPolicy(model, next);
  const slotsByKey = new Map(policy.slots.map((slotPolicy) => [slotPolicy.key, slotPolicy]));

  for (const key of Object.keys(VIDEO_COMPONENT_SETTING_LABELS) as VideoComponentValueKey[]) {
    const value = next[key];

    if (!value) {
      continue;
    }

    const slotPolicy = slotsByKey.get(key);
    const isCompatible =
      slotPolicy &&
      (!slotPolicy.filter || slotPolicy.filter(value as ModelConfig, getVideoComponentPolicyContext(model, next)));

    if (!isCompatible) {
      next[key] = null;
      addClearedLabel(clearedLabels, VIDEO_COMPONENT_SETTING_LABELS[key]);
    }
  }

  // Autofill required H3 components only when empty; preserve explicit compatible choices.
  if (model.base === 'minimax-h3' && model.format === 'checkpoint' && !next.componentSourceModel) {
    next.componentSourceModel = findH3ComponentSource(models);
  }

  return { clearedLabels, settings: next };
};

const VIDEO_MODE_DESCRIPTIONS: Record<VideoGenerationMode, string> = {
  extend: 'extending a video',
  'first-frame': 'starting from a first frame',
  'first-last': 'first-to-last-frame interpolation',
  'last-frame': 'ending on a last frame',
  reference: 'reference-conditioned generation',
  txt2vid: 'text-to-video',
};

const hasModelKey = (models: readonly ModelConfig[], key: string, type?: string): boolean =>
  models.some((model) => model.key === key && (!type || model.type === type));

export const getVideoModelAvailabilityReasons = (
  model: MainModelConfig,
  settings: VideoSettings,
  models: readonly ModelConfig[]
): string[] => {
  const reasons: string[] = [];

  if (!hasModelKey(models, model.key, model.type)) {
    reasons.push(`Selected model "${model.name}" is no longer installed.`);
  }

  for (const key of Object.keys(VIDEO_COMPONENT_SETTING_LABELS) as VideoComponentValueKey[]) {
    const value = settings[key];

    if (value && !hasModelKey(models, value.key, value.type)) {
      reasons.push(`${VIDEO_COMPONENT_SETTING_LABELS[key]} "${value.name}" is no longer installed.`);
    }
  }

  for (const lora of settings.loras) {
    if (!hasModelKey(models, lora.model.key, 'lora')) {
      reasons.push(`LoRA "${lora.model.name}" is no longer installed.`);
    }
  }

  return reasons;
};

export const getVideoValidationReasons = (model: MainModelConfig, settings: VideoSettings): string[] => {
  if (!isSupportedVideoModel(model)) {
    return ['Video needs a supported video model before it can be invoked.'];
  }

  // Give repair guidance for stored supported-but-unselectable H3 configurations.
  if (isComponentsOnlyH3Main(model)) {
    return [
      `${model.name} is a components-only install. Select a single-file MiniMax H3 transformer as the model; this install then provides its components.`,
    ];
  }
  if (model.base === 'minimax-h3' && model.format === 'diffusers' && model.variant === 'ref2va') {
    return [
      `${model.name} is a Ref2VA folder install, whose transformer weights cannot be folder-loaded. Select a single-file Ref2VA transformer as the model; this install can serve as its Model Components.`,
    ];
  }

  const config = getVideoConfig(model);
  const reasons: string[] = [];
  const mode = resolveVideoMode(settings);
  const referenceOnly = config.modes.length === 1 && config.modes[0] === 'reference';

  if (settings.firstFrameImage && settings.sourceVideo) {
    reasons.push('A first frame and an initial video cannot be combined. Clear one of them.');
  }

  if (settings.references.length > 0 && (settings.firstFrameImage || settings.lastFrameImage)) {
    reasons.push('References cannot be combined with first/last frames. Clear one side.');
  }

  if (settings.references.length > 0 && settings.sourceVideo && !config.references?.extend) {
    reasons.push('References cannot be combined with an initial video on this model. Clear one side.');
  }

  if (!config.modes.includes(mode)) {
    if (referenceOnly && settings.references.length === 0) {
      // Explain the missing reference rather than implying a defective text-to-video model.
      reasons.push('Reference-to-video needs at least one image or video reference.');
    } else {
      reasons.push(`${model.name} does not support ${VIDEO_MODE_DESCRIPTIONS[mode]}.`);
    }
  } else if (mode === 'extend' && settings.lastFrameImage && !config.modes.includes('first-last')) {
    reasons.push(`${model.name} cannot target a destination image while extending a video.`);
  }

  if (mode === 'reference') {
    const caps = config.references;
    const videoCount = settings.references.filter((reference) => reference.kind === 'video').length;
    const imageCount = settings.references.length - videoCount;
    const allAudioOnly =
      settings.references.length > 0 &&
      settings.references.every((reference) => reference.kind === 'video' && reference.conditioning === 'audio');

    if (allAudioOnly) {
      reasons.push(
        'At least one reference must contribute visuals — add an image, or set a video reference to include video.'
      );
    }
    if (caps && videoCount > caps.maxVideos) {
      reasons.push(`At most ${caps.maxVideos} video references are supported.`);
    }
    if (caps && imageCount > caps.maxImages) {
      reasons.push(`At most ${caps.maxImages} image references are supported.`);
    }
    for (const reference of settings.references) {
      if (reference.kind !== 'video') {
        continue;
      }
      if (!Number.isInteger(reference.clip.startFrame) || !Number.isInteger(reference.clip.endFrame)) {
        reasons.push('Reference video trim bounds must be whole frame numbers.');
        break;
      }
      if (
        reference.clip.startFrame < 0 ||
        reference.clip.endFrame > reference.clip.numFrames - 1 ||
        reference.clip.endFrame < reference.clip.startFrame
      ) {
        reasons.push('A reference video trim is outside its clip.');
        break;
      }
    }
  }

  if (!isValidVideoNumFrames(model, settings.numFrames)) {
    reasons.push(
      config.frames.kind === 'grid'
        ? `Frame count must be between ${config.frames.min} and ${config.frames.max} in steps of ${config.frames.step} (4·n + 1).`
        : `Frame count must be one of the ${model.name} grid values (17·n + 5, ${config.frames.choices[0]}–${config.frames.choices[config.frames.choices.length - 1]}).`
    );
  }

  // fps and steps are integer fields on the backend nodes; a fractional value
  // would fail pydantic coercion at enqueue, so reject it here instead.
  if (!Number.isInteger(settings.fps) || settings.fps < config.fps.min || settings.fps > config.fps.max) {
    reasons.push(
      config.fps.editable
        ? `FPS must be a whole number between ${config.fps.min} and ${config.fps.max}.`
        : `${model.name} generates at a fixed ${config.fps.defaultValue} FPS.`
    );
  }

  if (!Number.isInteger(settings.steps) || settings.steps < config.minSteps) {
    reasons.push(`Steps must be a whole number of at least ${config.minSteps}.`);
  }

  if (config.cfg.visible && (!Number.isFinite(settings.cfgScale) || settings.cfgScale < 1)) {
    reasons.push('CFG must be at least 1.');
  }

  if (config.cfg.lowNoiseVisible && settings.cfgScaleLowNoise !== null && settings.cfgScaleLowNoise < 1) {
    reasons.push('CFG (Low Noise) must be at least 1.');
  }

  if (settings.acceleratorEnabled && !config.accelerator) {
    reasons.push(`${model.name} has no distillation fast path. Turn the accelerator off to generate with it.`);
  }

  // The trim bounds are integer fields on extract_video_range; a fractional
  // persisted value would fail pydantic coercion at enqueue.
  if (
    settings.sourceVideo &&
    (!Number.isInteger(settings.sourceVideo.startFrame) || !Number.isInteger(settings.sourceVideo.endFrame))
  ) {
    reasons.push('The initial video trim bounds must be whole frame numbers.');
  } else if (settings.sourceVideo) {
    const { endFrame, numFrames, startFrame } = settings.sourceVideo;

    // Require valid source bounds and at least two frames for crossfade before encoding.
    if (startFrame < 0 || endFrame > numFrames - 1 || endFrame - startFrame + 1 < MIN_VIDEO_TRIM_FRAMES) {
      reasons.push('The initial video trim must keep at least two frames within the clip.');
    }

    if (numFrames < MIN_VIDEO_TRIM_FRAMES) {
      reasons.push('The initial video is too short to extend.');
    }

    // Wan extension inherits source fps; validate the backend's 1–120 range before expensive denoising.
    if (model.base === 'wan') {
      const inheritedFps = Math.round(settings.sourceVideo.fps);

      if (inheritedFps < 1 || inheritedFps > 120) {
        reasons.push(
          `The initial video's frame rate (${settings.sourceVideo.fps} fps) is outside the 1-120 fps range Wan extension supports.`
        );
      }
    }
  }

  if (!getVideoDimensions(model, settings)) {
    reasons.push(
      model.base === 'minimax-h3'
        ? 'MiniMax H3 supports aspect ratios from 1:4 to 4:1. The conditioning media is outside that range.'
        : 'The conditioning media is too small or degenerate to derive video dimensions from.'
    );
  }

  if (model.base === 'wan') {
    // Report incompatible Wan expert-family LoRAs rather than silently dropping weights that would mismatch tensor
    // shapes.
    for (const lora of settings.loras) {
      if (lora.isEnabled && !isWanLoraTargetingMain(lora.model.variant, model.variant)) {
        reasons.push(`${lora.model.name} targets a different Wan model family than ${model.name}.`);
      }
    }
  }

  const componentPolicy = getVideoComponentSectionPolicy(model, settings);
  reasons.push(...componentPolicy.validate(getVideoComponentPolicyContext(model, settings)));

  return reasons;
};
