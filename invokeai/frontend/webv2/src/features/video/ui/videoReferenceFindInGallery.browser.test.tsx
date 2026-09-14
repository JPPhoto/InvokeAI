import type { VideoReferenceItem } from '@features/video/core/types';

import { ChakraProvider } from '@chakra-ui/react';
import { DndContext } from '@dnd-kit/core';
import { system } from '@theme/system';
import i18next from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoReferenceListField } from './VideoReferenceListField';
import { VideoUiProvider, type VideoUiAdapter } from './VideoUiContext';

/**
 * A reference card carries ONE find badge — an image reference's poster, or the
 * START bound of a video reference, whose two trim thumbs are frames of a single
 * gallery record. It reveals the card's own media, so the kind has to travel
 * with the name: a video asked for as an image resolves against the wrong
 * endpoint and the gesture dies in a rejected promise, silently.
 */
const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  fallbackLng: 'en',
  lng: 'en',
  resources: {
    en: {
      translation: {
        widgets: {
          gallery: { findNamedInGallery: 'Find {{name}} in Gallery', picker: { dropHint: 'Drop', upload: 'Upload' } },
          video: {
            chooseReference: 'Choose from Gallery',
            moveReferenceDown: 'Move reference down',
            moveReferenceUp: 'Move reference up',
            playSelection: 'Play selection in Preview',
            referenceConditioningAudio: 'Audio only',
            referenceConditioningVideo: 'Video only',
            referenceConditioningVideoAudio: 'Video + audio',
            referenceDetailMatch: 'Match generation size',
            referenceDetailMax: 'Max detail',
            referencesHelp: 'help',
            removeReference: 'Remove reference',
            sampleLength: 'Sample Length',
            sampleLengthWithSeconds: 'Sample Length ({{seconds}}s)',
            trimEndShort: 'End',
            trimStart: 'Start Frame',
            trimStartShort: 'Start',
            uploadImageReference: 'Upload image',
            uploadVideoReference: 'Upload video',
          },
        },
      },
    },
  },
});

let host: HTMLDivElement;
let root: Root;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const findInGallery = vi.fn();
const adapter = {
  findInGallery,
  getUploadBoardId: () => 'none',
  patchValues: vi.fn(),
  playVideoSpanInPreview: vi.fn(),
  reportError: vi.fn(),
  touchGalleryImages: vi.fn(),
  videoSpanPlayback: { getState: () => null, subscribe: () => () => undefined },
} as unknown as VideoUiAdapter;

const REFERENCES: VideoReferenceItem[] = [
  { detail: 'match', image: { height: 512, image_name: 'still.png', width: 512 }, kind: 'image' },
  {
    clip: { endFrame: 47, fps: 24, height: 480, numFrames: 48, startFrame: 0, video_name: 'clip.mp4', width: 832 },
    conditioning: 'video_audio',
    kind: 'video',
  },
];

const noop = () => REFERENCES;

const render = async (): Promise<void> => {
  await act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <DndContext>
            <VideoUiProvider adapter={adapter}>
              <VideoReferenceListField
                maxImages={9}
                maxVideos={3}
                references={REFERENCES}
                targetArea={null}
                onChange={noop}
              />
            </VideoUiProvider>
          </DndContext>
        </ChakraProvider>
      </I18nextProvider>
    )
  );
};

const findButtons = (name: string): HTMLButtonElement[] => [
  ...host.querySelectorAll<HTMLButtonElement>(`button[aria-label="Find ${name} in Gallery"]`),
];

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  findInGallery.mockClear();
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

describe('video reference find-in-gallery badges', () => {
  it('reveals an image reference as an image', async () => {
    await render();

    expect(findButtons('still.png')).toHaveLength(1);

    await act(() => findButtons('still.png')[0]?.click());

    expect(findInGallery).toHaveBeenCalledWith({ kind: 'image', name: 'still.png' });
  });

  it('keeps the badge out of the way until its own thumbnail is hovered or focused', async () => {
    await render();

    // Each badge is scoped to its own thumbnail's `.group`, which is the whole
    // mechanism that makes it a hover overlay rather than permanent chrome. A
    // mouse hover cannot be synthesised, but focus-within comes from the same
    // ancestor, so it proves the scoping either way.
    const badges = [...findButtons('still.png'), ...findButtons('clip.mp4')];
    const opacities = () => badges.map((button) => getComputedStyle(button).opacity);

    expect(badges).toHaveLength(2);
    expect(opacities()).toEqual(['0', '0']);

    // Each in turn: the one holding focus lights and only it. A badge whose
    // thumbnail lost its `.group` would never light; a `.group` hoisted to the
    // card would light both at once.
    //
    // Polled rather than settled once: the reveal is a CSS transition, which
    // does not exist to be awaited until the style recalc that starts it has
    // run. Settling at the moment of the focus call can therefore return
    // before the transition is even scheduled, and reads its start value.
    for (const [index] of badges.entries()) {
      await act(() => {
        badges[index]!.focus();
      });

      await vi.waitFor(() =>
        expect(opacities()).toEqual(badges.map((_button, other) => (other === index ? '1' : '0')))
      );
    }
  });

  it('reveals a video reference as a video, once, from its start bound', async () => {
    await render();

    // The end bound shows the same clip, so a second badge there would be a
    // second control with one destination — and one name to tell them apart.
    const bounds = findButtons('clip.mp4');

    expect(bounds).toHaveLength(1);

    await act(() => bounds[0]?.click());

    expect(findInGallery).toHaveBeenCalledExactlyOnceWith({ kind: 'video', name: 'clip.mp4' });
  });
});
