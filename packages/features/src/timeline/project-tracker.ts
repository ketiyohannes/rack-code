/**
 * Desktop-lifetime project observations, independent of session opt-in.
 * Saved Git projects are reconciled periodically so old, newly added and
 * newly initialized repositories all acquire a watcher. One watcher/chain
 * per repository root avoids duplicate capture for subfolder aliases.
 *
 * Captures are serialized/coalesced by RunRecorder, reused only as a watcher
 * scheduler here. The first observation compares against HEAD when possible,
 * recovering current uncommitted changes in projects with no saved timeline.
 * Errors never escape into execution or prevent other projects being watched.
 */
import type { ProjectWatcher, SnapshotRepository, TimelineCoreAccess, TimelineStore, WatchHandle } from "./ports.js";
import { RunRecorder } from "./recorder.js";

export const PROJECT_TIMELINE_REF_PREFIX = "refs/rack-project-timeline/";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

interface Observation {
  readonly projectId: string;
  readonly projectPath: string;
  checkedAt: number;
  readonly capture: () => Promise<void>;
  readonly poll: boolean;
  stop(): Promise<void>;
}

export class ProjectTimelineTracker {
  private readonly observations = new Map<string, Observation>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private stopped = true;
  private queued = false;

  constructor(
    private readonly core: TimelineCoreAccess,
    private readonly store: TimelineStore,
    private readonly snapshots: SnapshotRepository,
    private readonly watcher: ProjectWatcher | undefined,
    private readonly failure: (root: string, message: string | undefined) => void,
  ) {}

  /** Starts only in the desktop host; headless readers do not begin writing snapshots. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.refresh(); }, 5000);
    this.timer.unref?.();
    await this.refresh();
  }

  /** Reconciles adds/removals/pauses without racing an earlier reconciliation. */
  refresh(): Promise<void> {
    if (this.queued) return this.queue;
    this.queued = true;
    this.queue = this.queue.then(() => { this.queued = false; return this.reconcile(); }).catch(() => {});
    return this.queue;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.queue;
    await Promise.all([...this.observations.values()].map((entry) => entry.stop()));
    this.observations.clear();
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    const wanted = new Map<string, { projectId: string; projectPath: string }>();
    for (const project of await this.core.projects()) {
      if (!SAFE_ID.test(project.projectId) || (await this.store.getProject(project.projectId))?.enabled === false) continue;
      // Healthy native watches already detect edits. Revalidate roots every
      // 30 seconds rather than launching Git for every project every 5 seconds.
      const retained = [...this.observations].find(([, value]) => value.projectId === project.projectId && value.projectPath === project.projectPath);
      if (retained && !retained[1].poll && Date.now() - retained[1].checkedAt < 30_000) { wanted.set(retained[0], project); continue; }
      const capability = await this.snapshots.probe(project.projectPath);
      if (retained) retained[1].checkedAt = Date.now();
      if (capability.supported && !wanted.has(capability.repositoryRoot)) wanted.set(capability.repositoryRoot, project);
    }
    for (const [root, observation] of this.observations) {
      if (wanted.get(root)?.projectId === observation.projectId) continue;
      await observation.stop();
      this.observations.delete(root);
    }
    for (const [root, project] of wanted) {
      if (this.stopped) return;
      const current = this.observations.get(root);
      if (current !== undefined) {
        if (current.poll) await current.capture();
        continue;
      }
      let closed = false;
      const capture = async () => {
        if (closed || this.stopped) return;
        try {
          await this.snapshots.capture({ projectPath: project.projectPath,
            ref: `${PROJECT_TIMELINE_REF_PREFIX}${project.projectId}`, startFromHead: true,
            label: "Files changed", trailers: { "Rack-Timeline-Project": project.projectId } });
          this.failure(root, undefined);
        } catch (error) {
          this.failure(root, error instanceof Error ? error.message : String(error));
        }
      };
      // Start watching before the initial observation to catch edits made
      // while that Git capture is running. They queue behind it.
      let watch: WatchHandle | undefined;
      let serial: Promise<void> = Promise.resolve();
      const request = () => { serial = serial.then(capture); return serial; };
      const live = new RunRecorder({ capture: request, onFailure: (message) => this.failure(root, message), debounceMs: 500,
        ...(this.watcher === undefined ? {} : { startWatch: (changed) => {
          const handle = this.watcher!.watch(root, changed);
          watch = handle;
          return handle;
        } }),
      });
      const observation: Observation = { projectId: project.projectId, projectPath: project.projectPath, checkedAt: Date.now(), capture: request, get poll() { return watch === undefined || watch.closed === true; },
        stop: async () => { closed = true; live.abandon(); await live.finish(); await serial; } };
      this.observations.set(root, observation);
      await request();
    }
  }
}
