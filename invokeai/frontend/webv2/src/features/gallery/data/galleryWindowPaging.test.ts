import { describe, expect, it } from 'vitest';

import { getGalleryWindowLoadAction } from './queryCache';

describe('getGalleryWindowLoadAction', () => {
  it('requests one adjacent page toward a range before re-anchoring', () => {
    expect(getGalleryWindowLoadAction({ first: 600, last: 650, pageOffsets: [0, 60, 120, 180, 240, 300] })).toEqual({
      kind: 'reanchor',
      offset: 600,
    });
    expect(getGalleryWindowLoadAction({ first: 60, last: 120, pageOffsets: [120, 180, 240] })).toEqual({
      kind: 'previous',
    });
    expect(getGalleryWindowLoadAction({ first: 240, last: 300, pageOffsets: [120, 180, 240] })).toEqual({
      kind: 'next',
    });
  });

  it('does nothing when every requested page is already retained', () => {
    expect(getGalleryWindowLoadAction({ first: 61, last: 118, pageOffsets: [0, 60, 120] })).toEqual({ kind: 'none' });
  });

  it('re-anchors ranges that would exceed the retained page budget', () => {
    expect(getGalleryWindowLoadAction({ first: 60, last: 660, pageOffsets: [0, 60, 120] })).toEqual({
      kind: 'reanchor',
      offset: 60,
    });
  });

  it('continues an oversized visible range when its viewport-derived budget includes it', () => {
    expect(getGalleryWindowLoadAction({ first: 0, last: 720, maxPages: 15, pageOffsets: [0] })).toEqual({
      kind: 'next',
    });
  });

  it('re-anchors a distant range instead of requesting intervening pages', () => {
    expect(getGalleryWindowLoadAction({ first: 6_000, last: 6_010, pageOffsets: [0, 60, 120] })).toEqual({
      kind: 'reanchor',
      offset: 6_000,
    });
  });

  it('starts an empty window at the first requested page', () => {
    expect(getGalleryWindowLoadAction({ first: 121, last: 130, pageOffsets: [] })).toEqual({
      kind: 'reanchor',
      offset: 120,
    });
  });
});
