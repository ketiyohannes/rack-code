/**
 * Timeline failures that clients can branch on. The host maps each class to
 * a stable `HostErrorCode`; messages follow the product specification.
 */

/** Enablement cannot change while a run is editing the session's project. */
export class TimelineBusyError extends Error {
  constructor(readonly sessionId: string) {
    super("Stop the current run before changing timeline settings");
    this.name = "TimelineBusyError";
  }
}

/** The requested checkpoint is not part of this session's visible timeline. */
export class SnapshotNotFoundError extends Error {
  constructor(readonly checkpointId: string) {
    super("No snapshot for this action");
    this.name = "SnapshotNotFoundError";
  }
}

/** The requested path is not a visible member of the requested snapshot/view. */
export class SnapshotPathError extends Error {
  constructor(readonly path: string) {
    super("File is not part of this snapshot");
    this.name = "SnapshotPathError";
  }
}

/** Timeline is not supported for the session's project (no Git, missing folder). */
export class TimelineUnsupportedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TimelineUnsupportedError";
  }
}
