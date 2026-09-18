import type { GalleryBoard } from './types';

export type GalleryBoardTranslate = (key: string) => string;

/** Resolves the localized display label for synthesized and stored boards. */
export const getGalleryBoardLabel = (board: GalleryBoard, t: GalleryBoardTranslate): string =>
  board.kind === 'uncategorized' ? t('widgets.gallery.uncategorized') : board.name;

/** Virtual "by date" boards (`by_date:<YYYY-MM-DD>`) list items but can never receive them. */
export const DATE_BOARD_ID_PREFIX = 'by_date:';

export const isDateBoardId = (boardId: string): boolean => boardId.startsWith(DATE_BOARD_ID_PREFIX);
