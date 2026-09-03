import type { ComponentProps, ReactNode, RefObject } from 'react';

import { ScrollArea } from '@chakra-ui/react';
import { useMountEffect } from '@platform/react/useMountEffect';
import { usePreservedScrollOffset } from '@platform/react/usePreservedScrollOffset';
import { useRef } from 'react';

type ScrollAreaRootProps = ComponentProps<typeof ScrollArea.Root>;
type ScrollAreaContentProps = ComponentProps<typeof ScrollArea.Content>;
type ScrollAreaViewportProps = ComponentProps<typeof ScrollArea.Viewport>;

/**
 * zag pins `min-width: fit-content` *inline* on every scroll-area content box,
 * so the box grows to its content's min-content width. A horizontal strip wants
 * exactly that. In a vertical area it is a trap: one unbreakable string (a long
 * name, an unwrapped identifier) widens the content box past the viewport, the
 * area scrolls sideways — and since a vertical area renders no horizontal
 * scrollbar, the overflow is simply unreachable. Vertical areas override it back
 * to zero, so their content stretches to the viewport and truncation inside is
 * what gives. Only an inline style can beat an inline style.
 */
const VERTICAL_CONTENT_STYLE = { minWidth: 0 } as const;

/**
 * The workbench's standard scroll container: ScrollArea with hover-revealed
 * scrollbars and the content wrapper zag needs for correct thumb sizing.
 * Layout props (h, maxH, flex, ...) go to the root.
 */
export const Scrollable = ({
  children,
  contentProps,
  label,
  orientation = 'vertical',
  viewportProps,
  viewportRef,
  ...rootProps
}: ScrollAreaRootProps & {
  children: ReactNode;
  /** Extra props for the content wrapper, e.g. to let children fill the viewport height. */
  contentProps?: ScrollAreaContentProps;
  /** Accessible name for the scroll viewport. */
  label?: string;
  /** Scroll axis; the scrollbar and content sizing follow it. Defaults to vertical. */
  orientation?: 'horizontal' | 'vertical';
  /** Extra props for the scrolling viewport itself, e.g. scroll/focus handlers. */
  viewportProps?: ScrollAreaViewportProps;
  /** The scrolling element itself — what a virtualizer needs to observe. */
  viewportRef?: RefObject<HTMLDivElement | null>;
}) => {
  const fallbackViewportRef = useRef<HTMLDivElement | null>(null);
  // One ref, shared with the caller when it wants one, so nothing has to merge
  // or reassign refs during render.
  const resolvedViewportRef = viewportRef ?? fallbackViewportRef;

  // The shell keeps widgets mounted across layout switches, and a scroll
  // container that stops being rendered loses its offset outright.
  usePreservedScrollOffset(resolvedViewportRef);

  // Zag's initial measure can race a popover's zero-size mount (its resize
  // observers can even end up watching pre-remount nodes), and its
  // "has overflow" default then strands a phantom thumb on content that never
  // overflowed. Whenever a check finds that contradiction on the live nodes,
  // one synthetic scroll routes a re-measure through zag's own event path —
  // and clears the contradiction, so the checks cannot loop. Scroll listeners
  // on these viewports must tolerate a no-op scroll event.
  useMountEffect(() => {
    // Always through the ref: a popover's presence pass can remount the
    // subtree, and a node captured at effect time goes dead (which is also
    // how zag's own observers end up blind here).
    const hasPhantomScrollbar = () => {
      const viewport = resolvedViewportRef.current;
      // `:scope >`: a nested Scrollable's scrollbar must not answer for ours.
      const scrollbar = viewport?.parentElement?.querySelector(':scope > [data-part="scrollbar"]');

      if (!viewport || !scrollbar) {
        return false;
      }

      const phantomY = scrollbar.hasAttribute('data-overflow-y') && viewport.scrollHeight <= viewport.clientHeight;
      const phantomX = scrollbar.hasAttribute('data-overflow-x') && viewport.scrollWidth <= viewport.clientWidth;

      return Boolean(phantomY || phantomX);
    };

    let observed: HTMLElement | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const observer = new ResizeObserver(() => check());

    const check = () => {
      const viewport = resolvedViewportRef.current;

      if (!viewport) {
        return;
      }

      if (viewport !== observed) {
        if (observed) {
          observer.unobserve(observed);
        }

        observer.observe(viewport);
        observed = viewport;
      }

      if (hasPhantomScrollbar()) {
        viewport.dispatchEvent(new Event('scroll'));
      }
    };

    // The timed checks catch a presence remount the observer can no longer
    // see; each re-syncs observation to the ref's current node, and the
    // re-synced observer covers real resizes from then on.
    for (const delay of [64, 250, 600]) {
      timers.push(setTimeout(check, delay));
    }

    check();

    return () => {
      timers.forEach(clearTimeout);
      observer.disconnect();
    };
  });

  return (
    <ScrollArea.Root size="xs" variant="hover" {...rootProps}>
      <ScrollArea.Viewport
        aria-label={label}
        h="full"
        role={label ? 'region' : undefined}
        w="full"
        {...viewportProps}
        ref={resolvedViewportRef}
      >
        <ScrollArea.Content
          style={orientation === 'horizontal' ? undefined : VERTICAL_CONTENT_STYLE}
          w={orientation === 'horizontal' ? 'max-content' : 'full'}
          {...contentProps}
        >
          {children}
        </ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar orientation={orientation}>
        <ScrollArea.Thumb />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
};
