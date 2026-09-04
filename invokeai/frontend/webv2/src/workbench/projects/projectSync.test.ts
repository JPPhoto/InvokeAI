import type { Project } from '@workbench/projectContracts';

import { getProjectWidgetValues } from '@workbench/widgetState';
import { createInitialWorkbenchState, workbenchReducer } from '@workbench/workbenchState.testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectRecoveredIdentity } from './projectFlush';

import {
  applyAuthoritativeProjectBoard,
  serializeProjectDocumentV2,
  serializeProjectDocumentV2Json,
} from './projectDocument';
import {
  createRecoveredDocument,
  deserializeProjectDocument,
  deserializeProjectRecord,
  serializeProjectDocument,
} from './syncedPersistence';

const getProject = (overrides: Partial<Project> = {}): Project => {
  const state = createInitialWorkbenchState();

  return { ...state.projects[0], ...overrides };
};

const loadDocument = (document: Record<string, unknown>): Project => {
  const result = deserializeProjectDocument(document);

  if (result.status !== 'loaded') {
    throw new Error(`Expected the document to load, got ${result.status}.`);
  }

  return result.project;
};

describe('project document serialization', () => {
  it('serializes only the V2 durable allowlist and restores session state empty', () => {
    const project = getProject();

    project.undoRedo.past.push({
      createdAt: 'now',
      id: 'undo-1',
      label: 'test',
      project: {
        invocation: project.invocation,
        layout: project.layout,
        projectGraph: project.projectGraph,
        widgetGraphs: {},
        widgetInstances: project.widgetInstances,
        widgetRegions: project.widgetRegions,
      },
    });
    project.queue.items.push({} as never);
    project.events.push({} as never);
    project.graphHistory.push({} as never);
    project.recoveryOf = 'old-project';
    project.recoveredAt = '2026-01-01T00:00:00.000Z';
    (project as Project & { futureField: string }).futureField = 'must-not-leak';

    const document = serializeProjectDocumentV2(project);

    expect(Object.keys(document).sort()).toEqual(
      [
        'canvas',
        'documentSchemaVersion',
        'id',
        'invocation',
        'layout',
        'name',
        'projectGraph',
        'promptHistory',
        'settings',
        'widgetGraphs',
        'widgetInstances',
        'widgetRegions',
      ].sort()
    );
    expect(document.documentSchemaVersion).toBe(2);

    const roundTripped = loadDocument(document);

    expect(roundTripped.undoRedo).toEqual({ future: [], past: [] });
    expect(roundTripped.queue).toEqual({ items: [] });
    expect(roundTripped.events).toEqual([]);
    expect(roundTripped.graphHistory).toEqual([]);
    expect(roundTripped.id).toBe(project.id);
    expect(roundTripped.widgetInstances).toEqual(project.widgetInstances);
  });

  it('measures the exact UTF-8 wire bytes once', () => {
    const project = getProject({ name: '文書' });
    const encoded = serializeProjectDocumentV2Json(project);

    expect(encoded.document).toEqual(serializeProjectDocumentV2(project));
    expect(encoded.documentJson).toBe(JSON.stringify(encoded.document));
    expect(encoded.byteSize).toBe(new TextEncoder().encode(encoded.documentJson).byteLength);
  });

  it('rejects documents that do not look like projects', () => {
    expect(deserializeProjectDocument({})).toEqual({ status: 'unavailable' });
    expect(deserializeProjectDocument({ id: 'x' })).toEqual({ status: 'unavailable' });
    expect(deserializeProjectDocument({ id: 'x', layout: null, name: 'y' })).toEqual({ status: 'unavailable' });
  });

  it('refuses a document whose canvas was written by a newer client, keeping the raw document', () => {
    const project = getProject();
    const document = serializeProjectDocument(project);
    const future = { ...document, canvas: { ...(document.canvas as object), version: 4 } };

    const result = deserializeProjectDocument(future);

    expect(result).toMatchObject({
      refused: {
        projectId: project.id,
        raw: future,
        refusal: { scope: 'state', status: 'unsupported-version', version: 4 },
        source: 'canvas',
      },
      status: 'refused',
    });
  });

  it('refuses a newer project document schema while preserving its raw bytes for export', () => {
    const project = getProject();
    const future = { ...serializeProjectDocumentV2(project), documentSchemaVersion: 3 };

    expect(deserializeProjectDocument(future)).toEqual({
      refused: {
        projectId: project.id,
        projectName: project.name,
        raw: future,
        refusal: {
          raw: future,
          scope: 'project-document',
          status: 'unsupported-version',
          version: 3,
        },
        source: 'project-document',
      },
      status: 'refused',
    });
  });

  it('uses authoritative server identity and untouched bytes for a future document refusal', () => {
    const raw = {
      documentSchemaVersion: 3,
      id: 'untrusted-id',
      name: 'Untrusted name',
      widgetInstances: {
        gallery: { state: { values: { boardId: 'stale-board' } }, typeId: 'gallery' },
      },
    };

    expect(
      deserializeProjectRecord({
        board_id: 'authoritative-board',
        created_at: '2026-09-03T00:00:00.000Z',
        data: raw,
        minimum_canvas_schema_version: 3,
        name: 'Authoritative name',
        project_id: 'authoritative-id',
        revision: 4,
        updated_at: '2026-09-03T00:00:00.000Z',
      })
    ).toEqual({
      refused: {
        projectId: 'authoritative-id',
        projectName: 'Authoritative name',
        raw,
        refusal: { raw, scope: 'project-document', status: 'unsupported-version', version: 3 },
        source: 'project-document',
      },
      status: 'refused',
    });
  });

  it('normalizes legacy project-graph invocation sources to workflow', () => {
    const base = getProject();
    const project = getProject({
      invocation: { destination: 'gallery', destinationLocked: false, sourceId: 'workflow', sourceLocked: false },
      queue: {
        items: [
          {
            cancellable: true,
            id: 'legacy-queue-item',
            snapshot: {
              backendSubmission: { batchCount: 1, graph: { edges: [], id: 'graph', nodes: {} }, kind: 'workflow' },
              canvas: base.canvas,
              destination: 'gallery',
              filterIntermediateResults: true,
              galleryBoardId: null,
              graph: { edges: [], id: 'graph', label: 'Graph', nodes: [], updatedAt: 'now', version: 1 },
              presentation: { batchCount: 1, height: 1024, width: 1024 },
              sourceId: 'workflow',
              submittedAt: 'now',
              widgetInstances: {},
              widgetStates: {},
            },
            status: 'pending',
          },
        ],
      },
    });
    const document = serializeProjectDocument(project);

    document.invocation = {
      destination: 'gallery',
      destinationLocked: false,
      sourceId: 'project-graph',
      sourceLocked: false,
    };
    document.queue = {
      items: [
        {
          ...(project.queue.items[0] as object),
          snapshot: { ...project.queue.items[0]?.snapshot, sourceId: 'project-graph' },
        },
      ],
    };

    const deserialized = loadDocument(document);

    expect(deserialized.invocation.sourceId).toBe('workflow');
    expect(deserialized.queue.items[0]?.snapshot.sourceId).toBe('workflow');
  });
});

describe('createRecoveredDocument', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keys the fork to the original and stamps the recovery time', () => {
    const project = getProject({ name: 'My Project' });
    const { recoveredDocument, recoveredIdentity } = createRecoveredDocument(
      project,
      serializeProjectDocument(project)
    );

    expect(recoveredDocument.recoveryOf).toBe(project.id);
    expect(recoveredIdentity.id.startsWith('project-')).toBe(true);
    expect(recoveredIdentity.name).toBe('My Project (recovered)');
    expect(typeof recoveredDocument.recoveredAt).toBe('string');
    // The identity is what the reducer re-labels the live project with, so it has to agree with the
    // document the server was handed, field for field.
    expect(recoveredDocument.id).toBe(recoveredIdentity.id);
    expect(recoveredDocument.name).toBe(recoveredIdentity.name);
    expect(recoveredDocument.recoveredAt).toBe(recoveredIdentity.recoveredAt);
    expect(recoveredDocument.recoveryOf).toBe(recoveredIdentity.recoveryOf);
  });

  it('gives simultaneous recoveries distinct project ids', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    const project = getProject({ name: 'Concurrent recovery' });
    const document = serializeProjectDocument(project);

    const first = createRecoveredDocument(project, document);
    const second = createRecoveredDocument(project, document);

    expect(first.recoveredIdentity.id).not.toBe(second.recoveredIdentity.id);
    expect(first.recoveredIdentity.recoveryOf).toBe(second.recoveredIdentity.recoveryOf);
  });

  it('collapses recovery chains to the root and never stacks name suffixes', () => {
    const root = getProject({ name: 'My Project' });
    const recovery = getProject({
      id: `${root.id}-recovered-abc`,
      name: 'My Project (recovered)',
      recoveryOf: root.id,
    });

    const { recoveredDocument, recoveredIdentity } = createRecoveredDocument(
      recovery,
      serializeProjectDocument(recovery)
    );

    expect(recoveredDocument.recoveryOf).toBe(root.id);
    expect(recoveredIdentity.name).toBe('My Project (recovered)');
  });

  it('cleans up legacy stacked suffixes', () => {
    const project = getProject({ name: 'Project Name #1 (Recovered) (Recovered)' });
    const { recoveredIdentity } = createRecoveredDocument(project, serializeProjectDocument(project));

    expect(recoveredIdentity.name).toBe('Project Name #1 (recovered)');
  });
});

describe('openProject', () => {
  it('appends the hydrated project and makes it active', () => {
    const state = createInitialWorkbenchState();
    const opened = getProject({ id: 'project-from-library', name: 'Reopened' });

    const next = workbenchReducer(state, { project: opened, type: 'openProject' });

    expect(next.projects.map((project) => project.id)).toEqual([state.projects[0].id, opened.id]);
    expect(next.activeProjectId).toBe(opened.id);
  });

  it('focuses an already-open project instead of duplicating it', () => {
    const state = createInitialWorkbenchState();
    const existing = state.projects[0];
    const background = getProject({ id: 'project-background' });
    const withTwo = workbenchReducer(state, { project: background, type: 'openProject' });

    const next = workbenchReducer(withTwo, { project: existing, type: 'openProject' });

    expect(next.projects).toHaveLength(2);
    expect(next.activeProjectId).toBe(existing.id);
  });
});

describe('renameProject', () => {
  it('renames the target project and ignores blank names', () => {
    const state = createInitialWorkbenchState();
    const target = state.projects[0];

    const renamed = workbenchReducer(state, { name: '  New Name  ', projectId: target.id, type: 'renameProject' });

    expect(renamed.projects[0].name).toBe('New Name');

    const blank = workbenchReducer(renamed, { name: '   ', projectId: target.id, type: 'renameProject' });

    expect(blank.projects[0].name).toBe('New Name');
  });
});

const recoveredIdentityFor = (projectId: string, name = 'Recovered'): ProjectRecoveredIdentity => ({
  id: `${projectId}-recovered-abc`,
  name,
  recoveredAt: '2026-08-07T00:00:00.000Z',
  recoveryOf: projectId,
});

describe('reconcileProjectConflict', () => {
  it('adopts the server version and continues local work in the recovered fork', () => {
    const state = createInitialWorkbenchState();
    const original = state.projects[0];
    const serverProject = getProject({ id: original.id, name: 'Server version' });
    const recoveredIdentity = recoveredIdentityFor(original.id, 'Server version (recovered)');
    const recoveredProject = getProject({ id: recoveredIdentity.id, name: recoveredIdentity.name });
    const withActiveOriginal = { ...state, activeProjectId: original.id };

    const next = workbenchReducer(withActiveOriginal, {
      projectId: original.id,
      recoveredIdentity,
      recoveredProject,
      serverProject,
      type: 'reconcileProjectConflict',
    });

    const ids = next.projects.map((project) => project.id);

    expect(ids).toContain(original.id);
    expect(ids).toContain(recoveredIdentity.id);
    expect(next.projects.find((project) => project.id === original.id)?.name).toBe('Server version');
    // The user keeps looking at their own latest edits.
    expect(next.activeProjectId).toBe(recoveredIdentity.id);
    expect(next.notifications[0]?.title).toBe('Project recovered');
  });

  it('carries the edits made while the save was in flight, not the snapshot it was built from', () => {
    // The fork's document is serialized when the push starts. Anything edited after that is newer,
    // and is what the person is looking at — so adopting the snapshot would delete precisely the
    // work the fork exists to rescue. Staleness is not an edge case here: a save is stale exactly
    // when something landed mid-flight, which is when this reducer runs.
    const state = createInitialWorkbenchState();
    const original = state.projects[0];
    const live = workbenchReducer(
      { ...state, activeProjectId: original.id },
      { boardId: 'edited-after-the-push-started', projectId: original.id, type: 'setGalleryProjectBoardId' }
    );
    const recoveredIdentity = recoveredIdentityFor(original.id, 'Snapshot (recovered)');

    const next = workbenchReducer(live, {
      projectId: original.id,
      recoveredIdentity,
      // What the push was carrying: the document as it was before that edit landed.
      recoveredProject: getProject({ id: recoveredIdentity.id, name: 'Snapshot (recovered)' }),
      serverProject: getProject({ id: original.id, name: 'Server version' }),
      type: 'reconcileProjectConflict',
    });

    const fork = next.projects.find((project) => project.id === recoveredIdentity.id);

    expect(fork).toBeDefined();
    // The identity is the server's...
    expect(fork?.name).toBe(recoveredIdentity.name);
    expect(fork?.recoveryOf).toBe(original.id);
    expect(fork?.recoveredAt).toBe(recoveredIdentity.recoveredAt);
    // ...and the content is the live one's.
    expect(getProjectWidgetValues(fork!, 'gallery').projectBoardId).toBe('edited-after-the-push-started');
  });

  it('falls back to the pushed snapshot when no live project is left to re-label', () => {
    // A tab closed while the save was in flight. The snapshot is then the only local copy of the
    // work, so it is the right answer rather than a stale one.
    const state = createInitialWorkbenchState();
    const closedId = 'project-already-closed';
    const recoveredIdentity = recoveredIdentityFor(closedId, 'Closed (recovered)');

    const next = workbenchReducer(state, {
      projectId: closedId,
      recoveredIdentity,
      recoveredProject: getProject({ id: recoveredIdentity.id, name: 'Closed (recovered)' }),
      serverProject: getProject({ id: closedId, name: 'Server version' }),
      type: 'reconcileProjectConflict',
    });

    expect(next.projects.map((project) => project.id)).toContain(recoveredIdentity.id);
    expect(next.projects.find((project) => project.id === recoveredIdentity.id)?.name).toBe('Closed (recovered)');
  });

  it('leaves the active project alone when the conflicted project is in the background', () => {
    const state = createInitialWorkbenchState();
    const first = state.projects[0];
    const second = getProject({ id: 'project-background-test' });
    const withActiveSecond = { ...state, activeProjectId: second.id, projects: [...state.projects, second] };

    const next = workbenchReducer(withActiveSecond, {
      projectId: first.id,
      recoveredIdentity: recoveredIdentityFor(first.id),
      recoveredProject: getProject({ id: `${first.id}-recovered-abc`, name: 'Recovered' }),
      serverProject: getProject({ id: first.id, name: 'Server version' }),
      type: 'reconcileProjectConflict',
    });

    expect(next.activeProjectId).toBe(second.id);
  });
});

describe('reconcileDeletedProject', () => {
  it('keeps the live content under the fork identity', () => {
    const state = createInitialWorkbenchState();
    const original = state.projects[0];
    const live = workbenchReducer(
      { ...state, activeProjectId: original.id },
      { boardId: 'edited-after-the-push-started', projectId: original.id, type: 'setGalleryProjectBoardId' }
    );
    const recoveredIdentity = recoveredIdentityFor(original.id, 'Snapshot (recovered)');

    const next = workbenchReducer(live, {
      projectId: original.id,
      recoveredIdentity,
      recoveredProject: getProject({ id: recoveredIdentity.id, name: 'Snapshot (recovered)' }),
      type: 'reconcileDeletedProject',
    });

    // The deletion stands: the original id is gone, replaced in place by the fork.
    expect(next.projects.map((project) => project.id)).not.toContain(original.id);

    const fork = next.projects.find((project) => project.id === recoveredIdentity.id);

    expect(fork?.name).toBe(recoveredIdentity.name);
    expect(fork?.recoveryOf).toBe(original.id);
    expect(getProjectWidgetValues(fork!, 'gallery').projectBoardId).toBe('edited-after-the-push-started');
    expect(next.activeProjectId).toBe(recoveredIdentity.id);
  });
});

/**
 * SQLite owns which board belongs to which project; the document only caches it. This is the one
 * place that writes that cache, so every path — hydration, create, import, duplicate, fork —
 * agrees on what "the project's board" means.
 */
describe('applyAuthoritativeProjectBoard', () => {
  const galleryDocument = (values: Record<string, unknown>): Record<string, unknown> => ({
    widgetInstances: {
      'canvas-1': { state: { values: { projectBoardId: 'not-the-gallery' } }, typeId: 'canvas' },
      'gallery-1': { state: { values }, typeId: 'gallery' },
    },
  });

  const galleryValues = (document: Record<string, unknown>): Record<string, unknown> =>
    (
      (document.widgetInstances as Record<string, { state: { values: Record<string, unknown> } }>)['gallery-1'] as {
        state: { values: Record<string, unknown> };
      }
    ).state.values;

  it('replaces the project board and leaves a chosen destination alone', () => {
    const patched = applyAuthoritativeProjectBoard(
      galleryDocument({ galleryView: 'assets', projectBoardId: 'stale', selectedBoardId: 'chosen' }),
      'authoritative',
      { selectBoard: false }
    );

    expect(galleryValues(patched)).toEqual({
      galleryView: 'assets',
      projectBoardId: 'authoritative',
      selectedBoardId: 'chosen',
    });
  });

  it('also points a first-seen project at its board', () => {
    const patched = applyAuthoritativeProjectBoard(galleryDocument({ selectedBoardId: 'chosen' }), 'authoritative', {
      selectBoard: true,
    });

    expect(galleryValues(patched).selectedBoardId).toBe('authoritative');
  });

  it('only touches the gallery widget', () => {
    const patched = applyAuthoritativeProjectBoard(galleryDocument({}), 'authoritative', { selectBoard: true });
    const instances = patched.widgetInstances as Record<string, { state: { values: Record<string, unknown> } }>;

    expect(instances['canvas-1']!.state.values.projectBoardId).toBe('not-the-gallery');
  });

  it('patches the legacy widget-states shape too', () => {
    const patched = applyAuthoritativeProjectBoard(
      { widgetStates: { gallery: { values: { projectBoardId: 'stale' } } } },
      'authoritative',
      { selectBoard: true }
    ) as { widgetStates: { gallery: { values: Record<string, unknown> } } };

    expect(patched.widgetStates.gallery.values).toEqual({
      projectBoardId: 'authoritative',
      selectedBoardId: 'authoritative',
    });
  });

  it('invents no shape for a document with no gallery', () => {
    const document = { id: 'p1', name: 'No gallery' };

    expect(applyAuthoritativeProjectBoard(document, 'authoritative', { selectBoard: true })).toBe(document);
  });
});
