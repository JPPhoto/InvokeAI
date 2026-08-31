import { describe, expect, it } from 'vitest';

import type { VideoSettings } from './types';

import { MINIMAX_H3_NUM_FRAMES_CHOICES } from './dimensions';
import {
  applyReferenceExtendSourceVideo,
  applyReferenceExtendNumFrames,
  clearDeletedVideoMedia,
  cloneVideoWidgetValues,
  createVideoSourceClip,
  deriveReferenceExtendClip,
  isVideoSettings,
  isVideoSourceClip,
  normalizeVideoSettings,
  normalizeVideoWidgetValues,
  resolveVideoMode,
  VIDEO_SOURCE_FALLBACK_FPS,
} from './settings';
import { getDefaultVideoSettings } from './videoPolicies';

const FIRST_FRAME = { height: 1080, image_name: 'first.png', width: 1920 };
const LAST_FRAME = { height: 1080, image_name: 'last.png', width: 1920 };
const SOURCE_VIDEO = {
  endFrame: 79,
  fps: 16,
  height: 480,
  numFrames: 81,
  startFrame: 0,
  video_name: 'clip.mp4',
  width: 832,
};

const createSettings = (overrides: Partial<VideoSettings> = {}): VideoSettings => ({
  ...getDefaultVideoSettings(),
  ...overrides,
});

describe('resolveVideoMode', () => {
  it('infers the mode from which inputs are filled', () => {
    expect(resolveVideoMode(createSettings())).toBe('txt2vid');
    expect(resolveVideoMode(createSettings({ firstFrameImage: FIRST_FRAME }))).toBe('first-frame');
    expect(resolveVideoMode(createSettings({ firstFrameImage: FIRST_FRAME, lastFrameImage: LAST_FRAME }))).toBe(
      'first-last'
    );
    expect(resolveVideoMode(createSettings({ lastFrameImage: LAST_FRAME }))).toBe('last-frame');
    expect(resolveVideoMode(createSettings({ sourceVideo: SOURCE_VIDEO }))).toBe('extend');
    // A last frame with a source video is still extend — it is the destination anchor.
    expect(resolveVideoMode(createSettings({ lastFrameImage: LAST_FRAME, sourceVideo: SOURCE_VIDEO }))).toBe('extend');
  });
});

describe('normalizeVideoSettings', () => {
  it('round-trips canonical settings', () => {
    const settings = createSettings({ firstFrameImage: FIRST_FRAME, positivePrompt: 'a cat' });
    const normalized = normalizeVideoSettings(settings);

    expect(normalized).toEqual(settings);
    expect(isVideoSettings(settings)).toBe(true);
  });

  it('rejects non-records but heals partial records field-by-field, upscale-style', () => {
    expect(normalizeVideoSettings(null)).toBeNull();
    expect(normalizeVideoSettings(7)).toBeNull();
    // A seeded partial write ("Send to Video" on a never-opened widget) keeps
    // its payload instead of being nulled and wiped by the reconciler.
    const seeded = normalizeVideoSettings({ firstFrameImage: FIRST_FRAME, sourceVideo: null });

    expect(seeded).not.toBeNull();
    expect(seeded?.firstFrameImage).toEqual(FIRST_FRAME);
    expect(seeded).toMatchObject({ fps: 16, modelKey: '', numFrames: 81, steps: 40, targetResolution: '720p' });
    // Invalid field types heal to defaults rather than failing wholesale.
    expect(normalizeVideoSettings({ ...createSettings(), numFrames: 'many' })?.numFrames).toBe(81);
    expect(normalizeVideoSettings({ ...createSettings(), positivePrompt: 7 })?.positivePrompt).toBe('');
  });

  it('fills fields older persisted projects predate with defaults', () => {
    const legacy: Record<string, unknown> = {
      cfgScale: 5,
      fps: 16,
      modelKey: 'wan-key',
      negativePrompt: '',
      numFrames: 81,
      positivePrompt: 'a dog',
      seed: 123,
      shouldRandomizeSeed: false,
      steps: 40,
    };
    const normalized = normalizeVideoSettings(legacy);

    expect(normalized).not.toBeNull();
    expect(normalized?.aspectRatioId).toBe('16:9');
    expect(normalized?.targetResolution).toBe('720p');
    expect(normalized?.firstFrameImage).toBeNull();
    expect(normalized?.sourceVideo).toBeNull();
    expect(normalized?.loras).toEqual([]);
    expect(normalized?.acceleratorEnabled).toBe(false);
    expect(normalized?.positivePrompt).toBe('a dog');
  });

  it('drops malformed media values instead of failing wholesale', () => {
    const normalized = normalizeVideoSettings({
      ...createSettings(),
      firstFrameImage: { image_name: 'x.png' },
      sourceVideo: { video_name: 'clip.mp4' },
    });

    expect(normalized?.firstFrameImage).toBeNull();
    expect(normalized?.sourceVideo).toBeNull();
  });

  it('clears an accelerator flag whose recorded LoRAs are gone — the flag means they are active', () => {
    const lightningLora = {
      isEnabled: true,
      model: { base: 'wan', key: 'lit', name: 'Wan Lightning High Noise', type: 'lora' as const },
      weight: 1,
    };

    // Flag without recorded keys, or with a recorded key missing from the list, clears.
    expect(
      normalizeVideoSettings({ ...createSettings(), acceleratorEnabled: true, loras: [lightningLora] })
        ?.acceleratorEnabled
    ).toBe(false);
    expect(
      normalizeVideoSettings({
        ...createSettings(),
        acceleratorEnabled: true,
        acceleratorLoraKeys: ['lit', 'gone'],
        loras: [lightningLora],
      })
    ).toMatchObject({ acceleratorEnabled: false, acceleratorLoraKeys: [] });
    // Flag with all recorded keys present survives.
    expect(
      normalizeVideoSettings({
        ...createSettings(),
        acceleratorEnabled: true,
        acceleratorLoraKeys: ['lit'],
        loras: [lightningLora],
      })
    ).toMatchObject({ acceleratorEnabled: true, acceleratorLoraKeys: ['lit'] });
    expect(isVideoSettings({ ...createSettings(), acceleratorEnabled: true, acceleratorLoraKeys: [], loras: [] })).toBe(
      false
    );
    expect(
      isVideoSettings({
        ...createSettings(),
        acceleratorEnabled: true,
        acceleratorLoraKeys: ['lit'],
        loras: [lightningLora],
      })
    ).toBe(true);
    // A recorded LoRA that is merely DISABLED also clears the flag: the graph
    // skips disabled LoRAs, so the fast path would silently run without it.
    const disabledLightning = { ...lightningLora, isEnabled: false };

    expect(
      normalizeVideoSettings({
        ...createSettings(),
        acceleratorEnabled: true,
        acceleratorLoraKeys: ['lit'],
        loras: [disabledLightning],
      })
    ).toMatchObject({ acceleratorEnabled: false, acceleratorLoraKeys: [] });

    // A disabled flag must not carry stale keys.
    expect(isVideoSettings({ ...createSettings(), acceleratorEnabled: false, acceleratorLoraKeys: ['lit'] })).toBe(
      false
    );
  });

  it('resolves an illegal first-frame + source-video combination in favor of the first frame', () => {
    const normalized = normalizeVideoSettings({
      ...createSettings(),
      firstFrameImage: FIRST_FRAME,
      sourceVideo: SOURCE_VIDEO,
    });

    expect(normalized?.firstFrameImage).toEqual(FIRST_FRAME);
    expect(normalized?.sourceVideo).toBeNull();
  });
});

describe('isVideoSettings', () => {
  it('is strict over the keys normalize would invent', () => {
    expect(isVideoSettings({ ...createSettings(), aspectRatioId: 'Free' })).toBe(false);
    expect(isVideoSettings({ ...createSettings(), targetResolution: '4k' })).toBe(false);
    expect(isVideoSettings({ ...createSettings(), acceleratorEnabled: 'yes' })).toBe(false);
    expect(isVideoSettings({ ...createSettings(), firstFrameImage: FIRST_FRAME, sourceVideo: SOURCE_VIDEO })).toBe(
      false
    );
  });
});

describe('isVideoSourceClip', () => {
  it('requires the trim and probe fields', () => {
    expect(isVideoSourceClip(SOURCE_VIDEO)).toBe(true);
    expect(isVideoSourceClip({ ...SOURCE_VIDEO, fps: undefined })).toBe(false);
    expect(isVideoSourceClip({ ...SOURCE_VIDEO, video_name: 7 })).toBe(false);
  });
});

describe('normalizeVideoWidgetValues / cloneVideoWidgetValues', () => {
  const model = { base: 'wan', key: 'wan-key', name: 'Wan', type: 'main' as const, variant: 't2v_a14b' };

  it('carries a valid main model and nulls an invalid one', () => {
    expect(normalizeVideoWidgetValues({ ...createSettings(), model })?.model).toEqual(model);
    expect(normalizeVideoWidgetValues({ ...createSettings(), model: { key: 'x' } })?.model).toBeNull();
  });

  it('clones deeply enough that mutating the clone leaves the original untouched', () => {
    const values = { ...createSettings({ firstFrameImage: FIRST_FRAME, sourceVideo: null }), model };
    const clone = cloneVideoWidgetValues(values);

    expect(clone).toEqual(values);
    (clone.firstFrameImage as { image_name: string }).image_name = 'mutated.png';
    if (clone.model) {
      clone.model.key = 'mutated';
    }
    expect(values.firstFrameImage?.image_name).toBe('first.png');
    expect(values.model?.key).toBe('wan-key');
  });
});

describe('createVideoSourceClip', () => {
  it('estimates frames from duration and defaults the trim to drop the final frame', () => {
    const clip = createVideoSourceClip({ durationSeconds: 5, fps: 16, height: 480, name: 'clip.mp4', width: 832 });

    expect(clip).toEqual({
      endFrame: 78,
      fps: 16,
      height: 480,
      numFrames: 80,
      startFrame: 0,
      video_name: 'clip.mp4',
      width: 832,
    });
  });

  it('falls back to 16 fps when the probe recorded none, mirroring extract_video_range', () => {
    const clip = createVideoSourceClip({ durationSeconds: 2, height: 480, name: 'clip.mp4', width: 832 });

    expect(clip.fps).toBe(VIDEO_SOURCE_FALLBACK_FPS);
    expect(clip.numFrames).toBe(32);
  });

  it('keeps the default end frame at 1 or above so the crossfade tail survives', () => {
    const clip = createVideoSourceClip({ durationSeconds: 0.1, fps: 16, height: 480, name: 'c.mp4', width: 832 });

    expect(clip.endFrame).toBeGreaterThanOrEqual(1);
  });

  it('never produces negative trim bounds for very short clips', () => {
    const clip = createVideoSourceClip({ durationSeconds: 0.05, fps: 16, height: 480, name: 'c.mp4', width: 832 });

    expect(clip.numFrames).toBeGreaterThanOrEqual(1);
    expect(clip.endFrame).toBeGreaterThanOrEqual(0);
    expect(clip.startFrame).toBe(0);
  });
});

describe('clearDeletedVideoMedia', () => {
  const withMedia = createSettings({
    firstFrameImage: FIRST_FRAME,
    lastFrameImage: LAST_FRAME,
    sourceVideo: null,
  });

  it('returns the same object when nothing referenced was deleted', () => {
    expect(clearDeletedVideoMedia(withMedia, new Set(['other.png']), new Set())).toBe(withMedia);
  });

  it('clears exactly the deleted references', () => {
    const cleared = clearDeletedVideoMedia(withMedia, new Set(['first.png']), new Set());

    expect(cleared.firstFrameImage).toBeNull();
    expect(cleared.lastFrameImage).toEqual(LAST_FRAME);

    const withClip = createSettings({ sourceVideo: SOURCE_VIDEO });
    const clipCleared = clearDeletedVideoMedia(withClip, new Set(), new Set(['clip.mp4']));

    expect(clipCleared.sourceVideo).toBeNull();
  });

  it('clears a reference the exclusion masking would hide from a normalized snapshot', () => {
    // A raw store can hold BOTH slots (a rollback race); normalization would
    // mask the source video, so the sweep must run on the raw values or the
    // masked reference dangles past the delete.
    const rawBoth = { ...createSettings({ firstFrameImage: FIRST_FRAME }), sourceVideo: SOURCE_VIDEO } as Record<
      string,
      unknown
    >;
    const cleared = clearDeletedVideoMedia(rawBoth, new Set(), new Set(['clip.mp4']));

    expect(cleared.sourceVideo).toBeNull();
    expect(cleared.firstFrameImage).toEqual(FIRST_FRAME);

    // Junk in a slot never throws — the guards ignore non-media shapes.
    const junk = { firstFrameImage: 'nonsense', lastFrameImage: 7, sourceVideo: {} } as Record<string, unknown>;

    expect(clearDeletedVideoMedia(junk, new Set(['nonsense']), new Set())).toBe(junk);
  });
});

// ---------------------------------------------------------------------------
// Ref2VA references

const IMAGE_REFERENCE = {
  detail: 'max',
  image: { height: 512, image_name: 'ref.png', width: 512 },
  kind: 'image',
} as const;
const VIDEO_REFERENCE = {
  clip: { endFrame: 47, fps: 24, height: 480, numFrames: 48, startFrame: 0, video_name: 'ref.mp4', width: 832 },
  conditioning: 'video_audio',
  kind: 'video',
} as const;

describe('references', () => {
  it('reference mode wins the mode inference', () => {
    expect(resolveVideoMode(createSettings({ references: [IMAGE_REFERENCE] }))).toBe('reference');
    expect(resolveVideoMode(createSettings({ references: [VIDEO_REFERENCE], sourceVideo: SOURCE_VIDEO }))).toBe(
      'reference'
    );
  });

  it('normalization drops frame media when references are present, keeping the source video', () => {
    const normalized = normalizeVideoSettings(
      createSettings({ firstFrameImage: FIRST_FRAME, references: [IMAGE_REFERENCE], sourceVideo: SOURCE_VIDEO })
    );

    expect(normalized?.references).toEqual([IMAGE_REFERENCE]);
    expect(normalized?.firstFrameImage).toBeNull();
    // References + source video is the Ref2VA reference-extend shape;
    // validation rejects the pair on models that cannot consume it.
    expect(normalized?.sourceVideo).toEqual(SOURCE_VIDEO);
  });

  it('normalization drops malformed entries and enforces the caps, preserving order', () => {
    const tooMany = [
      ...Array.from({ length: 4 }, (_, index) => ({
        ...VIDEO_REFERENCE,
        clip: { ...VIDEO_REFERENCE.clip, video_name: `v${index}.mp4` },
      })),
      { kind: 'image' },
      IMAGE_REFERENCE,
    ];
    const normalized = normalizeVideoSettings(createSettings({ references: tooMany as never }));

    expect(normalized?.references.map((entry) => (entry.kind === 'video' ? entry.clip.video_name : 'img'))).toEqual([
      'v0.mp4',
      'v1.mp4',
      'v2.mp4',
      'img',
    ]);
  });

  it('isVideoSettings rejects references combined with frame media', () => {
    expect(isVideoSettings(createSettings({ firstFrameImage: FIRST_FRAME, references: [IMAGE_REFERENCE] }))).toBe(
      false
    );
    expect(isVideoSettings(createSettings({ references: [IMAGE_REFERENCE] }))).toBe(true);
  });

  it('clone deep-copies references', () => {
    const values = { ...createSettings({ references: [VIDEO_REFERENCE] }), model: null };
    const clone = cloneVideoWidgetValues(values);

    expect(clone.references).toEqual(values.references);
    expect(clone.references[0]).not.toBe(values.references[0]);
  });

  it('clearDeletedVideoMedia filters deleted reference media, preserving order and identity', () => {
    const values = createSettings({ references: [VIDEO_REFERENCE, IMAGE_REFERENCE] });
    const untouched = clearDeletedVideoMedia(values, new Set(), new Set());

    expect(untouched).toBe(values);

    const swept = clearDeletedVideoMedia(values, new Set(['ref.png']), new Set());

    expect(swept.references).toEqual([VIDEO_REFERENCE]);

    const sweptVideo = clearDeletedVideoMedia(values, new Set(), new Set(['ref.mp4']));

    expect(sweptVideo.references).toEqual([IMAGE_REFERENCE]);
  });
});

describe('reference-extend linkage', () => {
  // H3 generates at a fixed 24 fps; SOURCE_VIDEO runs at 16, so the two rates
  // are exercised separately.
  const longSource = { ...SOURCE_VIDEO, endFrame: 400, numFrames: 402, video_name: 'long.mp4' };
  const source24 = { ...longSource, fps: 24 };
  // The panel's default; every choice is on the 17n+5 grid.
  const FRAMES = 141;

  it('derives the tail trim: the window ending at the cutpoint, clamped at 0', () => {
    expect(deriveReferenceExtendClip(source24, FRAMES)).toMatchObject({ endFrame: 400, startFrame: 260 });
    // Shorter than the tail window: sample from the clip's own start.
    expect(deriveReferenceExtendClip({ ...SOURCE_VIDEO, fps: 24 }, FRAMES)).toMatchObject({
      endFrame: 79,
      startFrame: 0,
    });
  });

  it('budgets the window against the generated frame count', () => {
    // `normalize_reference_video_frames` truncates a reference to the generated
    // frame count keeping the FRONT, so a window longer than the generation
    // loses its tail — the frames at the seam. It must never outrun the count.
    expect(deriveReferenceExtendClip(source24, 124)).toMatchObject({ endFrame: 400, startFrame: 277 });
    expect(deriveReferenceExtendClip(source24, 90)).toMatchObject({ endFrame: 400, startFrame: 311 });
    // Above the tail window the budget stops binding: ~5s of lead-in is the cap.
    expect(deriveReferenceExtendClip(source24, 345)).toMatchObject({ endFrame: 400, startFrame: 260 });
  });

  it('lands the window ON the 17n+5 grid the backend keeps, at every source rate', () => {
    // The real test of the window: run it through ALL THREE backend rules.
    // `resample_video_frame_repeats` onto 24 fps, `frames[:num_frames]`, then
    // `snap_reference_num_frames` DOWN to 17n+5 — every one of which cuts the
    // seam end. Rounding the fps conversion DOWN satisfied the first two and
    // failed the third, losing 17 frames at 23.976 fps at every frame count.
    const resample = (n: number, fps: number) => Math.floor((n * 24) / fps + 0.5);
    const snapDown = (n: number) => Math.max(1, Math.floor((n - 5) / 17)) * 17 + 5;

    for (const fps of [10, 12, 15, 16, 18, 20, 23.976, 24, 25, 29.97, 30, 60]) {
      for (const numFrames of MINIMAX_H3_NUM_FRAMES_CHOICES) {
        const clip = deriveReferenceExtendClip({ ...longSource, fps }, numFrames);
        const budget = Math.min(141, numFrames);
        const kept = snapDown(Math.min(resample(clip.endFrame - clip.startFrame + 1, fps), numFrames));

        expect({ fps, kept, numFrames }).toEqual({ fps, kept: budget, numFrames });
      }
    }
  });

  it('converts the window into the source clip fps', () => {
    // 141 frames of 24 fps material is 94 frames of a 16 fps clip — the same
    // 5.875s of wall time, which is what the tail window actually means.
    expect(deriveReferenceExtendClip(longSource, FRAMES)).toMatchObject({ endFrame: 400, startFrame: 307 });
    // A clip whose probe recorded no usable rate falls back to a no-op
    // conversion rather than collapsing to the 2-frame floor.
    expect(deriveReferenceExtendClip({ ...longSource, fps: 0 }, FRAMES)).toMatchObject({ startFrame: 260 });
    expect(deriveReferenceExtendClip({ ...longSource, fps: -30 }, FRAMES)).toMatchObject({ startFrame: 260 });
  });

  it('appends a linked video+audio reference and re-derives it on cutpoint changes', () => {
    // Appended, not prepended: request order is rotary order and the generated
    // rows continue from the LAST reference block, so the continuity anchor
    // has to be the final entry.
    const added = applyReferenceExtendSourceVideo([IMAGE_REFERENCE], source24, 3, FRAMES);

    expect(added).toHaveLength(2);
    expect(added[0]).toBe(IMAGE_REFERENCE);
    expect(added[1]).toMatchObject({
      clip: { endFrame: 400, startFrame: 260, video_name: 'long.mp4' },
      conditioning: 'video_audio',
      fromSourceVideo: true,
      kind: 'video',
    });

    // The user tunes the conditioning, then moves the cutpoint: the trim
    // re-derives, the position and conditioning survive.
    const tuned = added.map((entry, index) =>
      index === 1 && entry.kind === 'video' ? { ...entry, conditioning: 'video' as const } : entry
    );
    const retrimmed = applyReferenceExtendSourceVideo(tuned, { ...source24, endFrame: 300 }, 3, FRAMES);

    expect(retrimmed[1]).toMatchObject({
      clip: { endFrame: 300, startFrame: 160 },
      conditioning: 'video',
      fromSourceVideo: true,
    });
    expect(retrimmed[0]).toBe(added[0]);
  });

  it('clearing the initial video removes only the linked reference (identity-preserving when none)', () => {
    const list = applyReferenceExtendSourceVideo([VIDEO_REFERENCE, IMAGE_REFERENCE], source24, 3, FRAMES);

    expect(applyReferenceExtendSourceVideo(list, null, 3, FRAMES)).toEqual([VIDEO_REFERENCE, IMAGE_REFERENCE]);

    const unlinked = [VIDEO_REFERENCE, IMAGE_REFERENCE];

    expect(applyReferenceExtendSourceVideo(unlinked, null, 3, FRAMES)).toBe(unlinked);
  });

  it('adopts an unflagged reference for the same clip instead of duplicating it (recall shape)', () => {
    const recalled = { ...VIDEO_REFERENCE, clip: { ...VIDEO_REFERENCE.clip, video_name: 'long.mp4' } };
    const result = applyReferenceExtendSourceVideo([IMAGE_REFERENCE, recalled], source24, 3, FRAMES);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      clip: { endFrame: 400, startFrame: 260, video_name: 'long.mp4' },
      fromSourceVideo: true,
    });
  });

  it('prefers the flagged entry over an earlier same-name reference on a source swap', () => {
    // User: linked ref for clip A, plus their OWN hand-trimmed reference for
    // clip B sitting above it. Swapping the Initial Video to clip B must
    // update the FLAGGED entry — not rewrite the user's B reference.
    const linkedA = applyReferenceExtendSourceVideo([], source24, 3, FRAMES)[0];
    const handTrimmedB = {
      ...VIDEO_REFERENCE,
      clip: { ...VIDEO_REFERENCE.clip, endFrame: 200, numFrames: 300, startFrame: 100, video_name: 'b.mp4' },
    };
    const sourceB = { ...source24, endFrame: 290, numFrames: 300, video_name: 'b.mp4' };
    const result = applyReferenceExtendSourceVideo([handTrimmedB, linkedA!], sourceB, 3, FRAMES);

    expect(result[0]).toBe(handTrimmedB);
    expect(result[1]).toMatchObject({
      clip: { endFrame: 290, startFrame: 150, video_name: 'b.mp4' },
      fromSourceVideo: true,
    });
    expect(result.filter((entry) => entry.kind === 'video' && entry.fromSourceVideo === true)).toHaveLength(1);
  });

  it('leaves a full video-reference list unchanged instead of overflowing the cap', () => {
    const full = [
      VIDEO_REFERENCE,
      { ...VIDEO_REFERENCE, clip: { ...VIDEO_REFERENCE.clip, video_name: 'b.mp4' } },
      { ...VIDEO_REFERENCE, clip: { ...VIDEO_REFERENCE.clip, video_name: 'c.mp4' } },
    ];

    expect(applyReferenceExtendSourceVideo(full, source24, 3, FRAMES)).toBe(full);
  });

  it('applyReferenceExtendNumFrames re-derives the window and is idempotent', () => {
    const linked = applyReferenceExtendSourceVideo([IMAGE_REFERENCE], source24, 3, FRAMES);

    expect(linked[1]).toMatchObject({ clip: { startFrame: 260 } });

    const at124 = applyReferenceExtendNumFrames(linked, 124);

    expect(at124[1]).toMatchObject({ clip: { endFrame: 400, startFrame: 277 }, fromSourceVideo: true });
    expect(at124[0]).toBe(linked[0]);
    // Idempotent, and identity-preserving when nothing moves.
    expect(applyReferenceExtendNumFrames(at124, 124)).toBe(at124);
    expect(applyReferenceExtendNumFrames(linked, FRAMES)).toBe(linked);
  });

  it('applyReferenceExtendNumFrames does not ratchet: the window re-widens', () => {
    // The Frames number input emits a value per keystroke, unclamped, so typing
    // "345" arrives as 3, then 34, then 345. A shrink-only rule would pin the
    // window at the 3-frame budget for the rest of the session.
    const linked = applyReferenceExtendSourceVideo([], source24, 3, 345);
    const typed = [3, 34, 345].reduce(applyReferenceExtendNumFrames, linked);

    expect(typed[0]).toMatchObject({ clip: { endFrame: 400, startFrame: 260 } });
    // And a slider dragged down and back up ends where it started.
    expect([90, 124, 345].reduce(applyReferenceExtendNumFrames, linked)[0]).toMatchObject({
      clip: { startFrame: 260 },
    });
  });

  it('applyReferenceExtendNumFrames leaves unlinked references alone', () => {
    const unlinked = [VIDEO_REFERENCE, IMAGE_REFERENCE];

    expect(applyReferenceExtendNumFrames(unlinked, 90)).toBe(unlinked);
  });
});
