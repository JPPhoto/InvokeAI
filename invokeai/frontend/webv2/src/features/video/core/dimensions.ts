import type {
  Ltx2TargetResolution,
  MiniMaxH3TargetResolution,
  VideoAspectRatioId,
  VideoReferenceImageDetail,
  WanTargetResolution,
} from './types';

/**
 * Client-side ports of the backend's video canvas math, so the panel can show
 * and validate the exact dimensions a graph will run at without extra nodes:
 *
 * - Wan: `_scale_and_snap` in `invokeai/app/invocations/wan/wan_ideal_dimensions.py`
 *   ("nearest" rounding — the node default; the other modes are workflow-only).
 * - MiniMax H3: `resolve_canvas_size` in `invokeai/backend/minimax_h3/packing.py`
 *   and `resolve_lowres_canvas_size` in `invokeai/backend/minimax_h3/presets.py`.
 * - LTX-2: `resolve_canvas` in `invokeai/backend/ltx2/packing.py`.
 * - Ref2VA image references: `resolve_reference_image_short_edge` and
 *   `normalize_reference_image` in `invokeai/backend/minimax_h3/reference_conditioning.py`.
 *
 * Where the backend raises, these return null: the panel falls back to defaults
 * and reports the problem through `getVideoValidationReasons` instead of throwing.
 */

export interface VideoDimensions {
  width: number;
  height: number;
}

// Python's round() (used by both backend implementations) is half-to-even;
// Math.round is half-up. The ports must agree with the backend on exact .5
// quotients (e.g. 720 / 32 = 22.5) or panel and workflow dims would differ.
const roundHalfToEven = (value: number): number => {
  const floor = Math.floor(value);
  const diff = value - floor;

  if (diff > 0.5) {
    return floor + 1;
  }

  if (diff < 0.5) {
    return floor;
  }

  return floor % 2 === 0 ? floor : floor + 1;
};

const snapToMultiple = (value: number, multiple: number): number =>
  Math.max(multiple, roundHalfToEven(value / multiple) * multiple);

/** Pixel-grid multiple = 2 (transformer patch) × VAE spatial scale. */
export const WAN_A14B_PIXEL_MULTIPLE = 16;
export const WAN_TI2V_PIXEL_MULTIPLE = 32;

/** Short-side pixel count for each Wan preset ("p" names the short dimension). */
export const WAN_TARGET_RESOLUTION_PX: Record<WanTargetResolution, number> = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
};

/**
 * Scale a source W×H so its shorter side equals the preset's pixel count, then
 * snap each dimension to the Wan pixel grid (nearest). Only the ratio of the
 * inputs matters, so aspect-ratio parts (16, 9) work as well as real pixels.
 * Null when the inputs are non-positive or non-finite.
 *
 * Deliberate divergence from the backend node: `_scale_and_snap` rejects
 * sources whose RAW long side is under one grid cell, which would also reject
 * pure ratio parts like (16, 9) on the ×32 grid. Since only the ratio matters
 * and scaling happens before snapping, tiny-but-well-formed inputs are
 * accepted here — the scaled long side is always ≥ the target short side.
 */
export const scaleAndSnapWanDimensions = (
  width: number,
  height: number,
  targetResolution: WanTargetResolution,
  multiple: number
): VideoDimensions | null => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const targetShortSide = WAN_TARGET_RESOLUTION_PX[targetResolution];
  const scale = targetShortSide / Math.min(width, height);

  return {
    height: snapToMultiple(height * scale, multiple),
    width: snapToMultiple(width * scale, multiple),
  };
};

export const MINIMAX_H3_SHORT_EDGE = 768;
export const MINIMAX_H3_MAX_PIXELS = 768 * 1344;
export const MINIMAX_H3_CANVAS_MULTIPLE = 32;
export const MINIMAX_H3_MIN_ASPECT_RATIO = 1 / 4;
export const MINIMAX_H3_MAX_ASPECT_RATIO = 4;

/**
 * The MiniMax H3 canvas for an aspect ratio. "768 highres" is the released
 * pipeline's policy: short edge 768, soft area cap of 768×1344, both axes then
 * rounded to the nearest multiple of 32 (so the final area may sit slightly
 * above the pre-rounding budget). "768 lowres" pins the LONG edge to 768
 * instead for cheaper preview renders. Only the ratio of the inputs matters.
 * Null when the inputs are degenerate or the ratio is outside H3's supported
 * 1:4 – 4:1 range.
 */
export const resolveMiniMaxH3Canvas = (
  width: number,
  height: number,
  targetResolution: MiniMaxH3TargetResolution
): VideoDimensions | null => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const ratio = width / height;

  if (ratio < MINIMAX_H3_MIN_ASPECT_RATIO || ratio > MINIMAX_H3_MAX_ASPECT_RATIO) {
    return null;
  }

  let rawWidth: number;
  let rawHeight: number;

  if (targetResolution === '768 lowres') {
    // Long edge pinned to 768; area always sits far below the cap.
    if (ratio >= 1) {
      rawWidth = MINIMAX_H3_SHORT_EDGE;
      rawHeight = MINIMAX_H3_SHORT_EDGE / ratio;
    } else {
      rawWidth = MINIMAX_H3_SHORT_EDGE * ratio;
      rawHeight = MINIMAX_H3_SHORT_EDGE;
    }
  } else {
    if (ratio >= 1) {
      rawWidth = MINIMAX_H3_SHORT_EDGE * ratio;
      rawHeight = MINIMAX_H3_SHORT_EDGE;
    } else {
      rawWidth = MINIMAX_H3_SHORT_EDGE;
      rawHeight = MINIMAX_H3_SHORT_EDGE / ratio;
    }

    const area = rawWidth * rawHeight;

    if (area > MINIMAX_H3_MAX_PIXELS) {
      const scale = Math.sqrt(MINIMAX_H3_MAX_PIXELS / area);
      rawWidth *= scale;
      rawHeight *= scale;
    }
  }

  return {
    height: snapToMultiple(rawHeight, MINIMAX_H3_CANVAS_MULTIPLE),
    width: snapToMultiple(rawWidth, MINIMAX_H3_CANVAS_MULTIPLE),
  };
};

/** Upstream's reference-image rule: a constant short edge, whatever the generation size is. */
export const MINIMAX_H3_REFERENCE_IMAGE_SHORT_EDGE = 2048;

/**
 * Pixels per packed row: H3 encodes at a 16x spatial compression and the transformer packs
 * 2x2 latent patches, so a 32x32 pixel block is one row.
 */
export const MINIMAX_H3_ROW_PIXELS = 32 * 32;

/**
 * A reference image's normalized size and the rows it contributes.
 *
 * Those rows join the packed sequence and are re-attended at EVERY denoising step, with
 * attention quadratic in the sequence length — which is the whole difference between the
 * two detail settings. `'max'` pins the short edge to 2048 no matter how small the
 * generation is; `'match'` scales the reference to the generation's pixel area (never
 * above the 2048 rule), typically an order of magnitude fewer rows.
 *
 * Null when the inputs are degenerate, or when `'match'` has no target area to match —
 * the panel then shows nothing rather than a wrong number.
 */
export const resolveMiniMaxH3ReferenceImage = (
  width: number,
  height: number,
  detail: VideoReferenceImageDetail,
  targetArea: number | null
): { dimensions: VideoDimensions; rows: number } | null => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  let shortEdge = MINIMAX_H3_REFERENCE_IMAGE_SHORT_EDGE;

  if (detail === 'match') {
    if (targetArea === null || !Number.isFinite(targetArea) || targetArea <= 0) {
      return null;
    }
    // The backend rounds with Python's banker's rounding here, so `roundHalfToEven` is
    // what keeps this estimate equal to the size the graph actually encodes.
    const matched = Math.max(
      MINIMAX_H3_CANVAS_MULTIPLE,
      roundHalfToEven(Math.min(width, height) * Math.sqrt(targetArea / (width * height)))
    );

    shortEdge = Math.min(MINIMAX_H3_REFERENCE_IMAGE_SHORT_EDGE, matched);
  }

  const scale = shortEdge / Math.min(width, height);
  const dimensions = {
    height: snapToMultiple(height * scale, MINIMAX_H3_CANVAS_MULTIPLE),
    width: snapToMultiple(width * scale, MINIMAX_H3_CANVAS_MULTIPLE),
  };

  // Both axes are multiples of 32, so this is exact.
  return { dimensions, rows: (dimensions.width * dimensions.height) / MINIMAX_H3_ROW_PIXELS };
};

export const LTX2_CANVAS_MULTIPLE = 32;

/** Short-side pixel count for each LTX-2 preset ("p" names the short dimension). */
export const LTX2_TARGET_RESOLUTION_PX: Record<Ltx2TargetResolution, number> = {
  '512p': 512,
  '704p': 704,
  '768p': 768,
};

/**
 * The LTX-2 canvas for an aspect ratio: the preset pins the SHORT edge, the long
 * edge follows the source's ratio, and both axes snap to the VAE's 32-pixel grid.
 * LTX-2 declares no aspect-ratio limit and no area cap, so only degenerate inputs
 * return null. Only the ratio of the inputs matters.
 */
export const resolveLtx2Canvas = (
  width: number,
  height: number,
  targetResolution: Ltx2TargetResolution
): VideoDimensions | null => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const shortEdge = LTX2_TARGET_RESOLUTION_PX[targetResolution];
  const ratio = width / height;
  const raw =
    ratio >= 1 ? { height: shortEdge, width: shortEdge * ratio } : { height: shortEdge / ratio, width: shortEdge };

  return {
    height: snapToMultiple(raw.height, LTX2_CANVAS_MULTIPLE),
    width: snapToMultiple(raw.width, LTX2_CANVAS_MULTIPLE),
  };
};

// LTX-2's causal VAE encodes the first frame alone and then groups of 8, so
// (n - 1) % 8 == 0. 121 frames is 5 s at the model's 24 fps default, the length
// the released pipeline generates; the slider stops at 241 (10 s) because the
// sequence length — and with it both time and VRAM — grows linearly past it,
// while the field still accepts up to 481 for a deliberate long render.
export const LTX2_NUM_FRAMES_MIN = 9;
export const LTX2_NUM_FRAMES_MAX = 481;
export const LTX2_NUM_FRAMES_SLIDER_MAX = 241;
export const LTX2_NUM_FRAMES_STEP = 8;
export const LTX2_NUM_FRAMES_DEFAULT = 121;

export const LTX2_FPS_MIN = 1;
export const LTX2_FPS_MAX = 60;
export const LTX2_FPS_DEFAULT = 24;

/** The width/height parts of a preset ratio, for feeding the canvas resolvers. */
export const getVideoAspectRatioParts = (id: VideoAspectRatioId): VideoDimensions => {
  const [width = 1, height = 1] = id.split(':').map(Number);

  return { height, width };
};

/** The portrait/landscape mirror of a preset; every offered ratio has one. */
export const invertVideoAspectRatioId = (id: VideoAspectRatioId): VideoAspectRatioId => {
  const { width, height } = getVideoAspectRatioParts(id);

  return `${height}:${width}` as VideoAspectRatioId;
};

// Wan's VAE compresses 4 pixel frames into 1 latent frame, so (n - 1) % 4 == 0.
// 81 frames (5 s at 16 fps) is the training default; the slider allows up to
// twice that, but coherence degrades past 81 as temporal RoPE leaves its
// training distribution — the docs recommend chaining extends instead.
export const WAN_NUM_FRAMES_MIN = 5;
export const WAN_NUM_FRAMES_MAX = 161;
export const WAN_NUM_FRAMES_STEP = 4;
export const WAN_NUM_FRAMES_DEFAULT = 81;

export const WAN_FPS_MIN = 1;
export const WAN_FPS_MAX = 120;
export const WAN_FPS_DEFAULT = 16;

export const isValidWanNumFrames = (numFrames: number): boolean =>
  Number.isInteger(numFrames) && numFrames >= WAN_NUM_FRAMES_MIN && (numFrames - 1) % WAN_NUM_FRAMES_STEP === 0;

/** A frame count's grid, as the variant policies declare it. */
export interface VideoFramesGrid {
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}

/**
 * The nearest frame count on a family's grid, clamped to its range. Ties round
 * UP: a count halfway between two grid points is as close to either, and
 * rounding a short request down toward the floor is the worse answer (it can
 * collapse a clip to the minimum). Matches `snap_num_frames` in
 * `invokeai/backend/ltx2/packing.py`.
 */
export const snapNumFramesToGrid = (grid: VideoFramesGrid, numFrames: number): number => {
  if (!Number.isFinite(numFrames)) {
    return grid.defaultValue;
  }

  const clamped = Math.min(grid.max, Math.max(grid.min, numFrames));

  return Math.floor((clamped - grid.min) / grid.step + 0.5) * grid.step + grid.min;
};

export const MINIMAX_H3_FPS = 24;

// The 17n + 5 grid points the H3 video VAE can encode, from the accepted
// 3.75 s floor to the 15 s ceiling. Mirrors MINIMAX_H3_VIDEO_FRAME_CHOICES in
// invokeai/backend/minimax_h3/presets.py; the 5-frame still-image block is
// deliberately absent — the panel generates video, not stills.
export const MINIMAX_H3_NUM_FRAMES_CHOICES: readonly number[] = Array.from({ length: 16 }, (_, i) => 90 + i * 17);
export const MINIMAX_H3_NUM_FRAMES_DEFAULT = 124;

export const isValidMiniMaxH3NumFrames = (numFrames: number): boolean =>
  MINIMAX_H3_NUM_FRAMES_CHOICES.includes(numFrames);

/** A frame count's choice list, as the variant policies declare it. */
export interface VideoFramesChoices {
  choices: readonly number[];
  defaultValue: number;
}

/** The nearest offered frame count; the first of two equally near ones wins. */
export const snapNumFramesToChoices = (policy: VideoFramesChoices, numFrames: number): number => {
  if (!Number.isFinite(numFrames)) {
    return policy.defaultValue;
  }

  let best = policy.defaultValue;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const choice of policy.choices) {
    const distance = Math.abs(choice - numFrames);

    if (distance < bestDistance) {
      best = choice;
      bestDistance = distance;
    }
  }

  return best;
};

/** Clip length in seconds; matches the backend's `n / fps` labeling. */
export const getVideoDurationSeconds = (numFrames: number, fps: number): number | null =>
  Number.isFinite(numFrames) && Number.isFinite(fps) && fps > 0 && numFrames >= 0 ? numFrames / fps : null;

/**
 * The negative prompt LTX-2 was released with: a list of artifact and audio-defect tags its dev
 * checkpoint guides against at CFG 3. Mirrors `LTX2_DEFAULT_NEGATIVE_PROMPT` in
 * `invokeai/backend/ltx2/constants.py`, which is the text-encoder node's own default — the panel
 * seeds it so a fresh LTX-2 panel runs the released recipe rather than steering against nothing.
 */
export const LTX2_DEFAULT_NEGATIVE_PROMPT =
  'has_subtitles, has_blurbox, transition from black, transition to black, speech_ending_short, ' +
  'blurry, out of focus, overexposed, underexposed, low contrast, washed out colors, excessive noise, ' +
  'grainy texture, poor lighting, flickering, motion blur, distorted proportions, unnatural skin tones, ' +
  'deformed facial features, asymmetrical face, missing facial features, extra limbs, disfigured hands, ' +
  'wrong hand count, artifacts around text, inconsistent perspective, camera shake, incorrect depth of ' +
  'field, background too sharp, background clutter, distracting reflections, harsh shadows, inconsistent ' +
  'lighting direction, color banding, cartoonish rendering, 3D CGI look, unrealistic materials, uncanny ' +
  'valley effect, incorrect ethnicity, wrong gender, exaggerated expressions, wrong gaze direction, ' +
  'mismatched lip sync, silent or muted audio, distorted voice, robotic voice, echo, background noise, ' +
  'off-sync audio, incorrect dialogue, added dialogue, repetitive speech, jittery movement, awkward ' +
  'pauses, incorrect timing, unnatural transitions, inconsistent framing, tilted camera, flat lighting, ' +
  'inconsistent tone, cinematic oversaturation, stylized filters, or AI artifacts.';
