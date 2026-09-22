import type {
  MiniMaxH3TargetResolution,
  VideoAspectRatioId,
  VideoReferenceImageDetail,
  WanTargetResolution,
} from './types';

/**
 * Mirror Wan _scale_and_snap, H3 canvas presets, and reference-image normalization. Return null where backend math
 * rejects input so panel validation can explain it.
 */

export interface VideoDimensions {
  width: number;
  height: number;
}

// Match Python half-to-even rounding; Math.round differs at exact .5 and would produce inconsistent canvas sizes.
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
 * Scale the ratio to the target short side and snap to Wan's grid. Unlike the backend raw-size guard, accept small
 * positive ratio parts; reject nonfinite/nonpositive inputs.
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
 * H3 highres uses a 768 short edge and soft 768x1344 area cap before 32-pixel rounding; lowres caps the long edge
 * at 768. Reject ratios outside 1:4–4:1.
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
 * Reference rows participate in every denoise step. max uses a 2048 short edge; match uses capped generation area.
 * Return null without valid geometry/target area.
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

// Wan requires 4n+1 frames. The 81-frame training default supports best coherence; longer clips extend beyond the
// trained temporal range.
export const WAN_NUM_FRAMES_MIN = 5;
export const WAN_NUM_FRAMES_MAX = 161;
export const WAN_NUM_FRAMES_STEP = 4;
export const WAN_NUM_FRAMES_DEFAULT = 81;

export const WAN_FPS_MIN = 1;
export const WAN_FPS_MAX = 120;
export const WAN_FPS_DEFAULT = 16;

export const isValidWanNumFrames = (numFrames: number): boolean =>
  Number.isInteger(numFrames) && numFrames >= WAN_NUM_FRAMES_MIN && (numFrames - 1) % WAN_NUM_FRAMES_STEP === 0;

export const snapWanNumFrames = (numFrames: number): number => {
  if (!Number.isFinite(numFrames)) {
    return WAN_NUM_FRAMES_DEFAULT;
  }

  const clamped = Math.min(WAN_NUM_FRAMES_MAX, Math.max(WAN_NUM_FRAMES_MIN, numFrames));

  return Math.round((clamped - 1) / WAN_NUM_FRAMES_STEP) * WAN_NUM_FRAMES_STEP + 1;
};

export const MINIMAX_H3_FPS = 24;

// Mirror H3's 17n+5 video frame choices from presets.py; exclude the five-frame still-image block.
export const MINIMAX_H3_NUM_FRAMES_CHOICES: readonly number[] = Array.from({ length: 16 }, (_, i) => 90 + i * 17);
export const MINIMAX_H3_NUM_FRAMES_DEFAULT = 124;

export const isValidMiniMaxH3NumFrames = (numFrames: number): boolean =>
  MINIMAX_H3_NUM_FRAMES_CHOICES.includes(numFrames);

export const snapMiniMaxH3NumFrames = (numFrames: number): number => {
  if (!Number.isFinite(numFrames)) {
    return MINIMAX_H3_NUM_FRAMES_DEFAULT;
  }

  let best = MINIMAX_H3_NUM_FRAMES_DEFAULT;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const choice of MINIMAX_H3_NUM_FRAMES_CHOICES) {
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
