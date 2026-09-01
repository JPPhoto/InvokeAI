import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { Box, chakra, Flex } from '@chakra-ui/react';
import { useCanvasRasterContentEpoch } from '@workbench/widgets/canvas/engineStoreHooks';
import { useCanvasEngine, type CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const KEY_PAN_STEP_PX = 40;

const FOCUS_PROPS = { outline: '2px solid {colors.accent.solid}', outlineOffset: '2px' };

/**
 * The navigator: a fit-to-pane composite of the whole document with the live
 * viewport outlined on top. Clicking or dragging centers the view there;
 * arrow keys pan when the preview is focused. Reads the engine's compositor
 * and viewport directly — no state of its own beyond the measured size.
 */
export const OverviewPane = () => {
  const { t } = useTranslation();
  const engine = useCanvasEngine();

  if (!engine) {
    return (
      <Flex align="center" color="fg.muted" fontSize="xs" h="full" justify="center" p="4">
        {t('widgets.properties.noCanvas')}
      </Flex>
    );
  }
  return <ConnectedOverview engine={engine} />;
};

interface OverviewFrame {
  /** Preview pixels per document unit. */
  scale: number;
  widthPx: number;
  heightPx: number;
}

const ConnectedOverview = ({ engine }: { engine: CanvasEngineHandle }) => {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<AbortController | null>(null);
  const [hostSize, setHostSize] = useState<{ width: number; height: number }>({ height: 0, width: 0 });
  const [viewRect, setViewRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  // Redraw triggers: any committed document change and live stroke content;
  // the viewport rectangle tracks zoom/pan through its own subscription below.
  const contentEpoch = useCanvasRasterContentEpoch(engine);
  const documentState = useActiveProjectSelector((project) => project.canvas.document);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const observer = new ResizeObserver((observations) => {
      // The content box: the client box includes the host padding, which would
      // let the composite overflow into it and clip the document's edges.
      const content = observations[0]?.contentRect;
      if (content) {
        setHostSize({ height: content.height, width: content.width });
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => drag.current?.abort(), []);

  // The preview geometry derives from the document and the measured pane —
  // mirroring the engine's `fitThumbnailSize` math exactly, so the drawn
  // bitmap and the rectangle overlay agree without a state round trip.
  const frame = useMemo<OverviewFrame | null>(() => {
    const maxSize = Math.floor(Math.min(hostSize.width, hostSize.height));
    const { height: docH, width: docW } = documentState;
    if (maxSize < 16 || docW <= 0 || docH <= 0) {
      return null;
    }
    const scale = Math.min(1, maxSize / docW, maxSize / docH);
    return {
      heightPx: Math.max(1, Math.round(docH * scale)),
      scale,
      widthPx: Math.max(1, Math.round(docW * scale)),
    };
  }, [documentState, hostSize]);

  // Repaint the composite when content or geometry changes; the effect only
  // updates the external canvas, never React state.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    if (!frame) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    engine.previews.drawDocumentOverview(canvas, Math.max(frame.widthPx, frame.heightPx));
  }, [contentEpoch, documentState, engine, frame]);

  // Track the live viewport rectangle in preview coordinates.
  useEffect(() => {
    if (!frame) {
      return;
    }
    const viewport = engine.viewport.getViewport();
    const update = () => {
      const size = viewport.getViewportSize();
      if (size.width <= 0 || size.height <= 0) {
        setViewRect(null);
        return;
      }
      const topLeft = viewport.screenToDocument({ x: 0, y: 0 });
      const bottomRight = viewport.screenToDocument({ x: size.width, y: size.height });
      setViewRect({
        height: (bottomRight.y - topLeft.y) * frame.scale,
        width: (bottomRight.x - topLeft.x) * frame.scale,
        x: topLeft.x * frame.scale,
        y: topLeft.y * frame.scale,
      });
    };
    update();
    return viewport.subscribe(update);
  }, [engine, frame]);

  const centerOn = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !frame) {
        return;
      }
      const bounds = canvas.getBoundingClientRect();
      const documentPoint = {
        x: (clientX - bounds.left) / frame.scale,
        y: (clientY - bounds.top) / frame.scale,
      };
      const viewport = engine.viewport.getViewport();
      const size = viewport.getViewportSize();
      const screenPoint = viewport.documentToScreen(documentPoint);
      viewport.panBy({ x: size.width / 2 - screenPoint.x, y: size.height / 2 - screenPoint.y });
    },
    [engine, frame]
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      // preventDefault suppresses focus-on-click; take it explicitly so the
      // arrow keys work right after a mouse interaction.
      event.currentTarget.focus();
      const controller = new AbortController();
      drag.current?.abort();
      drag.current = controller;
      centerOn(event.clientX, event.clientY);
      window.addEventListener('pointermove', (moveEvent) => centerOn(moveEvent.clientX, moveEvent.clientY), {
        signal: controller.signal,
      });
      window.addEventListener('pointerup', () => controller.abort(), { signal: controller.signal });
      window.addEventListener('pointercancel', () => controller.abort(), { signal: controller.signal });
    },
    [centerOn]
  );
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        // The button's activation keys mirror double-click: fit the document.
        event.preventDefault();
        engine.viewport.fitToView();
        return;
      }
      const step = event.shiftKey ? KEY_PAN_STEP_PX * 4 : KEY_PAN_STEP_PX;
      const delta =
        event.key === 'ArrowLeft'
          ? { x: step, y: 0 }
          : event.key === 'ArrowRight'
            ? { x: -step, y: 0 }
            : event.key === 'ArrowUp'
              ? { x: 0, y: step }
              : event.key === 'ArrowDown'
                ? { x: 0, y: -step }
                : null;
      if (!delta) {
        return;
      }
      event.preventDefault();
      engine.viewport.getViewport().panBy(delta);
    },
    [engine]
  );
  const fit = useCallback(() => engine.viewport.fitToView(), [engine]);
  const viewRectStyle = useMemo(() => {
    if (!viewRect || !frame) {
      return null;
    }
    return {
      height: `${Math.max(4, Math.min(viewRect.height, frame.heightPx * 2))}px`,
      left: `${Math.max(-frame.widthPx, Math.min(viewRect.x, frame.widthPx))}px`,
      top: `${Math.max(-frame.heightPx, Math.min(viewRect.y, frame.heightPx))}px`,
      width: `${Math.max(4, Math.min(viewRect.width, frame.widthPx * 2))}px`,
    };
  }, [frame, viewRect]);

  return (
    <Flex ref={hostRef} align="center" h="full" justify="center" minH="0" overflow="hidden" p="2">
      <chakra.button
        aria-label={t('widgets.layers.overviewPane.pan')}
        cursor="crosshair"
        display="block"
        position="relative"
        type="button"
        _focusVisible={FOCUS_PROPS}
        onDoubleClick={fit}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
      >
        <chakra.canvas ref={canvasRef} display="block" touchAction="none" />
        {viewRectStyle ? (
          <Box
            borderColor="accent.solid"
            borderWidth="1.5px"
            pointerEvents="none"
            position="absolute"
            rounded="xs"
            style={viewRectStyle}
          />
        ) : null}
      </chakra.button>
    </Flex>
  );
};
