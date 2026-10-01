import i18n from 'i18next';
import { describe, expect, it } from 'vitest';

import { shouldEnableGalleryStarredStrip, shouldPublishGalleryTotal } from './GalleryWidgetView';

const englishCatalogModules = import.meta.glob('../../../../public/locales/en.json', {
  eager: true,
  import: 'default',
});
const englishCatalog = Object.values(englishCatalogModules)[0] as Record<string, unknown>;

describe('shouldPublishGalleryTotal', () => {
  it('publishes finite totals that differ from known state and have not already been published', () => {
    expect(shouldPublishGalleryTotal({ knownTotalImages: null, lastPublishedTotal: null, total: 12 })).toBe(true);
    expect(shouldPublishGalleryTotal({ knownTotalImages: 8, lastPublishedTotal: null, total: 12 })).toBe(true);
  });

  it('does not republish the same in-flight total while known state catches up', () => {
    expect(shouldPublishGalleryTotal({ knownTotalImages: null, lastPublishedTotal: 12, total: 12 })).toBe(false);
  });

  it('does not publish non-finite or already-known totals', () => {
    expect(shouldPublishGalleryTotal({ knownTotalImages: 12, lastPublishedTotal: null, total: 12 })).toBe(false);
    expect(shouldPublishGalleryTotal({ knownTotalImages: null, lastPublishedTotal: null, total: null })).toBe(false);
    expect(shouldPublishGalleryTotal({ knownTotalImages: null, lastPublishedTotal: null, total: Number.NaN })).toBe(
      false
    );
  });
});

describe('shouldEnableGalleryStarredStrip', () => {
  const base = {
    anchoredWindowPage: 0,
    infiniteListingOffset: 0,
    isInfinite: true,
    semanticSearchActive: false,
    starredOnly: false,
  };

  it('hides the strip at a deep infinite anchor and restores it when backward traversal returns to zero', () => {
    expect(shouldEnableGalleryStarredStrip({ ...base, anchoredWindowPage: 15, infiniteListingOffset: 900 })).toBe(
      false
    );
    // The explicit reveal anchor can remain on page 15 after the window has slid back to the top.
    expect(shouldEnableGalleryStarredStrip({ ...base, anchoredWindowPage: 15, infiniteListingOffset: 0 })).toBe(true);
  });

  it('uses the persisted anchor in paginated mode and suppresses the strip for search or starred-only views', () => {
    expect(shouldEnableGalleryStarredStrip({ ...base, anchoredWindowPage: 2, isInfinite: false })).toBe(false);
    expect(shouldEnableGalleryStarredStrip({ ...base, semanticSearchActive: true })).toBe(false);
    expect(shouldEnableGalleryStarredStrip({ ...base, starredOnly: true })).toBe(false);
  });
});

describe('mixed-media gallery translations', () => {
  it('resolves the board, upload, status, and video labels with interpolation', async () => {
    const instance = i18n.createInstance();
    await instance.init({
      initAsync: false,
      lng: 'en',
      resources: { en: { translation: englishCatalog } },
    });

    expect(instance.t('widgets.gallery.statusChip', { count: 12 })).toBe('Gallery: 12 items');
    expect(
      instance.t('widgets.gallery.boardItemCounts', {
        assets: instance.t('widgets.gallery.assetCount', { count: 4 }),
        images: instance.t('widgets.gallery.imageCount', { count: 2 }),
        videos: instance.t('widgets.gallery.videoCount', { count: 3 }),
      })
    ).toBe('2 images · 3 videos · 4 uploads');
    expect(instance.t('widgets.gallery.downloadBoardWithOmission', { count: 2 })).toBe(
      'Download Board (2 videos omitted)'
    );
    expect(
      instance.t('widgets.gallery.uploadSummary', {
        board: 'Clips',
        failed: 1,
        images: instance.t('widgets.gallery.imageCount', { count: 2 }),
        videos: instance.t('widgets.gallery.videoCount', { count: 3 }),
      })
    ).toBe('2 images and 3 videos uploaded to Clips. 1 failed.');
    expect(instance.t('widgets.gallery.uploadSplit')).toBe('Images appear in Uploads; videos appear in Media.');
    expect(
      instance.t('widgets.gallery.deleteBoardMediaOutcome', {
        failedImages: instance.t('widgets.gallery.imageCount', { count: 1 }),
        failedVideos: instance.t('widgets.gallery.videoCount', { count: 2 }),
        images: instance.t('widgets.gallery.imageCount', { count: 3 }),
        videos: instance.t('widgets.gallery.videoCount', { count: 4 }),
      })
    ).toBe('Deleted 3 images and 4 videos; 1 image and 2 videos could not be deleted.');
    expect(instance.t('widgets.preview.videoLabel', { name: 'clip.mp4' })).toBe('Video clip.mp4');
    expect(instance.t('widgets.preview.videoFailed')).toBe('Video could not be loaded');
    expect(instance.t('widgets.preview.copyCurrentFrame')).toBe('Copy Current Frame');
    expect(instance.t('widgets.preview.videoDetails')).toBe('Video Details');
  });
});
