# Desktop performance improvements

Implemented on `fix/desktop-performance` after the UI changes were merged through the desktop branch, `dev` and `main`. The [original audit](performance-audit.md) records the pre-fix behavior and measurement methods.

## Changes and observed results

| Area | Change | Evidence |
| --- | --- | --- |
| Execution persistence | Append and flush new transactions instead of rewriting all history; index journals and usage by run | Disposable local-history copies: median append decreased from 954.11 ms at 69.29 MB to 5.02 ms at 70.23 MB, including flush; post-fix range 3.98–10.84 ms across eight samples |
| Transcript rendering | Scope subscriptions to the conversation, retain completed DOM, incrementally fold new events, and page older history | Synthetic 200-turn Chromium fixture: unrelated-event redraw median decreased from 61.3 ms to below timer resolution (reported as 0 ms); zero completed turns replaced in 12 updates |
| Timeline capture | Reuse bounded private index stat data and remove newly ignored entries before staging | Unchanged 5,000-file fixture: median decreased from 532.91 ms to 136.57 ms, with a 160.06 ms post-fix maximum across five samples |
| Timeline observation | Share native watches, batch Git ignore checks and revalidate healthy roots every 30 seconds | Regression coverage preserves edits, deletions, ignored/unignored paths and the user's Git index; existing project observation/fallback tests pass |
| Startup | Publish local sessions independently of model discovery; share/cache catalog results for 60 seconds and cap concurrent discoveries at two | Controller test shows session readiness while discovery remains unresolved; cache tests cover sharing, failure retry, reconnect invalidation and eviction after bursts |
| History and polling | Project session summaries before copying, load the newest 50 journals with four concurrent reads, cap session cache payload, and back off unchanged Changes reads to ten seconds | Controller paging test verifies request counts and concurrency; hidden windows skip Changes and Timeline UI polling |

These are local fixture results, not end-to-end latency guarantees. Storage and Timeline results were preserved from the earlier implementation pass; the Chromium benchmark was rerun when work resumed and reproduced zero unrelated-event turn replacements. Original conversation data was not changed by the benchmarks. The local-history copy was disposable, and the before/after copies differ slightly in size.

Main chat initially renders the newest 50 runs and 100 imported messages; side chat initially renders 50 runs. The clock-arrow button loads earlier messages. The renderer session cache keeps at most eight sessions and approximately 32 MiB of estimated JS payload. Expanding history intentionally increases the active view's working set. Chromium checks confirmed that expanding 50 to 100 turns keeps existing nodes mounted and that a subsequent active response streams without replacing completed turns.

## Persistence migration and recovery

The execution adapter retains its existing public interface. On first access it reads and normalizes the legacy execution JSON, writes a self-contained snapshot to a private temporary log, flushes it, and renames it to `<execution-file>.log`. Subsequent transactions append to this log. The original JSON remains a pre-log backup and receives no new events; copying it back would lose post-migration progress. The log is authoritative once present.

Writes remain serialized and flush before in-memory publication and event delivery. A failed append attempts to truncate and flush back to the previous committed byte; a failed rollback blocks further writes until restart. On restart, only an unterminated final record is removed. Invalid committed JSON or noncontiguous journal sequences fail visibly instead of silently loading the old backup. Startup recovery updates runs, attempts and recovery journal entries in one log transaction. As before, a data directory requires one live host owner.

The migration, detached reads, concurrent append ordering, bounded write size, restart replay and torn-tail handling have regression coverage. Existing interrupted-run recovery and legacy schema migration tests also pass. These tests do not simulate physical disk failure or power loss.

## Validation and remaining limits

- `npm run check` passed: both TypeScript projects, headless build, 283 tests and desktop bundle. A final model-cache eviction regression was added afterward; both cache tests passed separately. The resulting suite contains 284 tests.
- Chromium synthetic fixture checks passed for unrelated events, 50-to-100-turn paging and active streaming with retained completed nodes.
- `git diff --check` passed.
- No paid provider turn, packaged-app profile, prolonged concurrent streaming session or Windows/Linux verification was performed.

The execution log still replays into memory at startup and grows without compaction or retention. A selected run's journal loads as one unit; paging is by runs, not individual events. Session writes retain their existing JSON persistence. The active turn's DOM and Markdown are still rebuilt on its own updates, although completed turns and unrelated conversations avoid that work. Changes still fetches full bounded patches per refresh. Timeline still captures required tool boundaries and records enabled projects in the background; hiding its panel does not pause recording. These are remaining profiling targets rather than claims that all performance costs have been eliminated.
