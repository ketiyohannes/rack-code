export class ExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionError";
  }
}

export class RunNotFoundError extends ExecutionError {
  constructor(runId: string) {
    super(`Run '${runId}' was not found.`);
    this.name = "RunNotFoundError";
  }
}

export class RuntimeNotFoundError extends ExecutionError {
  constructor(runtimeId: string) {
    super(`Runtime '${runtimeId}' was not registered.`);
    this.name = "RuntimeNotFoundError";
  }
}

export class ApprovalNotFoundError extends ExecutionError {
  constructor(approvalId: string) {
    super(`Approval '${approvalId}' is not pending.`);
    this.name = "ApprovalNotFoundError";
  }
}

/** Raised when an attempt record referenced by a run is missing. */
export class AttemptNotFoundError extends ExecutionError {
  constructor(attemptId: string) {
    super(`Attempt '${attemptId}' was not found.`);
    this.name = "AttemptNotFoundError";
  }
}

/** Raised when no explicit account was requested and none is eligible. */
export class NoEligibleAccountError extends ExecutionError {
  constructor(providerId: string) {
    super(`No eligible account is available for provider '${providerId}'.`);
    this.name = "NoEligibleAccountError";
  }
}
