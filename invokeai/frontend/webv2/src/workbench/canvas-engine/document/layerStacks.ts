import type { CanvasLayerContract } from '@workbench/canvas-engine/contracts';

/**
 * The four flat stacks of a v2 document. A layer's stack is its type; the compositor draws the
 * stacks bottom to top in {@link LAYER_STACK_ORDER} and the Layers panel lists them top first, so a
 * layer's index in `document.layers` only orders it against other members of its own stack.
 */
export type LayerStackKind = CanvasLayerContract['type'];

export const LAYER_STACK_ORDER: readonly LayerStackKind[] = ['raster', 'control', 'regional_guidance', 'inpaint_mask'];

export const LAYER_STACKS_TOP_FIRST: readonly LayerStackKind[] = [...LAYER_STACK_ORDER].reverse();

export const layerStackOf = (layer: CanvasLayerContract): LayerStackKind => layer.type;

export const layerStackRank = (layer: CanvasLayerContract): number => LAYER_STACK_ORDER.indexOf(layer.type);

/** Reorders one stack; `orderedIds` must be exactly the stack's current members, top first. */
export interface ReorderFlatStackCommand {
  readonly stack: LayerStackKind;
  readonly orderedIds: readonly string[];
}

export const getStackOrder = (
  layers: readonly CanvasLayerContract[],
  stack: LayerStackKind
): ReorderFlatStackCommand => ({
  orderedIds: layers.filter((layer) => layer.type === stack).map((layer) => layer.id),
  stack,
});

/**
 * Writes the command's order back into the flat slots its stack occupies, leaving every other
 * stack untouched. Returns `null` when the ids are not exactly the stack's members.
 */
export const reorderLayerStack = <Layer extends CanvasLayerContract>(
  layers: readonly Layer[],
  command: ReorderFlatStackCommand
): Layer[] | null => {
  const slots: number[] = [];
  const byId = new Map<string, Layer>();
  layers.forEach((layer, index) => {
    if (layer.type === command.stack) {
      slots.push(index);
      byId.set(layer.id, layer);
    }
  });
  if (command.orderedIds.length !== slots.length || new Set(command.orderedIds).size !== slots.length) {
    return null;
  }
  const next = [...layers];
  for (const [position, id] of command.orderedIds.entries()) {
    const layer = byId.get(id);
    if (!layer) {
      return null;
    }
    next[slots[position]!] = layer;
  }
  return next;
};

/** A z-move within a stack; index 0 is the front (top). */
export type LayerStackMoveKind = 'front' | 'forward' | 'backward' | 'back';

const moveSelectedIds = (
  orderedIds: readonly string[],
  selected: ReadonlySet<string>,
  kind: LayerStackMoveKind
): string[] => {
  if (kind === 'front' || kind === 'back') {
    const moving = orderedIds.filter((id) => selected.has(id));
    const remaining = orderedIds.filter((id) => !selected.has(id));
    return kind === 'front' ? [...moving, ...remaining] : [...remaining, ...moving];
  }
  const next = [...orderedIds];
  if (kind === 'forward') {
    for (let index = 1; index < next.length; index += 1) {
      if (selected.has(next[index]!) && !selected.has(next[index - 1]!)) {
        [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
      }
    }
  } else {
    for (let index = next.length - 2; index >= 0; index -= 1) {
      if (selected.has(next[index]!) && !selected.has(next[index + 1]!)) {
        [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
      }
    }
  }
  return next;
};

/**
 * Moves every selected layer within its own stack, selected members keeping their relative order.
 * Returns one command per stack whose order changes, top stack first.
 */
export const moveLayersWithinStacks = (
  layers: readonly CanvasLayerContract[],
  selectedIds: readonly string[],
  kind: LayerStackMoveKind
): ReorderFlatStackCommand[] => {
  const selected = new Set(selectedIds);
  const commands: ReorderFlatStackCommand[] = [];
  for (const stack of LAYER_STACKS_TOP_FIRST) {
    const { orderedIds } = getStackOrder(layers, stack);
    const moved = moveSelectedIds(orderedIds, selected, kind);
    if (moved.some((id, index) => id !== orderedIds[index])) {
      commands.push({ orderedIds: moved, stack });
    }
  }
  return commands;
};
