import { describe, expect, it } from 'vitest';

import type { IntermediatesRow } from './types';

import {
  EMPTY_SELECTION,
  getPageSelectionState,
  isRowSelected,
  resolveScope,
  selectAllMatching,
  summarizeSelection,
  toggleRowSelection,
  withRowSelected,
} from './selection';

const row = (projectId: string | null, overrides: Partial<IntermediatesRow> = {}): IntermediatesRow => ({
  coverImageName: null,
  images: { active: 0, recent: 0, referenced: 1, safe: 3 },
  projectId,
  projectName: projectId,
  reclaimableBytes: 100,
  referencedBytes: 10,
  unknownSizeCount: 0,
  userDisplayName: 'Alice',
  userEmail: 'alice@example.com',
  userId: 'alice',
  videos: { active: 0, recent: 0, referenced: 0, safe: 2 },
  ...overrides,
});

const page = [row('a'), row('b'), row(null)];
const totals = { reclaimableBytes: 5_000, rows: 12, safeImages: 40, safeVideos: 4, unknownSizeCount: 2 };

describe('row selection', () => {
  it('toggles rows and reports the page state', () => {
    let selection = toggleRowSelection(EMPTY_SELECTION, page[0]!, page);
    expect(isRowSelected(selection, page[0]!)).toBe(true);
    expect(getPageSelectionState(selection, page)).toBe('some');

    for (const candidate of page.slice(1)) {
      selection = toggleRowSelection(selection, candidate, page);
    }
    expect(page.every((candidate) => isRowSelected(selection, candidate))).toBe(true);
    expect(getPageSelectionState(selection, page)).toBe('all');
    expect(getPageSelectionState(selectAllMatching(), page)).toBe('all');
    expect(getPageSelectionState(EMPTY_SELECTION, page)).toBe('none');
  });

  it('keeps the unassigned row distinct from a project row of the same owner', () => {
    const selection = toggleRowSelection(EMPTY_SELECTION, page[2]!, page);

    expect(isRowSelected(selection, page[2]!)).toBe(true);
    expect(isRowSelected(selection, page[0]!)).toBe(false);
  });

  it('keeps picks from an earlier page when the page changes', () => {
    const firstPage = [row('a'), row('b')];
    const secondPage = [row('c'), row('d')];
    let selection = toggleRowSelection(EMPTY_SELECTION, firstPage[0]!, firstPage);
    selection = toggleRowSelection(selection, secondPage[1]!, secondPage);

    expect(summarizeSelection(selection, totals).rows).toBe(2);
    expect(resolveScope({ hasSearch: false, loadedRows: secondPage, ownerId: 'alice', selection })).toEqual({
      kind: 'selection',
      targets: [
        { projectId: 'a', userId: 'alice' },
        { projectId: 'd', userId: 'alice' },
      ],
    });
    expect(getPageSelectionState(selection, firstPage)).toBe('some');
  });

  it('adds a row without disturbing an existing pick or an all-matching selection', () => {
    const picked = withRowSelected(withRowSelected(EMPTY_SELECTION, page[0]!), page[0]!);
    expect(summarizeSelection(picked, totals).rows).toBe(1);
    expect(withRowSelected(selectAllMatching(), page[1]!)).toEqual(selectAllMatching());
  });

  it('leaving all-matching by toggling a row keeps the rest of the visible page', () => {
    const selection = toggleRowSelection(selectAllMatching(), page[1]!, page);

    expect(selection.mode).toBe('rows');
    expect(isRowSelected(selection, page[0]!)).toBe(true);
    expect(isRowSelected(selection, page[1]!)).toBe(false);
    expect(isRowSelected(selection, page[2]!)).toBe(true);
  });
});

describe('selection summary', () => {
  it('sums explicit picks from their snapshots', () => {
    const selection = toggleRowSelection(toggleRowSelection(EMPTY_SELECTION, page[0]!, page), page[2]!, page);

    expect(summarizeSelection(selection, totals)).toEqual({
      referencedBytes: 20,
      referencedImages: 2,
      referencedVideos: 0,
      reclaimableBytes: 200,
      rows: 2,
      safeImages: 6,
      safeVideos: 4,
      unknownSizeCount: 0,
    });
  });

  it('uses the server totals for all matching rows, which may exceed the loaded page', () => {
    expect(summarizeSelection(selectAllMatching(), totals)).toMatchObject({
      reclaimableBytes: 5_000,
      rows: 12,
      safeImages: 40,
      safeVideos: 4,
      unknownSizeCount: 2,
    });
  });
});

describe('scope resolution', () => {
  it('turns all-matching without a search into the owner or everyone scope', () => {
    expect(
      resolveScope({ hasSearch: false, loadedRows: page, ownerId: 'alice', selection: selectAllMatching() })
    ).toEqual({ kind: 'owner', userId: 'alice' });
    expect(resolveScope({ hasSearch: false, loadedRows: page, ownerId: null, selection: selectAllMatching() })).toEqual(
      {
        kind: 'everyone',
      }
    );
  });

  it('turns picks, and all-matching under a search, into explicit targets', () => {
    const picks = toggleRowSelection(EMPTY_SELECTION, page[2]!, page);

    expect(resolveScope({ hasSearch: false, loadedRows: page, ownerId: 'alice', selection: picks })).toEqual({
      kind: 'selection',
      targets: [{ projectId: null, userId: 'alice' }],
    });
    expect(
      resolveScope({ hasSearch: true, loadedRows: page, ownerId: 'alice', selection: selectAllMatching() })
    ).toEqual({
      kind: 'selection',
      targets: page.map(({ projectId, userId }) => ({ projectId, userId })),
    });
  });
});
