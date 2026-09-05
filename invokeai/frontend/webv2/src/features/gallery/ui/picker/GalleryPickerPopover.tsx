import type { GalleryItem } from '@features/gallery/core/items';
import type { ReactElement } from 'react';

import { Popover, Portal } from '@chakra-ui/react';
import { PopoverContent } from '@platform/ui/Popover';
import { useCallback, useRef, useState } from 'react';

import type { GalleryPickerAccept, GalleryPickerSelection } from './galleryPicker';

import { GalleryPickerView } from './GalleryPickerView';

const POSITIONING = { placement: 'bottom-start' } as const;
const SINGLE_SELECTION: GalleryPickerSelection = { mode: 'single' };

export interface GalleryPickerPopoverProps {
  accept: GalleryPickerAccept;
  /** The trigger element; must accept a ref and a click handler. */
  children: ReactElement;
  /** The dialog's accessible name, e.g. "Choose image". */
  label: string;
  selection?: GalleryPickerSelection;
  onPick: (item: GalleryItem) => void;
}

/**
 * A compact gallery anchored to an image slot. The view mounts on open and
 * unmounts on close, so every open starts from the Gallery widget's scope.
 */
export const GalleryPickerPopover = ({
  accept,
  children,
  label,
  selection = SINGLE_SELECTION,
  onPick,
}: GalleryPickerPopoverProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleOpenChange = useCallback(({ open }: { open: boolean }) => setIsOpen(open), []);
  const close = useCallback(() => setIsOpen(false), []);
  const getInitialFocusEl = useCallback(() => searchInputRef.current, []);

  return (
    <Popover.Root
      initialFocusEl={getInitialFocusEl}
      lazyMount
      open={isOpen}
      positioning={POSITIONING}
      unmountOnExit
      onOpenChange={handleOpenChange}
    >
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <PopoverContent
            aria-label={label}
            display="flex"
            flexDirection="column"
            maxH="min(26rem, var(--available-height))"
            overflow="hidden"
            p="0"
            w="clamp(18rem, var(--reference-width), 28rem)"
          >
            <GalleryPickerView
              accept={accept}
              searchInputRef={searchInputRef}
              selection={selection}
              onClose={close}
              onPick={onPick}
            />
          </PopoverContent>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
};
