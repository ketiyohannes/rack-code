# Desktop performance audit — 2026-10-19

Investigation of the current, uncommitted `feat/ui-overhaul` working tree, including the newer Side chat work. This report records findings and proposed fixes; it does not implement optimizations. Pushes and merges remain pending.

## Evidence and limits

- Inspected renderer subscriptions, transcript construction, storage, model discovery, Timeline scheduling and tool polling.
- Read only aggregate counts and sizes from the default local data directory. At inspection, execution history contained 49,817 journal entries and 118 runs, occupying approximately 69.3 MB. Sessions occupied 13.47 MB across 29 sessions; the largest contained 877 messages. Ten projects were registered. These are a point-in-time sample, not limits.
- Benchmarked the actual storage implementation against synthetic data and an isolated copy of local execution history. The copy had mode `0600`, received only benchmark events, and was deleted afterward. The original was never modified by the audit.
- Benchmarked the actual session-view renderer in an isolated Chromium page, using the app CSS and synthetic completed conversations. This measures synchronous redraw/layout work, not complete Electron frame presentation or GPU cost. Each turn contained approximately 1 KB of Markdown. A deterministic animation-frame queue exposed the cost of each store notification.
- Benchmarked the actual Git snapshot adapter in temporary repositories. No snapshot benchmark ran against a user project.
- Timings are local observations under current machine load, not portable guarantees. No live model turns, provider-account discovery, sustained process CPU profile, heap-retention profile or packaged-app benchmark was performed. Existing tests/builds were not rerun because this audit changes documentation only.

Benchmark fixtures and result JSON files are in `/tmp/rack-performance-audit/`. They are temporary investigation artifacts, not a permanent benchmark suite.

## 1. Critical: every event rewrites all execution history

Sources: [execution event loop](../src/core/execution/service.ts), [execution store](../src/adapters/storage/json-execution-store.ts), [JSON persistence](../src/adapters/storage/json-file.ts).

`ExecutionService` awaits `appendJournal` before delivering each event to the UI. `appendJournal` appends to the shared journal array; `JsonFileDocument.update` clones the complete document on read, clones the next document, serializes and writes all of it, then clones it again for its return value. This work scales with history across every session, including inactive sessions. The write chain also serializes concurrent runs through the same document.

| History | Samples | Median per append | Maximum |
| --- | ---: | ---: | ---: |
| Synthetic 1,000 entries / 0.51 MB | 12 | 5.89 ms | 9.72 ms |
| Synthetic 10,000 entries / 5.01 MB | 12 | 40.37 ms | 55.01 ms |
| Synthetic 50,000 entries / 25.09 MB | 12 | 259.29 ms | 395.05 ms |
| Copy of local history / 69.29 MB | 8 | **954.11 ms** | 1,008.72 ms |

The local-history copy also consumed approximately 1,027 ms of process CPU time per append, including Node worker/GC activity. Its measured minimum was 737 ms. These numbers include copying, serialization and filesystem writes; they are not disk-only latency. The shared host process performs synchronous clone/stringify work even though filesystem calls are asynchronous, so unrelated host commands can also wait.

This is the strongest explanation for delayed streaming that worsens with usage. The inspected journal contained 30,977 message deltas and 5,059 tool-output deltas, each taking this path. Approximate storage amplification is 69 MB rewritten to persist one small event at the current size.

Proposed fix: move execution records and the append-only journal to indexed, transactional storage, or an explicitly designed append-only journal with bounded checkpoints. Preserve ordering, recovery, migrations and persistence-before-delivery guarantees. Do not simply remove the await or discard events. Validate crash recovery, concurrent sessions and sustained streaming at the current history size before migration.

## 2. High: streaming rebuilds whole conversations, including unrelated chats

Sources: [session view](../src/desktop/renderer/features/session-view.ts), [controller](../src/desktop/renderer/controller.ts), [side chat](../src/desktop/renderer/features/side-chat.ts), [composer](../src/desktop/renderer/features/composer.ts).

The transcript subscribes to the global `state.live` reference. An event for any conversation therefore invokes `draw`, which recreates every visible turn, rerenders Markdown, replaces all transcript children and rebuilds the turn rail. Layout reads follow the writes. The fold cache saves work for unchanged event arrays but does not retain completed-turn DOM. Current-run events get a fresh copied array on every delta, so their full event history is folded again on the next redraw.

| Completed turns | DOM elements | Median redraw for an unrelated event | Maximum |
| ---: | ---: | ---: | ---: |
| 10 | 572 | 4.3 ms | 5.3 ms |
| 50 | 2,732 | 18.0 ms | 23.0 ms |
| 200 | 10,832 | **61.3 ms** | 73.8 ms |

In every one of the 12 measured updates per fixture, the first completed turn was replaced despite unchanged visible content. Even 50 turns exceeded a 16.7 ms frame budget in this sample. The 200-turn case is a synthetic scaling scenario; it is not a claim that a local conversation has 200 runs.

Side chat likewise watches global live state and calls `render`, rebuilding its transcript without a visibility guard in that subscription. The composer also refreshes on the global live reference. A side-chat stream can therefore cause main-chat work and vice versa; costs for these additional components were not included in the table.

Proposed fix: select updates for the relevant session, retain keyed completed turns, incrementally fold newly received events, and update only the active response. Bound rendered history with paging or virtualization. Skip work for hidden surfaces and measure input latency while both chats stream.

## 3. High: Timeline repeatedly scans whole repositories in the background

Sources: [project tracker](../src/features/timeline/project-tracker.ts), [filesystem watcher](../src/adapters/timeline/fs-watcher.ts), [snapshot adapter](../src/adapters/timeline/git-snapshots.ts), [run recorder](../src/features/timeline/recorder.ts), [Timeline service](../src/features/timeline/service.ts).

- Project tracking starts independently of the visible Timeline tab. Every five seconds it probes each enabled saved project; there are ten registered locally, though not all necessarily resolve to supported repositories.
- Recursive watchers filter `.git`, but do not filter ignored build outputs or dependency directories before requesting captures. Those events can schedule a full capture after the debounce even though Git will ultimately ignore the changed files.
- Each capture starts with a fresh temporary index and runs `git add -A` over the repository before discovering that the resulting tree is unchanged. There is no reusable index stat cache.
- An opted-in session adds a separate watcher and captures before/after every tool call, independently of project observation. Tool-boundary capture requests are serialized but not coalesced. These can accumulate if work arrives faster than captures complete.

| Synthetic repository | Samples | Median unchanged capture | Maximum |
| --- | ---: | ---: | ---: |
| 1,000 files, approximately 4 KB each | 5 | 199.16 ms | 216.00 ms |
| 5,000 files, approximately 4 KB each | 5 | **532.91 ms** | 724.35 ms |

These are elapsed times for the adapter, including child Git processes, not measurements of CPU utilization. Both fixtures returned `unchanged` for every measured capture. Multiple projects and ongoing file activity can multiply the work; actual event frequency on the user's projects was not measured.

Proposed fix: share observation by repository, filter ignored-event noise with correct invalidation, avoid capturing an unchanged tree, and preserve an efficient private index without changing ignore semantics. Bound/coalesce capture work while retaining required before/after checkpoints. Replace repeated root probes with cached validation and targeted invalidation. Provide an explicit host-owned pause policy; hiding the UI currently does not stop recording.

## 4. High for startup: model discovery gates loading and runs sequentially

Sources: [controller startup and reloadModels](../src/desktop/renderer/controller.ts), [models.list handler](../src/desktop/host/host-api.ts), [Codex adapter](../src/adapters/runtimes/codex.ts), [Claude adapter](../src/adapters/runtimes/claude.ts).

Startup waits for `models.list` in the same `Promise.all` as projects, sessions and active runs, then publishes all results together. The handler awaits model discovery sequentially for each provider account. Each discovery starts a provider process/query and includes a 15-second timeout around the catalog request. Project changes trigger discovery again; opening the initial project session can therefore follow startup discovery with another catalog refresh. There is no settled-result cache in this path; controller coalescing only shares an in-flight request.

This code path is confirmed, but live discovery latency was not measured. Several slow accounts can add their delays before the app presents already-loaded sessions.

Proposed fix: publish local session/project state independently, cache catalog results by runtime/account/context with explicit freshness and invalidation, refresh in the background, and use bounded parallel discovery. Keep authentication failures and stale-model state visible.

## 5. Medium: opening history loads and scans more than the visible view needs

Sources: [reloadSession](../src/desktop/renderer/controller.ts), [listJournal](../src/adapters/storage/json-execution-store.ts), [session store](../src/adapters/storage/json-session-store.ts).

On an uncached session load, the renderer requests every completed run's journal concurrently. Each host `listJournal` scans the entire shared journal array, then copies matching entries and sends them over IPC. Work scales with run count times total journal entries, and all activity is retained even if its disclosure remains collapsed. An eight-session cache bounds session count, not retained bytes. `JsonSessionStore.list` also clones the whole sessions document, including message bodies, before callers reduce it to summaries.

Proposed fix: index journals by run, page activity, fetch details on demand, cap caches by bytes and project session summaries before copying. Measure large imported histories separately from live runs. This finding is based on code and local data sizes; it has no isolated latency measurement in this audit.

## 6. Medium: Changes recomputes several full Git views every two seconds

Sources: [workbench polling](../src/desktop/renderer/features/workbench.ts), [Git changes reader](../src/adapters/projects/git-changes.ts), [shell visibility predicate](../src/desktop/renderer/features/shell.ts).

When Changes is selected, a typical repository refresh invokes at least nine Git commands, including combined, staged and working-tree diffs, status and untracked-file discovery. All-repository mode repeats this for every discovered repository. Results are JSON-stringified for comparison, and each changed repository triggers a complete view render. In-flight requests are guarded, so this is not unbounded overlapping polling. However, the refresh guard checks panel layout/page visibility rather than `document.hidden`, unlike terminal/browser polling.

Proposed fix: stop hidden-window polling, use change notifications and adaptive idle backoff, and load full patches only for selected files. Preserve staged/unstaged distinctions. No isolated refresh timing was recorded.

## Recommended implementation order

1. Fix execution persistence first; it is already expensive at the local history size and delays every stream event.
2. Scope subscriptions and retain/incrementally update transcript DOM. Faster persistence will deliver events more quickly and expose the renderer bottleneck more strongly.
3. Reduce Timeline captures and background Git work.
4. Decouple model discovery from initial navigation, then add indexed/lazy history reads and adaptive tool polling.

Terminal polling already checks visibility, allows one read at a time, and requests deltas; host output is bounded to 262,144 characters and terminals are capped at 12. These safeguards make it a lower-priority suspect than persistence and transcript rebuilding. Retained shells can still own child processes, but this audit did not establish a process leak. Similarly, no evidence here establishes icon rendering or the theme as the primary cause.
