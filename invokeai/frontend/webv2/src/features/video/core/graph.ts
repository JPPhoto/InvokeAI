import type {
  BackendGraphContract,
  BackendInvocationContract,
  GraphContract,
  MainModelConfig,
} from '@features/generation/contracts';

import {
  addEdge,
  addNode,
  addTransformerLoraCollectionLoader,
  createId,
  getActiveCompatibleLoras,
  toGraphContract,
  toModelIdentifier,
} from '@features/generation/graph';
import { getCompatibleDiffusersComponentSource } from '@features/generation/settings';

import type { VideoGenerationMode, VideoReferenceItem, VideoSettings, VideoSourceClip } from './types';

import { MINIMAX_H3_FPS } from './dimensions';
import { MINIMAX_H3_HYBRID_BLOCK_RANGE, resolveVideoMode } from './settings';
import { getVideoDimensions, getVideoModelPolicy, getVideoValidationReasons } from './videoPolicies';

/** Mirror bundled template wiring per model family and expose fixed prompt/seed node IDs for submission batching. */

export interface CompiledVideoGraph {
  backendGraph: BackendGraphContract;
  graph: GraphContract;
  negativePromptNodeId: string;
  positivePromptNodeId: string;
  seedNodeId: string;
}

const WAN_GENERATION_MODES: Partial<Record<VideoGenerationMode, string>> = {
  extend: 'wan_extend_video',
  'first-frame': 'wan_i2v',
  'first-last': 'wan_interpolate',
  txt2vid: 'wan_t2v',
};

const MINIMAX_H3_GENERATION_MODES: Record<VideoGenerationMode, string> = {
  extend: 'minimax_h3_extend_video',
  'first-frame': 'minimax_h3_i2v',
  'first-last': 'minimax_h3_flf2v',
  'last-frame': 'minimax_h3_lf2v',
  reference: 'minimax_h3_ref2v',
  txt2vid: 'minimax_h3_t2v',
};

/**
 * Feed identical ordered references to conditioning and prompt nodes; chain collectors to preserve the request's
 * rotary order.
 */
const addReferenceNodes = (
  graph: BackendGraphContract,
  references: readonly VideoReferenceItem[]
): BackendInvocationContract => {
  let chain: BackendInvocationContract | null = null;
  references.forEach((reference, index) => {
    const node = addReferenceNode(graph, reference, index);
    const collect = addNode(graph, { id: `reference_collect_${index + 1}`, type: 'collect' });

    if (chain) {
      addEdge(graph, chain, 'collection', collect, 'collection');
    }
    addEdge(graph, node, 'reference', collect, 'item');
    chain = collect;
  });

  if (!chain) {
    throw new Error('Reference mode requires at least one reference.');
  }

  return chain;
};

const addReferenceNode = (
  graph: BackendGraphContract,
  reference: VideoReferenceItem,
  index: number
): BackendInvocationContract => {
  if (reference.kind === 'image') {
    return addNode(graph, {
      detail: reference.detail,
      id: `reference_${index + 1}`,
      image: toImageField(reference.image),
      type: 'minimax_h3_image_reference',
    });
  }
  // Compile tail-window bounds relative to the actual backend frame count, as in extension graphs.
  const endFrame = toTailAwareIndex(reference.clip.endFrame, reference.clip.numFrames);

  return addNode(graph, {
    conditioning: reference.conditioning,
    end_frame: endFrame,
    id: `reference_${index + 1}`,
    start_frame: toReferenceStartIndex(reference.clip, endFrame),
    type: 'minimax_h3_video_reference',
    video: { video_name: reference.clip.video_name },
  });
};

/**
 * Convert reference bounds together to preserve length near the tail. Keep starts within TAIL_INDEX_SLOP absolute
 * to avoid negative starts; larger estimate errors remain outside this guard.
 */
const toReferenceStartIndex = (clip: VideoSourceClip, endIndex: number): number => {
  if (endIndex >= 0 || clip.startFrame <= TAIL_INDEX_SLOP) {
    return toTailAwareIndex(clip.startFrame, clip.numFrames);
  }

  return endIndex - (clip.endFrame - clip.startFrame);
};

const addPromptAndSeedNodes = (graph: BackendGraphContract) => ({
  negativePrompt: addNode(graph, { id: 'negative_prompt', type: 'string' }),
  positivePrompt: addNode(graph, { id: 'positive_prompt', type: 'string' }),
  seed: addNode(graph, { id: 'seed', type: 'integer' }),
});

const toImageField = (image: { image_name: string }) => ({ image_name: image.image_name });

// Compile near-end trim bounds as negative indices against actual frame count; keep mid-clip bounds absolute to
// avoid estimate-induced drift.
/** Bound tolerated duration-times-fps overshoot; indices within this tail window resolve against the real end. */
const TAIL_INDEX_SLOP = 3;

const toTailAwareIndex = (frame: number, estimatedNumFrames: number): number => {
  const tailOffset = estimatedNumFrames - 1 - frame;

  return tailOffset <= TAIL_INDEX_SLOP ? -(tailOffset + 1) : frame;
};

/** Extract source trim and crossfade source/new clips; video_concat reconstructs audio from both inputs. */
const addSourceJoin = (
  graph: BackendGraphContract,
  sourceVideo: NonNullable<VideoSettings['sourceVideo']>,
  newClip: BackendInvocationContract,
  options: { extractFps?: number } = {}
) => {
  const extract = addNode(graph, {
    end_frame: toTailAwareIndex(sourceVideo.endFrame, sourceVideo.numFrames),
    id: 'source_video',
    is_intermediate: true,
    start_frame: toTailAwareIndex(sourceVideo.startFrame, sourceVideo.numFrames),
    type: 'extract_video_range',
    use_cache: false,
    video: { video_name: sourceVideo.video_name },
    ...(options.extractFps === undefined ? {} : { fps: options.extractFps }),
  });
  const sourceCollect = addNode(graph, { id: 'source_clip_collect', type: 'collect' });
  const clipsCollect = addNode(graph, { id: 'clips_to_join', type: 'collect' });
  const concat = addNode(graph, {
    id: 'video_output',
    is_intermediate: false,
    size_mismatch: 'match_first',
    transition: 'crossfade',
    transition_frames: 2,
    type: 'video_concat',
    use_cache: false,
  });

  // Chained collectors keep the join order deterministic: [trimmed source, new clip].
  addEdge(graph, extract, 'video', sourceCollect, 'item');
  addEdge(graph, sourceCollect, 'collection', clipsCollect, 'collection');
  addEdge(graph, newClip, 'video', clipsCollect, 'item');
  addEdge(graph, clipsCollect, 'collection', concat, 'videos');

  return { concat, extract };
};

const addExtendScaffolding = (
  graph: BackendGraphContract,
  sourceVideo: NonNullable<VideoSettings['sourceVideo']>,
  newClip: BackendInvocationContract,
  options: { extractFps?: number } = {}
) => {
  const { concat, extract } = addSourceJoin(graph, sourceVideo, newClip, options);
  const lastFrame = addNode(graph, {
    frame_index: -1,
    id: 'source_last_frame',
    is_intermediate: true,
    type: 'video_frame_extract',
    use_cache: false,
  });

  addEdge(graph, extract, 'video', lastFrame, 'video');

  return { concat, extract, lastFrame };
};

interface VideoMetadataInput {
  graph: BackendGraphContract;
  /** Every video-emitting node that should carry the metadata (in extend mode: the concat AND the intermediate clip). */
  outputs: BackendInvocationContract[];
  settings: VideoSettings;
  model: MainModelConfig;
  generationMode: string;
  width: number;
  height: number;
  /** Whether the negative prompt participates in this family's graphs at all. */
  negativeWired: boolean;
  extras?: Record<string, unknown>;
}

const addVideoMetadata = ({
  graph,
  outputs,
  settings,
  model,
  generationMode,
  width,
  height,
  negativeWired,
  extras = {},
}: VideoMetadataInput) => {
  const activeLoras = getActiveCompatibleLoras(settings, model);
  const metadata = addNode(graph, {
    generation_mode: generationMode,
    height,
    id: 'core_metadata',
    model,
    num_frames: settings.numFrames,
    steps: settings.steps,
    type: 'core_metadata',
    width,
    ...(settings.firstFrameImage ? { first_frame_image: toImageField(settings.firstFrameImage) } : {}),
    ...(settings.lastFrameImage ? { last_frame_image: toImageField(settings.lastFrameImage) } : {}),
    // Persist trim bounds as metadata extras so recall restores the actual extension cutpoint.
    ...(settings.sourceVideo
      ? {
          source_video: { video_name: settings.sourceVideo.video_name },
          source_video_end_frame: settings.sourceVideo.endFrame,
          source_video_start_frame: settings.sourceVideo.startFrame,
        }
      : {}),
    ...(activeLoras.length
      ? { loras: activeLoras.map((lora) => ({ model: toModelIdentifier(lora.model), weight: lora.weight })) }
      : {}),
    ...extras,
  });

  addEdge(graph, graph.nodes.seed, 'value', metadata, 'seed');
  addEdge(graph, graph.nodes.positive_prompt, 'value', metadata, 'positive_prompt');
  if (negativeWired) {
    addEdge(graph, graph.nodes.negative_prompt, 'value', metadata, 'negative_prompt');
  }
  for (const output of outputs) {
    addEdge(graph, metadata, 'metadata', output, 'metadata');
  }

  return metadata;
};

const buildWanVideoGraph = (settings: VideoSettings, model: MainModelConfig): BackendGraphContract => {
  const mode = resolveVideoMode(settings);
  const policy = getVideoModelPolicy(model, settings);
  const dimensions = getVideoDimensions(model, settings);

  if (!dimensions) {
    throw new Error('Video dimensions could not be derived from the current settings.');
  }

  // Standalone Wan checkpoints need external VAE/UMT5 components; Diffusers mains bundle them and the second
  // expert.
  const isSingleFileMain = model.format !== 'diffusers';
  const sourceModel = isSingleFileMain
    ? getCompatibleDiffusersComponentSource(model, settings.componentSourceModel)
    : undefined;

  const graph: BackendGraphContract = { edges: [], id: createId('wan_video_graph'), nodes: {} };
  const { negativePrompt, positivePrompt, seed } = addPromptAndSeedNodes(graph);
  const modelLoader = addNode(graph, {
    component_source: sourceModel,
    id: 'model_loader',
    model,
    transformer_low_noise_model: (isSingleFileMain ? settings.wanLowNoiseModel : null) ?? undefined,
    type: 'wan_model_loader',
    vae_model: settings.vae ?? undefined,
    wan_t5_encoder_model: settings.wanT5EncoderModel ?? undefined,
  });
  // Wan LoRAs patch transformers; auto routing uses probed high/low tags to place accelerator pairs correctly.
  const activeLoras = getActiveCompatibleLoras(settings, model);
  const loraSource = activeLoras.length
    ? addTransformerLoraCollectionLoader(graph, activeLoras, 'wan_lora_collection_loader', modelLoader, ['transformer'])
    : modelLoader;
  const posCond = addNode(graph, { id: 'pos_cond', type: 'wan_text_encoder' });
  const negCond = addNode(graph, { id: 'neg_cond', type: 'wan_text_encoder' });
  const denoise = addNode(graph, {
    guidance_scale: settings.cfgScale,
    // Only the A14B expert pairs run a low-noise phase; null falls back to the
    // primary guidance rather than the node's own 4.0 default.
    ...(policy.ui.cfgLowNoiseVisible
      ? { guidance_scale_low_noise: settings.cfgScaleLowNoise ?? settings.cfgScale }
      : {}),
    height: dimensions.height,
    id: 'denoise_latents',
    num_frames: settings.numFrames,
    steps: settings.steps,
    type: 'wan_video_denoise',
    width: dimensions.width,
  });

  addEdge(graph, loraSource, 'transformer', denoise, 'transformer');
  addEdge(graph, modelLoader, 'wan_t5_encoder', posCond, 'wan_t5_encoder');
  addEdge(graph, modelLoader, 'wan_t5_encoder', negCond, 'wan_t5_encoder');
  addEdge(graph, positivePrompt, 'value', posCond, 'prompt');
  addEdge(graph, negativePrompt, 'value', negCond, 'prompt');
  addEdge(graph, posCond, 'conditioning', denoise, 'positive_conditioning');
  addEdge(graph, negCond, 'conditioning', denoise, 'negative_conditioning');
  addEdge(graph, seed, 'value', denoise, 'seed');

  // Share canvas/frame literals between reference conditioning and denoise to keep their shapes identical.
  const addRefEncoder = (inputs: Record<string, unknown>) => {
    const refEncoder = addNode(graph, {
      height: dimensions.height,
      id: 'ref_image_encoder',
      num_frames: settings.numFrames,
      type: 'wan_ref_image_encoder',
      width: dimensions.width,
      ...inputs,
    });

    addEdge(graph, modelLoader, 'vae', refEncoder, 'vae');
    addEdge(graph, refEncoder, 'ref_image', denoise, 'ref_image');

    return refEncoder;
  };

  let output: BackendInvocationContract;
  let extendParts: { lastFrame: BackendInvocationContract; newClip: BackendInvocationContract } | null = null;

  if (mode === 'extend' && settings.sourceVideo) {
    const refEncoder = addRefEncoder(
      settings.lastFrameImage ? { end_image: toImageField(settings.lastFrameImage) } : {}
    );
    const newClip = addNode(graph, {
      id: 'extension_clip',
      is_intermediate: true,
      type: 'wan_l2v',
      use_cache: false,
    });
    const { concat, extract, lastFrame } = addExtendScaffolding(graph, settings.sourceVideo, newClip);
    // Inherit source fps so the extension and original play at one speed.
    const fpsToInt = addNode(graph, { id: 'source_fps', method: 'Nearest', multiple: 1, type: 'float_to_int' });

    addEdge(graph, lastFrame, 'image', refEncoder, 'image');
    addEdge(graph, modelLoader, 'vae', newClip, 'vae');
    addEdge(graph, denoise, 'latents', newClip, 'latents');
    addEdge(graph, extract, 'fps', fpsToInt, 'value');
    addEdge(graph, fpsToInt, 'value', newClip, 'fps');
    addEdge(graph, fpsToInt, 'value', concat, 'fps');
    output = concat;
    extendParts = { lastFrame, newClip };
  } else {
    if (mode === 'first-frame' || mode === 'first-last') {
      if (!settings.firstFrameImage) {
        throw new Error('A first frame is required for image-to-video generation.');
      }

      addRefEncoder({
        image: toImageField(settings.firstFrameImage),
        ...(mode === 'first-last' && settings.lastFrameImage
          ? { end_image: toImageField(settings.lastFrameImage) }
          : {}),
      });
    }

    output = addNode(graph, {
      fps: settings.fps,
      id: 'video_output',
      is_intermediate: false,
      type: 'wan_l2v',
      use_cache: false,
    });
    addEdge(graph, modelLoader, 'vae', output, 'vae');
    addEdge(graph, denoise, 'latents', output, 'latents');
  }

  const metadata = addVideoMetadata({
    extras: {
      cfg_scale: settings.cfgScale,
      // Record delivered fps: rounded source rate for extension, panel fps otherwise.
      fps: extendParts && settings.sourceVideo ? Math.round(settings.sourceVideo.fps) : settings.fps,
      ...(policy.ui.cfgLowNoiseVisible && settings.cfgScaleLowNoise !== null
        ? { wan_guidance_scale_low_noise: settings.cfgScaleLowNoise }
        : {}),
      ...(settings.vae ? { vae: settings.vae } : {}),
      ...(settings.wanT5EncoderModel ? { wan_t5_encoder_model: settings.wanT5EncoderModel } : {}),
      ...(sourceModel ? { wan_component_source: sourceModel } : {}),
      ...(isSingleFileMain && settings.wanLowNoiseModel
        ? { wan_transformer_low_noise: settings.wanLowNoiseModel }
        : {}),
    },
    generationMode: WAN_GENERATION_MODES[mode] ?? 'wan_t2v',
    graph,
    height: dimensions.height,
    model,
    negativeWired: true,
    outputs: extendParts ? [output, extendParts.newClip] : [output],
    settings,
    width: dimensions.width,
  });

  if (extendParts) {
    // Record runtime-extracted conditioning frames through an edge, matching bundled templates.
    addEdge(graph, extendParts.lastFrame, 'image', metadata, 'first_frame_image');
  }

  return graph;
};

const buildMiniMaxH3VideoGraph = (settings: VideoSettings, model: MainModelConfig): BackendGraphContract => {
  const mode = resolveVideoMode(settings);
  const dimensions = getVideoDimensions(model, settings);

  if (!dimensions) {
    throw new Error('Video dimensions could not be derived from the current settings.');
  }

  // H3 checkpoints override the transformer of a required Diffusers component model; direct callers still need the
  // missing-slot guard.
  const isSingleFileMain = model.format !== 'diffusers';
  const componentSource = isSingleFileMain ? settings.componentSourceModel : null;

  if (isSingleFileMain && !componentSource) {
    throw new Error('A single-file MiniMax H3 transformer needs a Diffusers install selected under Model Components.');
  }

  // Hybrid loading overlays Ref2VA AdaLN blocks onto FL2VA; guard stale settings so unsupported mains cannot
  // silently load the wrong file.
  const hybridBase = isSingleFileMain && model.variant === 'ref2va' ? settings.h3HybridBaseModel : null;

  const graph: BackendGraphContract = { edges: [], id: createId('minimax_h3_video_graph'), nodes: {} };
  const { positivePrompt, seed } = addPromptAndSeedNodes(graph);
  const modelLoader = addNode(graph, {
    id: 'model_loader',
    model: componentSource ?? model,
    text_encoder_model: settings.h3TextEncoderModel ?? undefined,
    transformer_model: isSingleFileMain ? (hybridBase ?? model) : undefined,
    type: 'minimax_h3_model_loader',
  });
  let transformerSource: BackendInvocationContract = modelLoader;

  if (hybridBase) {
    const hybridOverlay = addNode(graph, {
      end_block: MINIMAX_H3_HYBRID_BLOCK_RANGE.max,
      id: 'hybrid_overlay',
      include_final_layer: false,
      overlay_model: model,
      start_block: settings.h3HybridStartBlock,
      type: 'minimax_h3_hybrid_overlay',
    });

    addEdge(graph, modelLoader, 'transformer', hybridOverlay, 'transformer');
    transformerSource = hybridOverlay;
  }

  const activeLoras = getActiveCompatibleLoras(settings, model);

  if (activeLoras.length) {
    transformerSource = addTransformerLoraCollectionLoader(
      graph,
      activeLoras,
      'minimax_h3_lora_collection_loader',
      transformerSource,
      ['transformer']
    );
  }

  // Share canvas/keyframe inputs across text, frame conditioning, and denoise.
  const keyframeLiterals = {
    ...(mode !== 'extend' && settings.firstFrameImage ? { first_image: toImageField(settings.firstFrameImage) } : {}),
    ...(settings.lastFrameImage ? { last_image: toImageField(settings.lastFrameImage) } : {}),
  };
  const posCond = addNode(graph, {
    height: dimensions.height,
    id: 'pos_cond',
    type: 'minimax_h3_text_encoder',
    width: dimensions.width,
    ...keyframeLiterals,
    ...(mode === 'reference' ? { num_frames: settings.numFrames } : {}),
  });
  const denoise = addNode(graph, {
    height: dimensions.height,
    id: 'denoise_latents',
    // The node's frame counts are a string Literal choice list.
    num_frames: String(settings.numFrames),
    // Add the terminal sigma point to panel model-evaluation steps; metadata retains the panel value.
    steps: settings.steps + 1,
    type: 'minimax_h3_denoise',
    width: dimensions.width,
  });

  addEdge(graph, modelLoader, 'text_encoder', posCond, 'text_encoder');
  addEdge(graph, positivePrompt, 'value', posCond, 'prompt');
  addEdge(graph, transformerSource, 'transformer', denoise, 'transformer');
  addEdge(graph, posCond, 'conditioning', denoise, 'positive_conditioning');
  addEdge(graph, seed, 'value', denoise, 'seed');

  if (mode === 'reference') {
    const referenceChain = addReferenceNodes(graph, settings.references);
    const referenceConditioning = addNode(graph, {
      height: dimensions.height,
      id: 'reference_conditioning',
      num_frames: settings.numFrames,
      type: 'minimax_h3_reference_conditioning',
      width: dimensions.width,
    });

    addEdge(graph, referenceChain, 'collection', referenceConditioning, 'references');
    addEdge(graph, referenceChain, 'collection', posCond, 'references');
    addEdge(graph, modelLoader, 'vae', referenceConditioning, 'vae');
    addEdge(graph, modelLoader, 'audio_vae', referenceConditioning, 'audio_vae');
    addEdge(graph, referenceConditioning, 'reference_conditioning', denoise, 'reference_conditioning');
  }

  const needsFrameConditioning = mode !== 'txt2vid' && mode !== 'reference';
  let frameConditioning: BackendInvocationContract | null = null;

  if (needsFrameConditioning) {
    frameConditioning = addNode(graph, {
      height: dimensions.height,
      id: 'frame_conditioning',
      type: 'minimax_h3_frame_conditioning',
      width: dimensions.width,
      ...keyframeLiterals,
    });
    addEdge(graph, modelLoader, 'vae', frameConditioning, 'vae');
    addEdge(graph, frameConditioning, 'frame_conditioning', denoise, 'frame_conditioning');
  }

  const addLatentsToVideo = (id: string, isIntermediate: boolean) => {
    const node = addNode(graph, {
      id,
      is_intermediate: isIntermediate,
      type: 'minimax_h3_latents_to_video',
      use_cache: false,
    });

    addEdge(graph, denoise, 'video_latents', node, 'video_latents');
    addEdge(graph, denoise, 'audio_latents', node, 'audio_latents');
    addEdge(graph, modelLoader, 'vae', node, 'vae');
    addEdge(graph, modelLoader, 'audio_vae', node, 'audio_vae');

    return node;
  };

  let output: BackendInvocationContract;
  let extendParts: { lastFrame: BackendInvocationContract; newClip: BackendInvocationContract } | null = null;
  let referenceExtendClip: BackendInvocationContract | null = null;

  if (mode === 'extend' && settings.sourceVideo && frameConditioning) {
    const newClip = addLatentsToVideo('extension_clip', true);
    // Resample source to H3's fixed 24 fps before concat inherits its rate.
    const { concat, lastFrame } = addExtendScaffolding(graph, settings.sourceVideo, newClip, { extractFps: 24 });

    addEdge(graph, lastFrame, 'image', posCond, 'first_image');
    addEdge(graph, lastFrame, 'image', frameConditioning, 'first_image');
    output = concat;
    extendParts = { lastFrame, newClip };
  } else if (mode === 'reference' && settings.sourceVideo) {
    // Reference extension derives continuity from references, not extracted frame conditioning.
    const newClip = addLatentsToVideo('extension_clip', true);
    const { concat } = addSourceJoin(graph, settings.sourceVideo, newClip, { extractFps: 24 });

    output = concat;
    referenceExtendClip = newClip;
  } else {
    output = addLatentsToVideo('video_output', false);
  }

  const metadata = addVideoMetadata({
    extras: {
      // H3 always delivers its fixed rate; recording it keeps the record self-describing.
      fps: MINIMAX_H3_FPS,
      ...(componentSource ? { minimax_h3_component_source: componentSource } : {}),
      ...(settings.h3TextEncoderModel ? { minimax_h3_text_encoder_model: settings.h3TextEncoderModel } : {}),
      ...(hybridBase
        ? { minimax_h3_hybrid_base_model: hybridBase, minimax_h3_hybrid_start_block: settings.h3HybridStartBlock }
        : {}),
      ...(mode === 'reference'
        ? {
            minimax_h3_references: settings.references.map((reference) =>
              reference.kind === 'image'
                ? { detail: reference.detail, image_name: reference.image.image_name, kind: 'image' }
                : {
                    conditioning: reference.conditioning,
                    end_frame: reference.clip.endFrame,
                    kind: 'video',
                    start_frame: reference.clip.startFrame,
                    video_name: reference.clip.video_name,
                  }
            ),
          }
        : {}),
    },
    generationMode: MINIMAX_H3_GENERATION_MODES[mode],
    graph,
    height: dimensions.height,
    model,
    negativeWired: false,
    outputs: extendParts
      ? [output, extendParts.newClip]
      : referenceExtendClip
        ? [output, referenceExtendClip]
        : [output],
    settings,
    width: dimensions.width,
  });

  if (extendParts) {
    // Record runtime-extracted conditioning frames through an edge, matching bundled templates.
    addEdge(graph, extendParts.lastFrame, 'image', metadata, 'first_frame_image');
  }

  return graph;
};

export const compileVideoGraph = (settings: VideoSettings, model: MainModelConfig): CompiledVideoGraph => {
  const validationReasons = getVideoValidationReasons(model, settings);

  if (validationReasons.length > 0) {
    throw new Error(validationReasons[0]);
  }

  const backendGraph =
    model.base === 'minimax-h3' ? buildMiniMaxH3VideoGraph(settings, model) : buildWanVideoGraph(settings, model);

  return {
    backendGraph,
    graph: toGraphContract(backendGraph, `${model.name} video`),
    negativePromptNodeId: 'negative_prompt',
    positivePromptNodeId: 'positive_prompt',
    seedNodeId: 'seed',
  };
};
