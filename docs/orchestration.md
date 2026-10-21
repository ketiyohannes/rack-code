# Agent orchestra

Status: implemented 2026-10-21. Rack owns the workflow definition and scheduler;
workers use the existing execution service and runtime adapters. This does not
invoke Claude's native Workflow tool or Codex's native subagent machinery.

## Create and apply

Open **Orchestration** from the right workbench launcher or **+** menu. Create a
workflow to open Workflow studio, with a flow canvas and a step inspector.

- Start with Feature development, Parallel review, or Research & compare, then
  change the title, description and steps. Templates are editable drafts, saved
  only when you choose Save workflow.
- Select a card to edit its name, agent instructions, model and reasoning effort.
  Coordinator defaults to the session model; workers default to the coordinator.
  Any available model in the connected runtime catalogs can be assigned.
- Drag a step by its handle to reorder, or use its Up/Down buttons. Reordering
  changes execution order. Approval cards wait for explicit approval.
- Add individual agents, approval points, or Run together groups of two to four
  read-only agents. Editing work is sequential in this version; no automatic
  branch integration is implied.
- A review can return to an earlier work step, with one to five revision rounds.
  Review agents must return a final `VERDICT: APPROVED` or
  `VERDICT: CHANGES_REQUESTED` line. Missing verdicts and exhausted limits stop
  the workflow for the user to inspect.
- Describe it to build it makes a real read-only model request using the visible
  Workflow drafting model picker. It initially selects the coordinator, a
  favorite model, or the first discovered model. It requires an
  open conversation and connected model. Its returned JSON is validated as data;
  no generated code is executed. Drafting consumes provider usage.

Saved workflows are available across projects. Apply one to a conversation using
its library card or the session workflow picker. A label above the composer shows
which workflow will handle the next message. Direct conversation removes the
binding. Hiding/disabling the surface does not cancel an active workflow.

Plan mode and manually selected session skills are not combined with orchestra
runs: workers follow their saved instructions. Deselect session skills before
starting. Session attachments are resolved by the host and their quoted file
references are passed to workers with the task. Session permission mode bounds
workers; read-only workers and the final coordinator use read-only execution.

## Supervise a run

The sidebar shows stage progress, every actual worker execution, model assignment
and recent tool activity. Select a worker to inspect instructions, activity and
results, or stop that agent. Worker tool approvals and questions appear above the
main composer, using the existing host-owned brokers. Workflow approval points
have separate Approve & continue actions in the panel and composer.

Pause lets current workers finish and prevents new stages from starting. Resume
continues scheduling. Stop requests cancellation of active workers and prevents
further scheduling. A failed parallel worker cancels its siblings. A stopped or
failed worker does not count as a successful stage. Workers release native
process resources on settlement; their execution journals and results remain.

The main chat displays one workflow turn with agent progress and the coordinator's
final response. Timeline also has an Agent activity section linking to workflow
supervision. This section is independent of Git snapshot capture and works in
standalone chats. Existing Git history and recording behavior remain separate.

## Ownership and persistence

`src/features/orchestration/` owns definitions, validation, bindings, scheduling,
run snapshots and worker attribution. `types.ts` is the portable public contract;
`index.ts` is the server entry point. Composition optionally assembles the service
(default on; `orchestra: false` omits it). Core does not import this feature.

`orchestra.json` in Rack's data directory stores the workflow library, session
bindings and run snapshots through the atomic JSON document adapter. A run copies
the definition at start, so editing/deleting the library entry cannot change its
execution or erase its history. Revision checks reject stale library edits.

Workers are internal child session contexts. Sessions owns `parentSessionId`,
validates that the parent is a root conversation in the same project, and hides
workers from session navigation. Execution uses the parent's workspace (including
its existing isolated worktree) and shared app tools, while storing provider
continuation state separately for each worker. Handoffs carry bounded recent
conversation and completed worker results, never opaque provider state.

The host validates all model assignments before launching a workflow. It owns and
drains each execution handle exactly once through ActiveRuns, preserving normal
approvals, questions, journals, account selection and cancellation. Explicit
session accounts apply to workers using that provider; other providers use normal
account selection. No silent model substitutions are made.

On host restart, active workflow records become Interrupted. They are not replayed:
a worker may have completed a file or external operation before the crash. Review
the retained activity and send a new task when ready. There is no automatic retry,
crash-resume, arbitrary JavaScript authoring, parallel editing/merging, or general
conditional graph editor in this version. Internal worker history is retained
with execution history; automatic retention/garbage collection is not implemented.

## Verification

Run the scheduler suite with:

```sh
node --import tsx --test src/features/orchestration/service.test.ts
```

The native smoke test uses only a fixture runtime and a temporary application data
directory. It exercises the real renderer, preload, HostApi and execution service;
it never logs into a provider, calls a live model, or modifies project files:

```sh
node --import tsx scripts/build-desktop.ts
node_modules/.bin/esbuild scripts/verify-orchestra.ts --bundle --platform=node --format=esm --packages=external --outfile=dist-desktop/verify-orchestra.mjs
node_modules/.bin/electron dist-desktop/verify-orchestra.mjs --user-data-dir=/tmp/rack-orchestra-smoke-profile
```

The smoke check captures the editor and a completed fixture workflow under `/tmp`.
Live-provider behavior and packaged application distribution remain unverified.
