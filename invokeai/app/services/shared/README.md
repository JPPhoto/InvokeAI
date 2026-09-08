# InvokeAI Graph - Design Overview

High-level design for the graph module. Focuses on responsibilities, data flow, and how traversal works.

## 1) Purpose

Provide a typed, acyclic workflow model (**Graph**) plus a runtime scheduler (**GraphExecutionState**) that expands
iterator patterns, tracks readiness via indegree (the number of incoming edges to a node in the directed graph), and
executes nodes from class-grouped ready queues. In normal execution, runtime expansion happens in a separate execution graph
instead of mutating the source graph. Ordinary static DAGs and legacy-shaped `If` graphs use the opaque `ExecutionPlan`
and deterministic `ExecutionScheduler` in `execution_engine/scheduler.py`. For a fresh generic `If`, the dedicated
`_IfActivationCompiler` produces opaque, frame-local activation dependencies; `_GenericGraphSchedulerAdapter` registers
and consumes those dependencies through the opaque plan, then rejects unselected prepared nodes through generic scheduler
discard. It does not consult `_IfBranchScheduler` topology or call its prune/skip methods, and it does not delete
execution edges. The forced compatibility `_ExecutionScheduler` path retains legacy `If` topology lowering, input-edge
pruning, and skip behavior for compatibility snapshots. This is an ownership seam, not final removal of all legacy
topology.
Direct `Iterate`/`Collect` graphs that do not contain `If`, `For`, `ForReturn`, or saved-workflow control flow also use
the generic adapter. Its adapter-level readiness predicate waits for canonical Iterate streams to close, and generic
completion mirrors each Iterate result into that ledger before releasing `Collect`; materialization still owns copy
expansion, iteration paths, grouping, and explicit empty-stream closure. Mixed control-flow shapes remain on the legacy
compatibility scheduler until their differential gates are complete.
A fresh graph with exactly one static, non-empty `For`/`ForReturn` pair and ordinary body nodes also uses the generic
adapter. It projects readiness and invokes the graph-state continuation boundary, which selects the next iteration or
finalizes the aggregate without exposing a successor node ID to the generic scheduler. The materializer still owns
execution-node copies, input hydration, iteration paths, and body expansion. Empty or input-driven collections,
nested or multiple loops, mixed control flow, and saved-workflow calls remain on the compatibility scheduler until
their own differential gates are complete.
The runtime also exposes an additive execution-engine seam: frame-scoped gates, ordered streams, continuations, and
authorized child-dependency records are stored in
`invokeai.app.services.shared.execution_engine`; legacy graph and queue behavior is retained behind adapters while
those records become authoritative one behavior at a time.

This refactoring is backend-only. No code under `invokeai/frontend/...` may be changed, and the existing frontend/backend
external interface remains frozen; generated schemas may change only for additive optional runtime response metadata.

## 2) Major Data Types

### EdgeConnection

- Fields: `node_id: str`, `field: str`.
- Hashable; printed as `node.field` for readable diagnostics.

### Edge

- Fields: `source: EdgeConnection`, `destination: EdgeConnection`.
- One directed connection from a specific output port to a specific input port.

### AnyInvocation / AnyInvocationOutput

- Pydantic wrappers that carry concrete invocation models and outputs.
- No registry logic in this file; they are permissive containers for heterogeneous nodes.

### IterateInvocation / CollectInvocation

- Control nodes used by validation and execution:

  - **IterateInvocation**: input `collection`, outputs include `item` (and index/total).
  - **CollectInvocation**: many `item` inputs aggregated to one `collection` output.

### Internal execution-engine records

- `ExecutionFrame`, `ActivationGate`, `StreamBuffer`, and `ContinuationRecord` carry typed runtime identity and
  lifecycle state without changing author-time graph models. Their private registries are rebuilt from persisted graph
  results, tokens, and workflow-call state after rehydration.
- `ChildExecutionCapability`, `ChildExecutionRecord`, and `ChildDependencyRecord` validate authorized parent/child
  relationships, resource limits, ordered all-of aggregation, failure, cancellation, and idempotent completion.
- `ExecutionPlan` stores opaque execution-node IDs, class names, prerequisite IDs, frame values, activation-dependency
  records, and stable insertion order. `ExecutionScheduler` owns generic readiness, opaque readiness predicates,
  intentional skips, deterministic ordering, completion, and durable plan rehydration. It does not import invocation
  classes and cannot alter author-time graph or frontend contracts.
- `ExecutionEngineRuntime` owns these records for one graph state. It is private runtime machinery; it is not a new
  frontend node, input handle, or public workflow contract.

## 3) Graph (author-time model)

A container for declared nodes and edges. Does **not** perform iteration expansion.

### 3.1 Data

- `nodes: dict[str, AnyInvocation]` - key must equal `node.id`.
- `edges: list[Edge]` - zero or more.
- Utility: `_get_input_edges(node_id, field?)`, `_get_output_edges(node_id, field?)` These use cached per-node
  adjacency indexes rebuilt when the edge list changes.

### 3.2 Validation (`validate_self`)

Runs a sequence of checks:

1. **Node ID uniqueness** No duplicate IDs; map key equals `node.id`.

1. **Endpoint existence** Source and destination node IDs must exist.

1. **Port existence** Input ports must exist on the node class; output ports on the node's output model.

1. **DAG constraint** Build a *flat* `DiGraph` (no runtime expansion) and assert acyclicity.

1. **Type compatibility** `get_output_field_type` vs `get_input_field_type` and `are_connection_types_compatible`.

   Special case:

   - `call_saved_workflow` currently accepts dynamic destination handles of the form
     `saved_workflow_input::{childNodeId}::{childFieldName}` as part of its temporary call-boundary contract.
   - Those handles are allowed through graph validation even though they are not static Python model fields on the
     invocation class.
   - Runtime later validates them against the selected child workflow's exposed callable interface before applying
     values to the child graph.
   - The editor preserves dynamic caller values only while the exposed field type remains compatible; type drift at the
     same child node/field path resets to the selected workflow's current initial value.
   - Saved-workflow picker search is server-backed so large workflow libraries do not require scrolling every page
     before selecting a workflow by name.

1. **Iterator / collector structure** Enforce special rules:

   - Iterator's input must be `collection`; its outgoing edges use `item`.
   - Collector accepts many `item` inputs; outputs a single `collection`.
   - Edge fan-in to a non-collector input is rejected.

### 3.3 Edge admission (`_validate_edge`)

Checks a single prospective edge before insertion:

- Endpoints/ports exist.
- Destination port is not already occupied unless it's a collector `item`.
- Adding the edge to the flat DAG must keep it acyclic.
- Iterator/collector constraints re-checked when the edge creates relevant patterns.

### 3.4 Topology utilities

- `nx_graph()` - DiGraph of declared nodes and edges.
- `nx_graph_flat()` - "flattened" DAG (still author-time; no runtime copies). Used in validation and in `_prepare()`
  during execution planning.

### 3.5 Mutation helpers

- `add_node`, `update_node` (preserve edges, rewrite endpoints if id changes), `delete_node`.
- `add_edge`, `delete_edge` (with validation).

## 4) GraphExecutionState (runtime)

Holds the state for a single run. Keeps the source graph intact and materializes a separate execution graph.
`GraphExecutionState` is still the public runtime entry point, but most execution behavior is now delegated to a small
set of internal helper classes. For ordinary static DAGs and legacy-shaped `If` graphs, readiness and completion are
projected through the generic `ExecutionPlan`/`ExecutionScheduler` adapter. Direct `Iterate`/`Collect` graphs without
other control-flow nodes also use that adapter: its readiness predicate waits for canonical streams to close and its
completion mirrors Iterate outputs into the stream ledger. A fresh graph with one static, non-empty flat
`For`/`ForReturn` pair also uses the adapter for readiness and continuation transitions; graph state owns the
invocation-specific continuation boundary while the generic scheduler remains opaque. Empty or input-driven `For`
collections, nested or multiple loops, saved-workflow calls, and mixed control-flow shapes continue to use the legacy
compatibility scheduler until their differential coverage is complete. `Iterate` also records non-empty item streams through the generic effect ledger;
the materializer remains authoritative for expansion, iteration paths, collector grouping, and
empty-source compatibility handling. Direct `Collect.item` consumers now use the closed stream ledger when available;
the full Iterate/Collect compatibility matrix covers empty, nested, fan-in, partial rehydration, failure, cancellation,
and retry behavior. This evidence does not remove the materializer or queue adapters.

The source graph is treated as stable during normal execution, but the runtime object still exposes guarded graph
mutation helpers. Those helpers reject changes once the affected nodes have already been prepared or executed.

### 4.1 Data

- `graph: Graph` - source graph for the run; treated as stable during normal execution.
- `execution_graph: Graph` - materialized runtime nodes/edges. This is mutable runtime state, not an immutable audit
  log. Forced compatibility `_ExecutionScheduler` lazy `If` pruning may remove unselected input edges during execution,
  so persisted failed/completed session snapshots can contain a structurally pruned execution graph. Generic
  legacy-shaped `If` scheduling retires unselected prepared nodes without deleting execution edges. Retry paths rebuild
  from `graph`, not from a previously persisted `execution_graph`.
- `executed: set[str]`, `executed_history: list[str]`.
- `results: dict[str, AnyInvocationOutput]`, `errors: dict[str, str]`.
- `prepared_source_mapping: dict[str, str]` - exec id -> source id.
- `source_prepared_mapping: dict[str, set[str]]` - source id -> exec ids.
- `indegree: dict[str, int]` - unmet inputs per exec node.
- Workflow-call runtime state:
  - `workflow_call_stack` - active parent call frames.
  - `workflow_call_history` - completed or failed workflow-call relationships observed by this execution state.
  - `workflow_call_parent` - parent workflow-call relationship metadata when this execution state is a child session.
  - `waiting_workflow_call` - the call frame currently suspending this execution state, if any.
  - `waiting_workflow_call_execution` - the active parent/child workflow-call relationship record for the waiting call.
  - `waiting_workflow_call_child_session` - attached child execution state for the waiting workflow call, if any.
  - `max_workflow_call_depth` - runtime guardrail for nested or recursive workflow calls.
- Prepared exec metadata caches:
  - source node id
  - iteration path
  - runtime state such as pending, ready, executed, or skipped
- `execution_refs: dict[str, ExecutionReference]` - stable references for prepared execution nodes, including their
  source node and execution frame.
- `execution_tokens: dict[str, ExecutionToken]` - output tokens produced by applied execution results.
- `execution_effects: dict[str, list[Any]]` - JSON-safe effects accepted for each execution reference.
- **Ready queues grouped by class** (private projection): `_ready_queues: dict[class_name, deque[str]]` and
  `_active_class: Optional[str]`. Ordinary static DAGs and legacy-shaped `If` graphs derive readiness from the generic
  scheduler; the `If` adapter stores frame-local activation dependencies whose private gate state plus persisted token
  checks control generic branch readiness. Supported static flat `For` graphs use the generic adapter for readiness and
  continuation projection; empty/input-driven, nested/multiple-loop, mixed, and saved-workflow graphs retain the legacy
  scheduler. Optional
  `ready_order: list[str]` prioritizes classes. Queues are rebuilt from persisted execution state when a session is
  deserialized.

### 4.2 Core methods

- `next()` Returns the next ready exec node. If none are ready, it asks the materializer to expand more source nodes and
  then retries. If the execution state is paused on a workflow call boundary, it returns `None` without scheduling more
  work. Before returning a node, the runtime helper deep-copies inbound values into the node fields.
- `complete(node_id, output)` Records the result, marks the exec node executed, marks the source node executed once all
  of its prepared exec copies are done, then decrements downstream indegrees and enqueues newly ready nodes.
- `apply(execution_ref, output, effects)` validates a result against its prepared node and frame, then applies the
  result through the existing scheduler while recording references, output/effect tokens, and JSON-safe effects. The
  transition and ledger update are atomic. `complete()` remains the compatibility boundary used by the scheduler.

#### Current execution-effects seam

`InvocationContext` exposes a restricted `execution` facade and the underlying `execution_effects` recorder. The
existing invocation output contract remains unchanged. The session runner calls
`invoke_internal_with_effects()` and passes its `InvocationRunResult` to `GraphExecutionState.apply()`.

The recorder dispatches `emit` and `close_stream` by default. A runner may opt an invocation into lifecycle recording
with an engine-issued `ChildExecutionCapability`; this records validated `spawn_execution`, `await`, and `fail` effects
and returns a capability-bound child handle. Calls without that capability remain rejected. Mutation effects and queue
row creation remain owned by graph/queue adapters, so an invocation cannot mutate either directly. A cache hit never
suppresses effects: effect-enabled invocations bypass the ordinary output cache for that dispatch.

`IfInvocation` is the first control-flow invocation to declare an activation-effect contract. It emits one
frame-scoped activation token for the selected `true_input` or `false_input` port; `GraphExecutionState` validates that
port against the producing invocation's declared activation fields and persists it without creating a data stream. On
rehydration, every activation token is bound to a currently prepared owner and its derived execution reference; its
declared port, value, canonical token id, mapping key, and known frame fields must match. Unknown extra frame metadata
remains forward-compatible.
For a fresh generic `If`, `_IfActivationCompiler` puts opaque, frame-local activation-dependency records on each
branch-local plan node. `_GenericGraphSchedulerAdapter` consumes those records through the opaque plan: its readiness
callback accepts a node only when the required private `ActivationGate` runtime state is resolved and a matching
persisted activation token is present for its frame, while rejected dependencies cause generic scheduler discard. This
path does not consult `_IfBranchScheduler` topology, call `_IfBranchScheduler._prune_unselected_if_inputs` or
`_IfBranchScheduler.mark_exec_node_skipped`, or delete execution edges. The forced compatibility `_ExecutionScheduler`
path still uses `_IfBranchScheduler` for legacy branch topology, input-edge pruning, and skip behavior. This is an
ownership seam, not final removal of all legacy topology. `apply()`
validates and persists the invocation-emitted effect afterward, replacing the compatibility token by stable identity.
Activation effects are excluded from data-stream handling. `IterateInvocation` is the first stream-producing
control-flow invocation on this seam: each non-empty prepared copy emits one ordered `item` effect with its iteration
index, and the final copy emits one `close_stream` effect. Direct Iterate/Collect-only graphs now run through the
generic scheduler adapter; its completion maps these results/effects to the existing frame-scoped iteration-stream
identity, so legacy output mirroring is idempotent. The materializer still creates
prepared copies, derives iteration paths, groups collector inputs, and records the explicit close for an empty source.
For a direct `Iterate.item` edge, the scheduler defers `CollectInvocation` while its canonical stream is open, and
runtime hydration consumes the closed stream in sequence order. If no stream exists, hydration retains the legacy
materialized-result fallback needed by older snapshots. This is not yet token-authoritative downstream topology or full
`Collect` migration: the materializer still owns copy expansion, iteration paths, collector grouping, collection-input
hydration, and empty-source closure; no author-time activation ports or literal successor IDs are introduced.

For a fresh graph with one static, non-empty flat `For`/`ForReturn` pair, the same adapter now projects ordinary
readiness and calls the graph-state continuation boundary after each `ForReturn`. That boundary carries returned state,
honors `continue_condition`, creates the next prepared iteration when needed, and finalizes `output_collection` and
`final_state`. The generic scheduler receives only opaque node IDs and dependencies; it never receives a literal next
node ID. Empty/input-driven collections and nested, multiple, or mixed loop shapes remain compatibility-owned.

`ExecutionFrame` identifies the owning state, loop iteration path, and workflow-call depth. `ExecutionReference`
identifies one prepared execution node and its frame. `ExecutionToken` records an output port, value, frame, token
kind, and optional sequence. `loop_linkage` remains association metadata and never becomes a data token. This ledger is
currently additive. Ordinary static-DAG and legacy-shaped `If` readiness comes from the generic scheduler through a
compatibility projection; the activation token is authoritative for generic `If` branch readiness. Supported static flat
`For` readiness and continuation transitions also use the generic adapter, while materialization and type-specific
control paths remain authoritative for unsupported loop shapes and workflow-call graphs. A future
migration may make token-built topology and the remaining control-flow paths authoritative only after compatibility is proven.

The generic scheduler is an in-memory graph-state component only. It does not
create, update, retry, cancel, delete, or recover `SessionQueueItem` rows and
does not own queue statuses or events. A graph containing a saved-workflow call
therefore stays on the legacy scheduler and the dedicated workflow-call queue
adapters.

Target migration contract: control-flow nodes remain concrete invocation
subclasses that declare frame-scoped data, activation, stream-closure, child,
and terminal effects. The generic scheduler selects nodes from required
effects for the current frame; it never receives a literal successor-node ID.
Current implementation is narrower: `IfInvocation` and non-empty
`IterateInvocation` use the effect recorder for activation and stream effects.
Direct `Iterate`/`Collect`-only graphs use the generic scheduler adapter for
readiness and completion, while the materializer still expands copies and
groups paths. `For`, `ForReturn`, workflow-call invocations, and mixed
control-flow graphs remain on compatibility paths. `ForInvocation` and
`ForReturnInvocation` now declare one validated, frame-scoped `continuation`
effect per prepared invocation: `For` starts the `for` continuation with its
iteration/state payload, and `ForReturn` completes it with output/state/
continue-decision data. Session-built recorders bind the effect reference to
the graph-state ID, durable frame ID, iteration path, and workflow-call depth;
graph-state validation rejects a stale or cross-frame continuation before
mutation. Graph state persists these effects under the invocation reference
and excludes `loop_linkage` from token data. This is the
invocation/effect ownership seam only: the legacy scheduler still resolves
linkage, creates the next prepared iteration, aggregates outputs, finalizes
the loop, and owns empty/nested/mixed materialization. Generic `For`
scheduling is not claimed yet. For
`If`, generic readiness consumes opaque frame-local plan dependencies and requires
both matching private `ActivationGate` runtime state and a persisted activation token;
generic resolution retires unselected prepared nodes through scheduler discard. The forced compatibility
`_ExecutionScheduler` path retains `_IfBranchScheduler` topology, edge-prune, and skip behavior.
This is not token-built successor topology. Loop and workflow-call adapters
still own materialization and durable queue lifecycle. Those owners may be
removed only after differential tests cover fresh, partially completed,
rehydrated, failed, canceled, and retried sessions. The frontend boundary
remains frozen: this refactoring does not modify `invokeai/frontend/...` or
existing web/webv2 interactions.

The test-only differential harness at
`tests/app/services/shared/test_execution_engine_differential.py` compares
generic and forced-compatibility scheduling for static DAGs and a constructed
mixed/nested `If` graph. Its fixture corpus covers fresh completion, true/false
branch selection, nested branch isolation, partial checkpoints, versioned
rehydration, in-flight claim replay, activation-token persistence, and injected
failure. The `If` comparison includes strict source-level results, executed
history, errors, terminal state, and normalized indegrees; compatibility skip
propagation must not leave stale downstream indegrees. Both scheduler adapters
expose the same skip transition; the legacy path releases downstream indegrees
without trying to hydrate inputs from the skipped node. It intentionally does
not claim durable persistence of the generic scheduler's private claim set, nor
does it cover loop or workflow-call ownership migration. Real queue/processor
coverage in `tests/app/services/session_processor/test_if_processor_sqlite.py`
also exercises true and false `If` selection, cancellation before and after
resolution, retry from a canceled SQLite item, fresh execution identities, and
selected-only completion. Stale identity and legacy loop-frame rehydration are
covered separately by the differential and graph-state tests.

Workflow-call note:

- `GraphExecutionState` can represent a paused parent execution plus an attached child execution state, but it does not
  itself orchestrate child execution.
- In the current implementation, `DefaultSessionRunner.run_node()` establishes the workflow call boundary and attaches
  the child execution state, while `WorkflowCallCoordinator` handles call-specific setup and
  `WorkflowCallQueueLifecycle` later resumes or fails the parent based on that child queue row's outcome.
- Child `SessionQueueItem` rows created by the coordinator now carry explicit relationship metadata such as
  `workflow_call_id`, `parent_item_id`, `parent_session_id`, `root_item_id`, and `workflow_call_depth`, even though the
  higher-level scheduler semantics are still evolving.
- The `session_queue` schema now has matching columns for those relationship fields, and parent queue items can enter a
  `waiting` status while suspended on a child workflow execution.
- Queue lifecycle semantics are now partially defined for workflow-call chains:
  - child success resumes the waiting parent
  - multiple child queue rows may complete under one waiting parent when the called workflow contains direct batch
    nodes; the parent resumes only after all expected child rows complete
  - child failure fails the waiting parent and can cascade upward through ancestors
  - failing child rows cancel their remaining workflow-call siblings before the parent is failed
  - cancelation is chain-aware across parents and children, including nested descendants of batched siblings
  - "all except current" queue actions preserve the active current item plus its workflow-call chain, while still
    canceling or deleting unrelated waiting chains
  - startup recovery cancels interrupted `in_progress` or `waiting` workflow-call chains, including pending descendants
  - deleting a workflow-call queue row currently deletes the whole parent/child chain rather than leaving orphaned rows
    behind
  - retry is root-oriented and should not be exposed directly on child queue rows in the UI
  - child queue-row creation is cleaned up on boundary-setup failure and child fan-out is bounded by remaining queue
    capacity
  - child workflows that mix supported batch nodes with unrelated generator nodes are rejected for now
- The generic `ChildDependencyRecord` adapter now validates the same waiting parent, ordered children, capability
  identity, all-of aggregation, resource limits, and terminal transitions alongside this workflow-call lifecycle.
  Existing queue fields, statuses, cancellation, retry, and event behavior remain authoritative; queue-row creation and
  recovery are not silently delegated to an in-memory record.

### 4.3 Runtime helper classes

`GraphExecutionState` now delegates most runtime behavior to internal helpers:

- `_PreparedExecRegistry` Owns the relationship between source graph nodes and prepared execution graph nodes, plus
  cached metadata such as iteration path and runtime state.
- `_ExecutionMaterializer` Expands source graph nodes into concrete execution graph nodes when the scheduler runs out of
  ready work. It owns iterator expansion, collector grouping, prepared-parent selection, and creation of execution-graph
  edges. When matching prepared parents for a downstream exec node, skipped prepared exec nodes are ignored and cannot
  be selected as live inputs.
- `_IfActivationCompiler` Compiles legacy-shaped `If` branch membership into opaque, frame-local activation dependency
  records for the generic plan. It is separate from both schedulers and does not own execution-graph topology changes.
- `_GenericGraphSchedulerAdapter` Projects the generic `ExecutionPlan`/`ExecutionScheduler` into the existing state
  fields for ordinary static DAGs and legacy-shaped `If` graphs; the generic scheduler owns opaque readiness,
  intentional discards, indegree transitions, deterministic ordering, claimed work, and completion. The adapter registers
  the compiler's activation dependencies, checks private gate state plus persisted activation tokens, and rejects
  unselected prepared nodes through generic scheduler discard. Fresh generic `If` scheduling does not call
  `_IfBranchScheduler` topology, prune, or skip methods and does not delete execution edges.
- `_ExecutionScheduler` Owns materialized-graph indegree transitions, class-grouped ready queues, downstream release,
  control-flow continuation scheduling, and forced-compatibility `If` topology for graphs that still require lowering.
- `_ExecutionRuntime` Owns iteration-path lookup, collect input ordering, and input hydration for prepared exec nodes.
- `_IfBranchScheduler` Computes legacy `If` topology, defers branch-local work until the condition is known, then
  lowers the decision to private frame-scoped `ActivationGate` runtime state and a persisted internal activation token,
  releases the selected branch, prunes unselected input edges, and marks unselected branch-local nodes skipped. Used
  only by forced compatibility `_ExecutionScheduler`; it remains available for compatibility snapshots. Its retained
  topology/pruning/skip ownership is an intentional seam, not a final removal of legacy topology.
- `ExecutionEngineRuntime` Owns the typed gate, stream, and continuation records used by compatibility adapters. The
  canonical stream for a prepared `IterateInvocation` is keyed by the source iterator and its parent iteration path;
  its item/close effects and legacy output mirroring update the same idempotent buffer. Direct `CollectInvocation.item`
  edges consume a closed canonical stream when available and otherwise use the legacy snapshot fallback.

`GraphExecutionState.model_post_init()` rehydrates private runtime helpers and caches after normal construction or a
JSON/model round trip. Rehydration reconstructs prepared exec metadata, cached iteration paths, private resolved `If`
gate state from condition results or persisted activation tokens, non-empty iteration streams from durable effects and
legacy Iterate results, explicit empty-source closes, For continuation identity, and ready queues from
`execution_graph`, `indegree`, `executed`, and `results`. Activation tokens persist; private `ActivationGate` runtime
state does not and is reconstructed from condition results or persisted activation tokens. Before token validation,
missing legacy iteration-path metadata is rebuilt from the prepared execution graph. Persisted activation identity is
then validated fail-closed
against prepared owners, derived references, declared activation fields, canonical ids, and known frame fields; extra
frame metadata is retained. Persisted execution references, tokens, and effects remain part of serialized state; private
helper objects do not. Queue snapshots carry an additive execution-state version marker and use version-aware loader;
legacy unmarked snapshots are treated as version 0, while unreadable snapshots are quarantined by queue service.

### 4.4 Preparation (`_prepare()`)

- Build a flat DAG from the **source** graph.

- Choose the **next source node** in topological order that:

  1. has not been prepared,
  1. if it is an iterator, *its inputs are already executed*,
  1. it has *no unexecuted iterator ancestors*.

- If the node is a **CollectInvocation**: group prepared parent exec nodes by iteration path and create one collector
  exec node per group. A collector collapses the immediate iterator that feeds its `item` input, but preserves enclosing
  iterator paths. This lets a shape such as `outer_iter -> inner_collection -> inner_iter -> collect -> consumer`
  produce one collected result per outer iteration instead of mixing all inner items into one global collection.
  Incoming `collection` inputs are treated as ancestor groups and are copied into each matching descendant item group.

- Otherwise: compute all combinations of prepared iterator ancestors. For each combination, choose the prepared parent
  for each upstream by matching iterator ancestry, then create **one** exec node. If a node no longer has visible
  iterator ancestors because the source path crosses a collector, prepared parent iteration paths are still used to
  materialize one downstream exec node for each preserved collector path.

- For each new exec node:

  - Deep-copy the source node; assign a fresh ID (and `index` for iterators).
  - Cache the preserved iteration path when the materializer has one, such as for grouped collectors.
  - Wire edges from chosen prepared parents.
  - Set `indegree = number of unmet inputs` (i.e., parents not yet executed). The generic scheduler mirrors this into
    its opaque plan for ordinary static DAGs, legacy-shaped `If` graphs, and
    direct `Iterate`/`Collect`-only graphs.
  - Try to resolve any `If`-specific scheduling state.
  - If the node is ready and not deferred by an unresolved `If`, enqueue it into its class queue.

### 4.5 Readiness and class ordering

- `_enqueue_if_ready(nid)` applies generic readiness: `indegree == 0`, not executed or claimed, and, for an `If`
  branch-local node, both matching private `ActivationGate` runtime state and a persisted activation token are present
  for its frame. The generic adapter derives opaque dependencies and retires rejected nodes through generic scheduler
  discard. For direct `Collect` nodes, the adapter also requires available Iterate streams to be closed. Forced
  compatibility uses `_IfBranchScheduler` topology and skip handling.
- `_get_next_node()` uses the generic scheduler for ordinary static DAGs and legacy-shaped `If` graphs, projecting its
  deterministic class/frame order into the compatibility queues. Forced compatibility `If` topology remains responsible
  for branch-local lowering, input-edge pruning, and skips. Loop and saved-workflow control-flow graphs use `_active_class`
  and the legacy class queues. No batch-size or fairness cap is currently implemented.

#### 4.5.1 Indegree (what it is and how it's used)

**Indegree** is the number of incoming edges to a node in the execution graph that are still unmet. In this engine:

- For every materialized exec node, `indegree[node]` equals the count of its prerequisite parents that have **not**
  finished yet.
- A node is eligible for enqueue when `indegree[node] == 0`, it has not executed, and it is not deferred by an
  unresolved `If`.
- When a node completes, the active scheduler decrements `indegree[child]` for each outgoing edge. Any child that
  reaches 0 is enqueued. The generic plan preserves repeated edges as repeated prerequisites, matching execution-graph
  indegree semantics.

Example: edges `A->C`, `B->C`, `C->D`. Start: `A:0, B:0, C:2, D:1`. Run `A` -> `C:1`. Run `B` -> `C:0` -> enqueue `C`.
Run `C` -> `D:0` -> enqueue `D`. Run `D` -> done.

### 4.6 Input hydration (`_prepare_inputs()`)

- For **CollectInvocation**: merge incoming `collection` values first, then gather `item` inputs. A direct
  `Iterate.item` edge uses its closed canonical stream ledger, preserving stream sequence order; an open stream is not
  hydrated, and a missing stream falls back to the materialized source result for legacy snapshots. Materialized inputs
  are still grouped by iteration path, so hydration only sees inputs belonging to that collector exec node.
- For **IfInvocation**: hydrate only `condition` and the selected branch input. As a defensive guard against
  inconsistent runtime or deserialized session state, the runtime raises if the selected input edge points at an exec
  node with no stored runtime output. In normal scheduling this path should be unreachable.
- For all others: deep-copy each incoming edge's value into the destination field. This prevents cross-node mutation
  through shared references.

### 4.7 Lazy `If` semantics

`IfInvocation` now acts as a lazy branch boundary rather than a simple value multiplexer.

- The `condition` input must resolve first.
- Nodes that are exclusive to the true or false branch can remain deferred even when their indegree is zero.
- In generic legacy-shaped `If` scheduling, once the prepared `If` node resolves its condition, the selected branch is
  released, unselected prepared nodes are retired through generic scheduler discard, and branch-exclusive ancestors of
  the unselected branch are never executed. This path does not call `_IfBranchScheduler._prune_unselected_if_inputs`,
  `_IfBranchScheduler.mark_exec_node_skipped`, or delete execution edges.
- In forced compatibility `_ExecutionScheduler` scheduling, `_IfBranchScheduler` retains legacy behavior: selected work
  is released, unselected work is marked skipped, unselected input edges on the prepared `If` exec node are pruned, and
  branch-exclusive ancestors of the unselected branch are never executed.
- The SQLite queue/processor path has evidence for cancellation before and after `If` resolution and retry from each
  boundary for both condition polarities. A canceled attempt keeps its activation ledger and cannot resume; retry starts
  a fresh state and must emit a fresh matching activation token before selected-only completion.
- Retired or skipped branch-local exec nodes may still be treated as executed for scheduling purposes, but they do not
  create entries in `results`.
- Shared ancestors still execute if they are required by the selected branch or by any other live path in the graph.

This behavior is implemented in the runtime scheduler, not in the invocation body itself.

## 5) Traversal Summary

1. Author builds a valid **Graph**.

1. Create **GraphExecutionState** with that graph.

1. Loop:

   - `node = state.next()` -> may trigger `_prepare()` expansion.
   - Execute node externally -> `run_result`.
   - `state.apply(execution_ref, run_result)` -> updates indegrees, `If` state, ready queues, and the execution ledger.

1. Finish when `next()` returns `None` and the execution state is not paused waiting on a workflow call boundary.

In normal execution, all runtime expansion occurs in `execution_graph` with traceability back to source nodes.

## 6) Invariants

- Source **Graph** remains a DAG and type-consistent.
- `execution_graph` remains a DAG.
- Nodes are enqueued only when `indegree == 0` and they are not deferred by an unresolved `If`; generic `If`
  branch-local readiness additionally requires matching private `ActivationGate` runtime state and a persisted
  activation token.
- `results` and `errors` are keyed by **exec node id**.
- Applied execution references are unique to one prepared node and frame; their output/effect records are JSON-safe.
- Output and `emit` effects produce frame-aware tokens. `close_stream` produces a `stream_end` token. Association fields
  such as `loop_linkage` are never stored as data tokens.
- A non-empty `IterateInvocation` emits one `item` effect per prepared copy,
  with a contiguous sequence beginning at zero, and closes its canonical
  source/parent-path stream on the final copy. Exact output mirroring is
  idempotent; empty-source closure remains a materializer compatibility
  operation.
- Collectors wait for available direct Iterate streams to close, then aggregate
  their ledger values in stream order and may also merge incoming `collection`
  inputs during runtime hydration. A missing ledger remains a legacy snapshot
  fallback; stale legacy Iterate result mirrors do not override durable effects.
  Collectors nested under iterators preserve enclosing iteration paths, so downstream consumers materialize per enclosing
  iteration instead of receiving a mixed collection from unrelated outer iterations.
- Branch-exclusive nodes behind an unselected `If` branch are skipped, not failed.

## 7) Extensibility

- **New node types**: implement as Pydantic models with typed fields and outputs. Register per your invocation system;
  this file accepts them as `AnyInvocation`.
- **Scheduling policy**: adjust `ready_order` to prioritize class queues. A batch-size or fairness cap is not currently
  implemented.
- **Dynamic behaviors**: effect-enabled invocations may record frame-scoped stream, activation, and authorized child
  lifecycle intent. `GraphExecutionState.apply()` remains the transactional graph boundary and rejects mutation or
  queue effects unless a matching adapter owns their application.
- **Workflow call boundaries**: `GraphExecutionState` can suspend a parent execution state on a workflow call, attach a
  child execution state, and later resume the parent without mutating the source graph.

Current limitation:

- Child workflow executions are represented as first-class queue items. Parent resume/failure remains handled by the
  dedicated workflow-call queue lifecycle component; `ChildDependencyRecord` is the generic identity and aggregation
  seam, not a replacement for durable queue operations.
- Called workflows currently require exactly one valid `workflow_return` node to be callable at all.
- A single `workflow_return_value.value` may connect directly to `workflow_return.values`; multiple named return members
  should be collected and then connected to `workflow_return.values`.
- Direct batch-special child workflows are now supported by expanding them into multiple child queue rows.
- Batch outputs may feed a named `workflow_return_value.value` directly. Parent resume aggregates named return maps as
  `values: dict[str, list[Any]]`, and all rows in one batch call must return the same key set.
- Generator-backed batch child workflows are now supported when the batch node is fed directly by a supported integer,
  float, string, or image generator.
- Connected batch child inputs produced by ordinary non-generator upstream nodes are still rejected before any child
  queue row is created.
- Workflow library API responses now include compatibility metadata so the frontend can disable unsupported callees
  before execution rather than failing only at runtime.
- Workflow library list compatibility uses structural generator-backed batch validation so list and picker rendering do
  not enumerate every image in board-backed generators; workflow detail and runtime execution still resolve real
  generator values.
- Batch-specific compatibility failures, including multiple connected inputs to one batch field, are reported as
  `unsupported_batch_input` rather than generic unsupported-node failures.
- The workflow library list also surfaces that metadata as an informational unsupported state; workflows remain
  viewable/editable even when they are not currently callable by `call_saved_workflow`.
- Single-user workflow CRUD socket events emit only to the admin room because every single-user socket already joins
  that room, avoiding duplicate delivery through both `user:system` and `admin`.

## 8) Error Model (selected)

- `DuplicateNodeIdError`, `NodeAlreadyInGraphError`
- `NodeNotFoundError`, `NodeFieldNotFoundError`
- `InvalidEdgeError`, `CyclicalGraphError`
- `NodeInputError` (raised when preparing inputs for execution)

Messages favor short, precise diagnostics (node id, field, and failing condition).

## 9) Rationale

- **Two-graph approach** isolates authoring from execution expansion and keeps validation simple.
- **Indegree + queues** gives O(1) readiness decisions with clear class-ordering semantics.
- **Iterator/collector separation** keeps fan-out/fan-in explicit and testable.
- **Deep-copy hydration** avoids incidental aliasing bugs between nodes.
