import type {
  GenerateLora,
  ImageWithDims,
  MainModelConfig,
  ModelIdentifierConfig,
  VaeModelConfig,
} from '@features/generation/contracts';
import type { SeedMode } from '@platform/core/seed';

/** Infer conditioning mode from populated inputs through resolveVideoMode. */
export type VideoGenerationMode = 'txt2vid' | 'first-frame' | 'last-frame' | 'first-last' | 'extend' | 'reference';

/** A gallery video selected as the clip to extend, with the trim range to keep. */
export interface VideoSourceClip {
  video_name: string;
  width: number;
  height: number;
  numFrames: number;
  fps: number;
  /** Inclusive trim bounds forwarded to `extract_video_range`; negative indices count from the end. */
  startFrame: number;
  endFrame: number;
}

/** Reference conditioning maps directly to graph literals; audio uses the clip's soundtrack without visual rows. */
export type VideoReferenceConditioning = 'video_audio' | 'video' | 'audio';

/** Ref2VA image-reference sizing: 'max' = 2048px short edge, 'match' = generation's pixel area. */
export type VideoReferenceImageDetail = 'max' | 'match';

/** Reference order affects generation; retain one ordered mixed-kind array with video trim bounds. */
export type VideoReferenceItem =
  | {
      kind: 'video';
      clip: VideoSourceClip;
      conditioning: VideoReferenceConditioning;
      /**
       * Panel-only marker for the Initial Video continuity anchor, pinned last. Its default trim follows source
       * cutpoints and generated frame count unless trimOverridden is set.
       */
      fromSourceVideo?: boolean;
      /**
       * Panel-only anchor override disables cutpoint/frame-count re-derivation after manual trim edits.
       * Clear/reset source removes it; meaningful only with fromSourceVideo.
       */
      trimOverridden?: boolean;
      /**
       * Panel-only requested length stays separate from clamped clip bounds so drags can restore it; read through
       * referenceSampleFrames.
       */
      sampleFrames?: number;
    }
  | { kind: 'image'; image: ImageWithDims; detail: VideoReferenceImageDetail };

export type WanTargetResolution = '480p' | '720p' | '1080p';
export type MiniMaxH3TargetResolution = '768 highres' | '768 lowres';
export type VideoTargetResolution = WanTargetResolution | MiniMaxH3TargetResolution;

/** Derive dimensions from preset ratio/resolution or conditioning media; no free-size fields are offered. */
export type VideoAspectRatioId = '21:9' | '16:9' | '3:2' | '4:3' | '1:1' | '3:4' | '2:3' | '9:16' | '9:21';

/** Project-persisted settings owned by the Video widget. */
export interface VideoSettings {
  batchCount: number;
  modelKey: string;
  positivePrompt: string;
  positivePromptHeightPx: number;
  negativePromptEnabled: boolean;
  negativePrompt: string;
  negativePromptHeightPx: number;
  /** Image-to-video conditioning. Mutually exclusive with `sourceVideo`. */
  firstFrameImage: ImageWithDims | null;
  /**
   * Last frame supplies interpolation's endpoint or an extension destination, paired with first frame or source
   * video.
   */
  lastFrameImage: ImageWithDims | null;
  /** Source excludes first frame; FL2VA uses extend mode while Ref2VA appends using a linked tail reference. */
  sourceVideo: VideoSourceClip | null;
  /** Ordered Ref2VA references exclude frame slots but may coexist with source video for reference extension. */
  references: VideoReferenceItem[];
  aspectRatioId: VideoAspectRatioId;
  targetResolution: VideoTargetResolution;
  numFrames: number;
  fps: number;
  steps: number;
  cfgScale: number;
  /** Guidance for the low-noise half of a Wan A14B schedule; null reuses `cfgScale`. */
  cfgScaleLowNoise: number | null;
  /**
   * Acceleration patches visible sampling settings and LoRAs; this flag records intent rather than hidden graph
   * state.
   */
  acceleratorEnabled: boolean;
  /**
   * Track exactly the toggle-added LoRA keys for removal; never remove matching user-owned entries, and clear
   * enabled intent if they disappear.
   */
  acceleratorLoraKeys: string[];
  seed: number;
  seedMode: SeedMode;
  loras: GenerateLora[];
  /** Optional VAE override; null uses the VAE bundled with the main model or component source. */
  vae: VaeModelConfig | null;
  /** Wan 2.2's UMT5-XXL text encoder. */
  wanT5EncoderModel: ModelIdentifierConfig | null;
  /** The low-noise expert of a Wan 2.2 A14B mixture-of-experts pair. */
  wanLowNoiseModel: MainModelConfig | null;
  /** Diffusers component source supplies missing non-transformer components for standalone Wan/H3 mains. */
  componentSourceModel: MainModelConfig | null;
  /**
   * Legacy-only transformer override: reconciliation promotes it to model and retains the old main as
   * componentSourceModel; new writes omit it.
   */
  h3TransformerModel: MainModelConfig | null;
  /** Optional single-file MiniMax H3 Qwen3-VL text-encoder override. */
  h3TextEncoderModel: ModelIdentifierConfig | null;
  /**
   * Hybrid loads FL2VA base weights and overlays selected Ref2VA AdaLN from h3HybridStartBlock onward while
   * retaining reference conditioning.
   */
  h3HybridBaseModel: MainModelConfig | null;
  /** First transformer block (0-49) whose AdaLN projection stays Ref2VA's under the hybrid. */
  h3HybridStartBlock: number;
}

export interface VideoWidgetValues extends VideoSettings {
  /** The selected main model; null until the user picks one (or none is installed). */
  model: MainModelConfig | null;
}
