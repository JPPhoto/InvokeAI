/**
 * Discover references by name key with separate image/video namespaces. Collection excludes history; remapping
 * includes it.
 */

/** Keys whose string values name an image; the server's `media_references` extractor uses the same set. */
const IMAGE_NAME_KEYS: ReadonlySet<string> = new Set(['imageName', 'image_name']);

/** Keys whose string values name a video; the server's `media_references` extractor uses the same set. */
const VIDEO_NAME_KEYS: ReadonlySet<string> = new Set(['videoName', 'video_name']);

/** Server-side names are generated filenames; the cleanup index ignores anything longer. */
const MAX_HELD_NAME_LENGTH = 255;

/** Top-level document keys that are history rather than live content. */
export const PROJECT_HISTORY_ROOT_KEYS: ReadonlySet<string> = new Set(['events', 'graphHistory', 'queue']);

/** Keys that introduce history at any depth (`canvas.snapshots`, the gallery's recents). */
export const PROJECT_HISTORY_KEYS: ReadonlySet<string> = new Set(['recentImages', 'snapshot', 'snapshots']);

/** Skip and strip installation-specific selection references so unbundled names cannot travel silently. */
export const GALLERY_SELECTION_KEYS: ReadonlySet<string> = new Set([
  'compareImage',
  'selectedImage',
  'selectedImageName',
  'selectedImageNames',
]);

/** Strip gallery board IDs while preserving authored workflow board inputs. */
export const GALLERY_INSTALLATION_KEYS: ReadonlySet<string> = new Set(['projectBoardId', 'selectedBoardId']);

/** Clear pagination/window anchors when transferred board IDs change. */
export const GALLERY_POSITION_KEYS: ReadonlySet<string> = new Set(['galleryPage']);

const INSTALLATION_STATE_KEYS: ReadonlySet<string> = new Set([
  ...GALLERY_SELECTION_KEYS,
  ...GALLERY_INSTALLATION_KEYS,
  ...GALLERY_POSITION_KEYS,
]);

/** Blank cached URLs instead of deleting keys, preserving entries while forcing URL derivation from remapped names. */
const DERIVED_URL_KEYS: ReadonlySet<string> = new Set(['imageUrl', 'thumbnailUrl', 'videoUrl']);

export interface ProjectAssetRefs {
  images: Set<string>;
  videos: Set<string>;
}

type CanvasHeldAssetRefs = { images: readonly string[]; videos: readonly string[] };
const canvasHeldAssetReaders = new Map<string, () => CanvasHeldAssetRefs>();

/** Canvas owns each reader for as long as its engine remains alive. */
export const registerCanvasHeldAssetRefs = (projectId: string, read: () => CanvasHeldAssetRefs): (() => void) => {
  canvasHeldAssetReaders.set(projectId, read);
  return () => {
    if (canvasHeldAssetReaders.get(projectId) === read) {
      canvasHeldAssetReaders.delete(projectId);
    }
  };
};

export const getCanvasHeldAssetRefs = (projectId: string): CanvasHeldAssetRefs | undefined =>
  canvasHeldAssetReaders.get(projectId)?.();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every name under a media-name key, at any depth, except subtrees whose key `skipKey` rejects. */
const collectMediaNames = (
  roots: readonly unknown[],
  skipKey: (key: string) => boolean,
  maxLength = Number.POSITIVE_INFINITY
): ProjectAssetRefs => {
  const refs: ProjectAssetRefs = { images: new Set<string>(), videos: new Set<string>() };
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (const item of node) {
        pending.push(item);
      }
      continue;
    }
    if (!isRecord(node)) {
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      if (skipKey(key)) {
        continue;
      }
      if (typeof value === 'string') {
        if (value !== '' && value.length <= maxLength) {
          if (IMAGE_NAME_KEYS.has(key)) {
            refs.images.add(value);
          } else if (VIDEO_NAME_KEYS.has(key)) {
            refs.videos.add(value);
          }
        }
      } else if (typeof value === 'object' && value !== null) {
        pending.push(value);
      }
    }
  }
  return refs;
};

const withoutHistoryRoots = (projectDocument: object): unknown[] =>
  Object.entries(projectDocument).flatMap(([key, value]) => (PROJECT_HISTORY_ROOT_KEYS.has(key) ? [] : [value]));

export const collectLiveAssetRefs = (projectDocument: Record<string, unknown>): ProjectAssetRefs =>
  collectMediaNames(
    withoutHistoryRoots(projectDocument),
    (key) => PROJECT_HISTORY_KEYS.has(key) || GALLERY_SELECTION_KEYS.has(key)
  );

/** Open editors hold live content and undo state, but not completed queue/event or gallery history. */
export const collectHeldAssetRefs = (projects: readonly object[]): ProjectAssetRefs =>
  collectMediaNames(
    projects.flatMap(withoutHistoryRoots),
    (key) => key === 'recentImages' || GALLERY_SELECTION_KEYS.has(key),
    MAX_HELD_NAME_LENGTH
  );

/** Every media name in `values`, history included: what an undo entry can restore. */
export const collectRestorableAssetRefs = (...values: unknown[]): ProjectAssetRefs =>
  collectMediaNames(values, () => false, MAX_HELD_NAME_LENGTH);

/**
 * Reads what open editors hold: each project's live content plus the undo state its Canvas engine retains. Project
 * snapshots are immutable, so a project's scan is reused until its object changes.
 */
export const createOpenProjectsHeldMediaReader = (
  getProjects: () => readonly (object & { id: string })[],
  getCanvasRefs: (projectId: string) => CanvasHeldAssetRefs | undefined = getCanvasHeldAssetRefs
): (() => { images: string[]; videos: string[] }) => {
  const scans = new Map<string, { project: object; refs: ProjectAssetRefs }>();
  return () => {
    const images = new Set<string>();
    const videos = new Set<string>();
    const open = new Set<string>();
    for (const project of getProjects()) {
      open.add(project.id);
      let scan = scans.get(project.id);
      if (scan?.project !== project) {
        scan = { project, refs: collectHeldAssetRefs([project]) };
        scans.set(project.id, scan);
      }
      scan.refs.images.forEach((name) => images.add(name));
      scan.refs.videos.forEach((name) => videos.add(name));
      const retained = getCanvasRefs(project.id);
      retained?.images.forEach((name) => images.add(name));
      retained?.videos.forEach((name) => videos.add(name));
    }
    for (const projectId of scans.keys()) {
      if (!open.has(projectId)) {
        scans.delete(projectId);
      }
    }
    return { images: [...images], videos: [...videos] };
  };
};

/** `{ drop: true }` removes the key, `{ value }` replaces it, `null` recurses into it. */
type NodeVisit = { drop: true } | { value: unknown } | null;

/** Preserve structural sharing; unchanged documents return the same object. */
const mapDocument = (node: unknown, visit: (key: string, value: unknown) => NodeVisit): unknown => {
  if (Array.isArray(node)) {
    let hasChanged = false;
    const next = node.map((item) => {
      const mapped = mapDocument(item, visit);

      hasChanged ||= mapped !== item;

      return mapped;
    });

    return hasChanged ? next : node;
  }

  if (!isRecord(node)) {
    return node;
  }

  let hasChanged = false;
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    const visited = visit(key, value);

    if (visited === null) {
      const mapped = mapDocument(value, visit);

      next[key] = mapped;
      hasChanged ||= mapped !== value;
      continue;
    }

    if ('drop' in visited) {
      hasChanged = true;
      continue;
    }

    next[key] = visited.value;
    hasChanged ||= visited.value !== value;
  }

  return hasChanged ? next : node;
};

/** Strip reserved keys at every depth, covering both persisted widget shapes. */
export const stripInstallationState = (projectDocument: Record<string, unknown>): Record<string, unknown> =>
  mapDocument(projectDocument, (key, value) => {
    if (INSTALLATION_STATE_KEYS.has(key)) {
      return { drop: true };
    }

    return DERIVED_URL_KEYS.has(key) && typeof value === 'string' ? { value: '' } : null;
  }) as Record<string, unknown>;

export interface ProjectAssetMappings {
  images: ReadonlyMap<string, string>;
  videos: ReadonlyMap<string, string>;
}

/** Use kind-specific mappings; preserve unmapped names and unchanged subtree identity. */
export const remapAssetRefs = (
  projectDocument: Record<string, unknown>,
  mappings: ProjectAssetMappings
): Record<string, unknown> =>
  mappings.images.size === 0 && mappings.videos.size === 0
    ? projectDocument
    : (mapDocument(projectDocument, (key, value) => {
        if (typeof value !== 'string') {
          return null;
        }

        const mapping = IMAGE_NAME_KEYS.has(key) ? mappings.images : VIDEO_NAME_KEYS.has(key) ? mappings.videos : null;

        return mapping === null ? null : { value: mapping.get(value) ?? value };
      }) as Record<string, unknown>);

const readGalleryRecentImageName = (projectDocument: Record<string, unknown>): string | null => {
  const instances = projectDocument.widgetInstances;

  if (!isRecord(instances)) {
    return null;
  }

  for (const instance of Object.values(instances)) {
    if (!isRecord(instance) || instance.typeId !== 'gallery' || !isRecord(instance.state)) {
      continue;
    }

    const values = instance.state.values;

    if (!isRecord(values) || !Array.isArray(values.recentImages)) {
      continue;
    }

    // recentImages must be newest-first for index zero to identify the latest result.
    for (const image of values.recentImages) {
      if (isRecord(image) && typeof image.imageName === 'string' && image.imageName !== '') {
        return image.imageName;
      }
    }
  }

  return null;
};

/** Leaves of a raw forest in preorder, tolerating malformed nodes. */
const rawLeaves = (nodes: unknown): Record<string, unknown>[] =>
  Array.isArray(nodes)
    ? nodes.flatMap((node) => (!isRecord(node) ? [] : node.type === 'group' ? rawLeaves(node.children) : [node]))
    : [];

const readTopmostCanvasImageName = (projectDocument: Record<string, unknown>): string | null => {
  const canvas = projectDocument.canvas;

  if (!isRecord(canvas) || !isRecord(canvas.document) || !isRecord(canvas.document.stacks)) {
    return null;
  }

  // The top-most raster leaf is the one a person would call "what this project looks like".
  for (const layer of rawLeaves(canvas.document.stacks.raster)) {
    if (!isRecord(layer.source)) {
      continue;
    }

    const source = layer.source;
    const ref = source.type === 'image' ? source.image : source.type === 'paint' ? source.bitmap : null;

    if (isRecord(ref) && typeof ref.imageName === 'string' && ref.imageName !== '') {
      return ref.imageName;
    }
  }

  return null;
};

/** Prefer the newest result, then the topmost raster, otherwise null. */
export const selectCoverImageName = (projectDocument: Record<string, unknown>): string | null =>
  readGalleryRecentImageName(projectDocument) ?? readTopmostCanvasImageName(projectDocument);
