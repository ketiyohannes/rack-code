/**
 * Public interface of the optional Timeline feature. Other modules import
 * from here, never from implementation files.
 */
export * from "./errors.js";
export type * from "./ports.js";
export type * from "./types.js";
export type { RecorderEvent } from "./recorder.js";
export {
  CODEX_TIMELINE_REF_PREFIX,
  IMPORT_RECORD_LIMIT,
  TIMELINE_REF_PREFIX,
  TimelineService,
  refFor,
  type TimelineRunObserver,
  type TimelineServiceOptions,
} from "./service.js";
