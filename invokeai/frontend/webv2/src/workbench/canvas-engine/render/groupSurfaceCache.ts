/**
 * Document-space composites of adjusted groups, memoized per group. The
 * screen compositor draws one cached surface per adjusted group instead of
 * the group's members, so pans and zooms cost one blit while member edits
 * rebuild only the owning group's surface.
 *
 * The cache key folds in everything the pixels depend on: the group's stack,
 * nested scopes, and every drawn member's cache version, appearance, and
 * effective matrix (transform overrides included — a transform session inside
 * an adjusted group rebuilds per tick, which is correct, just not free).
 *
 * Accepted fidelity tradeoff: the surface is document-resolution, so a
 * transformed member resamples twice (into doc space, then through the view),
 * and zoom > 100% upscales the group from doc resolution while flat layers
 * sample their caches in one pass. Buying per-frame LUT application on the
 * viewport back with per-edit memoization is the point; sharper zoomed-in
 * group rendering is a measured follow-up, not a default.
 */

import type { CanvasRasterLayerContractV2 } from '@workbench/canvas-engine/contracts';
import type { SemanticLeaf } from '@workbench/canvas-engine/document-model/semanticLeaf';
import type { LayerCacheEntry } from '@workbench/canvas-engine/render/layerCache';
import type { RasterSurface } from '@workbench/canvas-engine/render/raster';
import type { Mat2d, Rect } from '@workbench/canvas-engine/types';

import { multiply } from '@workbench/canvas-engine/math/mat2d';
import { roundOut, transformBounds, union } from '@workbench/canvas-engine/math/rect';
import { adjustmentsKey, applyAdjustments } from '@workbench/canvas-engine/render/adjustments';
import { blendToComposite } from '@workbench/canvas-engine/render/compositor';

import type { GroupAdjustmentScope } from './groupAdjustmentScopes';

export interface GroupSurfaceResult {
  readonly surface: RasterSurface;
  /** Document-space placement of the surface. */
  readonly rect: Rect;
}

export interface GroupSurfaceDeps {
  createSurface(width: number, height: number): RasterSurface;
  getCacheEntry(layerId: string): LayerCacheEntry | undefined;
  /** The member's own adjusted pixels (its personal stack), or null for raw. */
  getAdjustedSurface(layer: CanvasRasterLayerContractV2, entry: LayerCacheEntry): RasterSurface | null;
}

export interface GroupSurfaceCache {
  /** Total RGBA bytes the cached group surfaces hold, for the memory budget. */
  byteSize(): number;
  get(
    scope: GroupAdjustmentScope,
    members: readonly SemanticLeaf[],
    memberMatrices: readonly Mat2d[],
    excludeIds: ReadonlySet<string>
  ): GroupSurfaceResult | null;
  /** Drops every cached group not named; call when document structure changes. */
  prune(liveGroupIds: ReadonlySet<string>): void;
  clear(): void;
}

const matKey = (m: Mat2d): string => `${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}`;

/** The stack surface budget: an adjusted group holds one doc-space surface. */
export const createGroupSurfaceCache = (deps: GroupSurfaceDeps): GroupSurfaceCache => {
  const cache = new Map<string, { key: string; result: GroupSurfaceResult }>();

  const scopeShapeKey = (scope: GroupAdjustmentScope): string =>
    `${scope.id}@${scope.start}-${scope.end}:${adjustmentsKey(scope.adjustments)}(${scope.children
      .map(scopeShapeKey)
      .join(',')})`;

  const buildKey = (
    scope: GroupAdjustmentScope,
    members: readonly SemanticLeaf[],
    memberMatrices: readonly Mat2d[],
    excludeIds: ReadonlySet<string>
  ): string => {
    const memberKeys = members.map((leaf, index) => {
      const layer = leaf.layer;
      const entry = deps.getCacheEntry(leaf.id);
      const own = layer.type === 'raster' ? adjustmentsKey(layer.adjustments) : '-';
      return `${leaf.id}:${entry?.version ?? -1}:${layer.opacity}:${layer.blendMode}:${matKey(memberMatrices[index]!)}:${own}`;
    });
    return `${scopeShapeKey(scope)}|${memberKeys.join('|')}|x:${[...excludeIds].sort().join(',')}`;
  };

  /**
   * Draws `[from, to)` (absolute plan indices; list order = bottom first) onto
   * `ctx`. `baseIndex` is the absolute index of `members[0]`.
   */
  const drawRange = (
    ctx: RasterSurface['ctx'],
    view: Mat2d,
    members: readonly SemanticLeaf[],
    memberMatrices: readonly Mat2d[],
    excludeIds: ReadonlySet<string>,
    baseIndex: number,
    from: number,
    to: number,
    children: readonly GroupAdjustmentScope[]
  ): void => {
    let childIndex = 0;
    for (let i = from; i < to;) {
      const child = childIndex < children.length ? children[childIndex]! : null;
      if (child && i >= child.start && i < child.end) {
        // Nested adjusted group: isolate it exactly like the parent.
        const nested = build(child, members, memberMatrices, excludeIds, baseIndex);
        if (nested) {
          ctx.save();
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
          ctx.setTransform(view.a, view.b, view.c, view.d, view.e, view.f);
          ctx.drawImage(nested.surface.canvas, nested.rect.x, nested.rect.y);
          ctx.restore();
        }
        i = child.end;
        childIndex += 1;
        continue;
      }
      const leaf = members[i - baseIndex]!;
      const matrix = memberMatrices[i - baseIndex]!;
      i += 1;
      if (excludeIds.has(leaf.id) || leaf.layer.type !== 'raster') {
        continue;
      }
      const entry = deps.getCacheEntry(leaf.id);
      if (!entry || entry.rect.width <= 0 || entry.rect.height <= 0) {
        continue;
      }
      const adjusted = deps.getAdjustedSurface(leaf.layer, entry);
      ctx.save();
      ctx.globalAlpha = leaf.layer.opacity;
      ctx.globalCompositeOperation = blendToComposite(leaf.layer.blendMode);
      const m = multiply(view, matrix);
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.drawImage((adjusted ?? entry.surface).canvas, entry.rect.x, entry.rect.y);
      ctx.restore();
    }
  };

  const build = (
    scope: GroupAdjustmentScope,
    members: readonly SemanticLeaf[],
    memberMatrices: readonly Mat2d[],
    excludeIds: ReadonlySet<string>,
    baseIndex: number
  ): GroupSurfaceResult | null => {
    // Document-space bounds of the drawn members.
    let bounds: Rect | null = null;
    for (let i = scope.start; i < scope.end; i += 1) {
      const leaf = members[i - baseIndex]!;
      if (excludeIds.has(leaf.id) || leaf.layer.type !== 'raster') {
        continue;
      }
      const entry = deps.getCacheEntry(leaf.id);
      if (!entry || entry.rect.width <= 0 || entry.rect.height <= 0) {
        continue;
      }
      const memberBounds = transformBounds(memberMatrices[i - baseIndex]!, entry.rect);
      bounds = bounds === null ? memberBounds : union(bounds, memberBounds);
    }
    if (bounds === null) {
      return null;
    }
    const rect = roundOut(bounds);
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const surface = deps.createSurface(rect.width, rect.height);
    const ctx = surface.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const view: Mat2d = { a: 1, b: 0, c: 0, d: 1, e: -rect.x, f: -rect.y };
    drawRange(ctx, view, members, memberMatrices, excludeIds, baseIndex, scope.start, scope.end, scope.children);
    const pixels = ctx.getImageData(0, 0, rect.width, rect.height);
    applyAdjustments(pixels, scope.adjustments);
    ctx.putImageData(pixels, 0, 0);
    return { rect, surface };
  };

  return {
    byteSize: () => {
      let bytes = 0;
      for (const { result } of cache.values()) {
        bytes += result.rect.width * result.rect.height * 4;
      }
      return bytes;
    },
    clear: () => cache.clear(),
    get: (scope, members, memberMatrices, excludeIds) => {
      const key = buildKey(scope, members, memberMatrices, excludeIds);
      const cached = cache.get(scope.id);
      if (cached && cached.key === key) {
        return cached.result;
      }
      const result = build(scope, members, memberMatrices, excludeIds, scope.start);
      if (result) {
        cache.set(scope.id, { key, result });
      } else {
        cache.delete(scope.id);
      }
      return result;
    },
    prune: (liveGroupIds) => {
      for (const id of cache.keys()) {
        if (!liveGroupIds.has(id)) {
          cache.delete(id);
        }
      }
    },
  };
};
