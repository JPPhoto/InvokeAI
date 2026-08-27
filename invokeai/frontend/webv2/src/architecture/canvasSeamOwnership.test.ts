import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isProductionSourcePath, primeImportSources, resolveImportPath } from './dependencyPolicy';
import { analyzeSource, closeSourceAnalysis } from './tsSourceAnalysis';

const sources = import.meta.glob('../workbench/**/*.{ts,tsx}', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

const productionSources = Object.entries(sources)
  .map(([path, source]) => [path.replace(/^\.\.\//, ''), source] as const)
  .filter(([path]) => isProductionSourcePath(path));

beforeAll(() => primeImportSources(productionSources));
afterAll(closeSourceAnalysis);

/** Modules that may take part in stack order and selection repair: the reducer and the document seam. */
const DOCUMENT_SEAM_OWNERS = [
  /^workbench\/canvasProjectMutations\.ts$/,
  /^workbench\/canvas-engine\/document\//,
  /^workbench\/canvas-engine\/document-model\//,
];

/** Modules whose namespace import would hide a seam-only symbol behind a qualifier. */
const SEAM_MODULES = [
  'workbench/canvas-engine/document/layerStacks',
  'workbench/canvas-engine/document/selectionRepair',
];

/**
 * Mutations that restructure the layer list. Outside the engine and the reducer only gallery import
 * builds them, because it ingests into projects that have no mounted engine. The engine grant covers
 * every engine module: controllers build these as forward/inverse pairs for the prepared-dispatch
 * protocol, history replays them raw, and the paint tool creates and rolls back its auto-created
 * layer outside history by design. The scan matches the formatted literal `type: '…'`.
 */
const STRUCTURAL_MUTATION_TYPES = [
  'addCanvasLayer',
  'applyCanvasLayerStackMutation',
  'convertCanvasLayer',
  'duplicateCanvasLayer',
  'mergeCanvasLayersDown',
  'removeCanvasLayers',
  'reorderCanvasLayerStacks',
  'replaceCanvasDocument',
  'replaceCanvasLayer',
  'restoreCanvasSnapshot',
  'setCanvasLayerPositions',
  'setCanvasLayersEnabled',
  'setCanvasLayersHidden',
  'updateCanvasLayerSource',
];
const STRUCTURAL_MUTATION_OWNERS = [
  /^workbench\/canvasProjectMutations\.ts$/,
  /^workbench\/canvas-engine\//,
  /^workbench\/canvas-operations\/importGalleryImages\.ts$/,
];
const structuralLiteral = new RegExp(`type: '(?:${STRUCTURAL_MUTATION_TYPES.join('|')})'`, 'g');

const SEAM_ONLY_SYMBOLS = ['repairSelectedLayerId', 'moveLayersWithinStacks', 'reorderLayerStack'];

/** Production planners that consume the document model; dropping the import would reopen an ad-hoc path. */
const MODEL_CONSUMERS = [
  'workbench/canvas-engine/render/compositor.ts',
  'workbench/canvas-engine/render/frameDemand.ts',
  'workbench/canvas-engine/render/overlayFrame.ts',
  'workbench/canvas-engine/render/floatingSelectionFrame.ts',
  'workbench/canvas-engine/render/rasterComposite.ts',
  'workbench/canvas-engine/controllers/mergeLayerController.ts',
  'workbench/canvas-operations/generationCompositePlan.ts',
];

const MODEL_MODULE = 'workbench/canvas-engine/document-model/flatDocumentModel';

describe('canvas document seam ownership', () => {
  it('keeps stack mutation and selection repair inside the reducer and the document seam', () => {
    const offenders: string[] = [];
    for (const [path, source] of productionSources) {
      if (DOCUMENT_SEAM_OWNERS.some((owner) => owner.test(path))) {
        continue;
      }
      for (const reference of analyzeSource(path, source, { jsx: true }).moduleReferences) {
        if (reference.kind === 'import-type') {
          continue;
        }
        if (reference.namespace && SEAM_MODULES.includes(resolveImportPath(path, reference.specifier) ?? '')) {
          offenders.push(`${path} imports ${reference.specifier} as a namespace`);
        }
        for (const symbol of reference.symbols) {
          if (SEAM_ONLY_SYMBOLS.includes(symbol)) {
            offenders.push(`${path} imports ${symbol} from ${reference.specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  }, 60_000);

  it('keeps structural mutations behind the engine transaction', () => {
    const offenders: string[] = [];
    for (const [path, source] of productionSources) {
      if (STRUCTURAL_MUTATION_OWNERS.some((owner) => owner.test(path))) {
        continue;
      }
      for (const match of source.matchAll(structuralLiteral)) {
        offenders.push(`${path} builds ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(MODEL_CONSUMERS)('%s consumes the document model', (path) => {
    const source = productionSources.find(([candidate]) => candidate === path)?.[1];
    expect(source, `${path} is missing`).toBeDefined();
    const targets = analyzeSource(path, source!, { jsx: true }).moduleReferences.map((reference) =>
      resolveImportPath(path, reference.specifier)
    );
    expect(targets).toContain(MODEL_MODULE);
  });
});
