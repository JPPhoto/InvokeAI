import {
  distanceBetween,
  midpointOf,
  panBy,
  pinchZoomAtPoints,
  WHEEL_ZOOM_STEP,
  zoomAtPoint as calculateZoomAtPoint,
  type PanZoomPoint,
} from '@workbench/panZoom';
/* eslint-disable react/react-compiler */
import { useCallback, useRef, useState, type MouseEvent, type PointerEvent } from 'react';

import { capturePointer, releasePointer, trackPointerDown } from './loupeGestures';

/**
 * Shared zoom/pan for the side-by-side comparison panes: one transform, kept
 * in image-fraction space (scale is unitless; translation is a fraction of the
 * pane's rendered size), applied imperatively to every registered pane. Zoom
 * into the left eye and the right pane's left eye follows. Gated by the caller
 * to matching-dimension pairs, where fraction space is exact.
 *
 * On a touch screen two fingers pinch — zooming and panning in one gesture,
 * against the pane they landed on — and one finger pans an already-zoomed pair.
 */

const MAX_ACTUAL_ZOOM = 8;
const PIXELATED_ACTUAL_ZOOM = 2;

interface FractionTransform {
  scale: number;
  fx: number;
  fy: number;
}

interface PaneElements {
  frame: HTMLDivElement | null;
  image: HTMLImageElement | null;
}

/**
 * A live two-finger pinch. Like the transform it drives, the gesture is
 * measured in the fraction space of the pane it started on, all of it captured
 * up front so each move resolves to one transition from where it began.
 */
interface PinchGesture {
  paneIndex: 0 | 1;
  pointerIds: [number, number];
  /** The starting pane's client rect, frozen for the gesture. */
  rect: { height: number; left: number; top: number; width: number };
  startCenter: PanZoomPoint;
  startDistance: number;
  startTransform: FractionTransform;
}

export interface CompareLoupePane {
  frameProps: {
    onDoubleClick: (event: MouseEvent<HTMLDivElement>) => void;
    onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  };
  frameRefCallback: (node: HTMLDivElement | null) => void;
  imageRefCallback: (node: HTMLImageElement | null) => void;
}

const clampFraction = (f: number, scale: number): number =>
  scale <= 1 ? (1 - scale) / 2 : Math.min(0, Math.max(1 - scale, f));

export const useCompareLoupe = ({
  enabled,
  naturalWidth,
}: {
  enabled: boolean;
  naturalWidth: number;
}): { getPane: (index: 0 | 1) => CompareLoupePane | null; isZoomed: boolean } => {
  const transformRef = useRef<FractionTransform>({ fx: 0, fy: 0, scale: 1 });
  const panesRef = useRef<[PaneElements, PaneElements]>([
    { frame: null, image: null },
    { frame: null, image: null },
  ]);
  const rafRef = useRef<number | null>(null);
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; fx: number; fy: number } | null>(null);
  /** Every pointer currently down on either pane, in client space, in arrival order. */
  const pointersRef = useRef(new Map<number, PanZoomPoint>());
  const pinchRef = useRef<PinchGesture | null>(null);
  const naturalWidthRef = useRef(naturalWidth);
  naturalWidthRef.current = naturalWidth;
  const [isZoomed, setIsZoomed] = useState(false);

  const apply = useCallback(() => {
    if (rafRef.current !== null) {
      return;
    }

    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const { fx, fy, scale } = transformRef.current;
      const isFit = scale === 1;

      for (const pane of panesRef.current) {
        const { frame, image } = pane;

        if (!frame || !image) {
          continue;
        }

        image.style.transform = isFit
          ? ''
          : `translate(${fx * frame.clientWidth}px, ${fy * frame.clientHeight}px) scale(${scale})`;
        image.style.transformOrigin = '0 0';

        const actualZoom = (scale * frame.clientWidth) / Math.max(1, naturalWidthRef.current);

        image.style.imageRendering = !isFit && actualZoom >= PIXELATED_ACTUAL_ZOOM ? 'pixelated' : '';
      }

      setIsZoomed(!isFit);
    });
  }, []);

  const setTransform = useCallback(
    (next: FractionTransform) => {
      const scale = next.scale;

      transformRef.current =
        scale === 1
          ? { fx: 0, fy: 0, scale: 1 }
          : { fx: clampFraction(next.fx, scale), fy: clampFraction(next.fy, scale), scale };
      apply();
    },
    [apply]
  );

  /** Never below fit, never past `MAX_ACTUAL_ZOOM` of the images' own pixels. */
  const constrainScale = useCallback((scale: number): number => {
    const firstFrame = panesRef.current.find((pane) => pane.frame)?.frame ?? null;
    const maxScale = firstFrame
      ? Math.max(1, (MAX_ACTUAL_ZOOM * naturalWidthRef.current) / Math.max(1, firstFrame.clientWidth))
      : MAX_ACTUAL_ZOOM;

    return Math.max(1, Math.min(scale, maxScale));
  }, []);

  const zoomAroundFraction = useCallback(
    (pfx: number, pfy: number, nextScale: number) => {
      const { fx, fy, scale } = transformRef.current;
      const next = calculateZoomAtPoint(
        { pan: { x: fx, y: fy }, zoom: scale },
        nextScale,
        { x: pfx, y: pfy },
        constrainScale
      );

      setTransform({
        fx: next.pan.x,
        fy: next.pan.y,
        scale: next.zoom,
      });
    },
    [constrainScale, setTransform]
  );

  const handleWheel = useCallback(
    (node: HTMLDivElement, event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();

      if (rect.width === 0 || rect.height === 0) {
        return;
      }

      const sensitivity = event.ctrlKey ? WHEEL_ZOOM_STEP * 4 : WHEEL_ZOOM_STEP;

      zoomAroundFraction(
        (event.clientX - rect.left) / rect.width,
        (event.clientY - rect.top) / rect.height,
        transformRef.current.scale * Math.exp(-event.deltaY * sensitivity)
      );
    },
    [zoomAroundFraction]
  );

  // One stable set of callbacks per pane index; wheel listeners need manual
  // attachment (`passive: false`) so ref callbacks with cleanup own them.
  const [panes] = useState<[CompareLoupePane, CompareLoupePane]>(() => {
    const createPane = (index: 0 | 1): CompareLoupePane => ({
      frameProps: {
        onDoubleClick: (event) => {
          const frame = panesRef.current[index].frame;

          if (!frame || frame.clientWidth === 0) {
            return;
          }

          if (transformRef.current.scale !== 1) {
            setTransform({ fx: 0, fy: 0, scale: 1 });
            return;
          }

          const rect = frame.getBoundingClientRect();

          zoomAroundFraction(
            (event.clientX - rect.left) / rect.width,
            (event.clientY - rect.top) / rect.height,
            Math.max(1, naturalWidthRef.current / frame.clientWidth)
          );
        },
        onLostPointerCapture: (event) => endPointer(event),
        onPointerCancel: (event) => endPointer(event),
        onPointerDown: (event) => {
          if (event.button !== 0) {
            return;
          }

          if (event.isPrimary) {
            pinchRef.current = null;
          }

          const pointers = pointersRef.current;
          const pair = trackPointerDown(pointers, event);

          if (pair && !pinchRef.current) {
            event.preventDefault();
            const pinch = beginPinch(index, pair);

            if (pinch) {
              // Both fingers are captured for the whole gesture, so one that
              // strays off the pane keeps reporting instead of sticking.
              for (const pointerId of pinch.pointerIds) {
                capturePointer(event.currentTarget, pointerId);
              }
            }

            return;
          }

          if (pointers.size !== 1 || transformRef.current.scale === 1) {
            return;
          }

          event.preventDefault();
          capturePointer(event.currentTarget, event.pointerId);
          beginPan(event.pointerId, { x: event.clientX, y: event.clientY });
        },
        onPointerMove: (event) => {
          const pointers = pointersRef.current;

          if (pointers.has(event.pointerId)) {
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
          }

          if (applyPinch(event)) {
            return;
          }

          const pan = panRef.current;
          const frame = panesRef.current[index].frame;

          if (!pan || pan.pointerId !== event.pointerId || !frame || frame.clientWidth === 0) {
            return;
          }

          event.preventDefault();
          const next = panBy(
            { pan: { x: pan.fx, y: pan.fy }, zoom: transformRef.current.scale },
            {
              x: (event.clientX - pan.startX) / frame.clientWidth,
              y: (event.clientY - pan.startY) / frame.clientHeight,
            }
          );
          setTransform({ fx: next.pan.x, fy: next.pan.y, scale: next.zoom });
        },
        onPointerUp: (event) => endPointer(event),
      },
      frameRefCallback: (node) => {
        panesRef.current[index].frame = node;

        if (!node) {
          return;
        }

        const onWheel = (event: WheelEvent): void => handleWheel(node, event);

        node.addEventListener('wheel', onWheel, { passive: false });
        apply();

        return () => {
          node.removeEventListener('wheel', onWheel);
        };
      },
      imageRefCallback: (node) => {
        panesRef.current[index].image = node;

        if (node) {
          apply();
        }
      },
    });
    /** Starts a pan from the given pointer's position, at the current transform. */
    const beginPan = (pointerId: number, from: PanZoomPoint): void => {
      panRef.current = {
        fx: transformRef.current.fx,
        fy: transformRef.current.fy,
        pointerId,
        startX: from.x,
        startY: from.y,
      };
    };

    /**
     * Arms a pinch on two down pointers, measured in the fraction space of the
     * pane given. Returns null — leaving no gesture — if that pane cannot be
     * measured or the fingers landed on the same spot.
     */
    const beginPinch = (paneIndex: 0 | 1, pointerIds: [number, number]): PinchGesture | null => {
      const frame = panesRef.current[paneIndex].frame;
      const first = pointersRef.current.get(pointerIds[0]);
      const second = pointersRef.current.get(pointerIds[1]);

      if (!frame || !first || !second) {
        return null;
      }

      const rect = frame.getBoundingClientRect();
      const distance = distanceBetween(first, second);

      if (rect.width === 0 || rect.height === 0 || distance === 0) {
        return null;
      }

      const center = midpointOf(first, second);

      panRef.current = null;
      pinchRef.current = {
        paneIndex,
        pointerIds,
        rect: { height: rect.height, left: rect.left, top: rect.top, width: rect.width },
        startCenter: { x: (center.x - rect.left) / rect.width, y: (center.y - rect.top) / rect.height },
        startDistance: distance,
        startTransform: transformRef.current,
      };

      return pinchRef.current;
    };

    /** Applies a move to the live pinch; reports whether the pinch owns it. */
    const applyPinch = (event: PointerEvent<HTMLDivElement>): boolean => {
      const pinch = pinchRef.current;

      if (!pinch) {
        return false;
      }

      const first = pointersRef.current.get(pinch.pointerIds[0]);
      const second = pointersRef.current.get(pinch.pointerIds[1]);

      if (!pinch.pointerIds.includes(event.pointerId) || !first || !second) {
        return true;
      }

      event.preventDefault();
      const center = midpointOf(first, second);
      const next = pinchZoomAtPoints(
        { pan: { x: pinch.startTransform.fx, y: pinch.startTransform.fy }, zoom: pinch.startTransform.scale },
        {
          center: {
            x: (center.x - pinch.rect.left) / pinch.rect.width,
            y: (center.y - pinch.rect.top) / pinch.rect.height,
          },
          distance: distanceBetween(first, second),
          startCenter: pinch.startCenter,
          startDistance: pinch.startDistance,
        },
        constrainScale
      );

      setTransform({ fx: next.pan.x, fy: next.pan.y, scale: next.zoom });

      return true;
    };

    const endPointer = (event: PointerEvent<HTMLDivElement>): void => {
      const pointers = pointersRef.current;

      if (pointers.delete(event.pointerId)) {
        releasePointer(event.currentTarget, event.pointerId);
      }

      const pinch = pinchRef.current;

      if (pinch?.pointerIds.includes(event.pointerId)) {
        pinchRef.current = null;
        const remaining = [...pointers.keys()];

        // Lifting one finger of a three-finger gesture re-pinches on what is
        // left; lifting to a single finger hands the gesture over to a pan, so
        // the images keep following that finger without a release and retouch.
        if (remaining.length >= 2) {
          const next = beginPinch(pinch.paneIndex, [remaining[0]!, remaining[1]!]);

          for (const pointerId of next?.pointerIds ?? []) {
            capturePointer(event.currentTarget, pointerId);
          }

          return;
        }

        const last = remaining[0];
        const lastPoint = last === undefined ? undefined : pointers.get(last);

        if (last !== undefined && lastPoint && transformRef.current.scale !== 1) {
          beginPan(last, lastPoint);
        }

        return;
      }

      if (panRef.current?.pointerId !== event.pointerId) {
        return;
      }

      panRef.current = null;
    };

    return [createPane(0), createPane(1)];
  });

  if (!enabled) {
    return { getPane: () => null, isZoomed: false };
  }

  return { getPane: (index) => panes[index], isZoomed };
};
