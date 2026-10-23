/**
 * Typed failures with stable codes and HTTP statuses.
 *
 * Every failure a client can observe is one of these. An operation that is not
 * implemented raises `DriverUnsupportedError` (501) instead of reporting
 * success, so a caller can never read a 2xx response as evidence that a
 * machine was created, snapshotted or restored.
 */

export type VmManagerErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "invalid_transition"
  | "operation_failed"
  | "driver_unsupported"
  | "configuration"
  | "internal";

export class VmManagerError extends Error {
  constructor(
    readonly code: VmManagerErrorCode,
    readonly status: number,
    message: string,
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class RequestValidationError extends VmManagerError {
  constructor(readonly path: string, message: string) {
    super("invalid_request", 400, `${path === "" ? "body" : path}: ${message}`, { path });
  }
}

export class UnauthorizedError extends VmManagerError {
  constructor(message = "a valid bearer token is required") {
    super("unauthorized", 401, message);
  }
}

export class MachineNotFoundError extends VmManagerError {
  constructor(machineId: string) {
    super("not_found", 404, `machine ${machineId} does not exist`, { machineId });
  }
}

export class SnapshotNotFoundError extends VmManagerError {
  constructor(machineId: string, snapshotId: string) {
    super("not_found", 404, `machine ${machineId} has no snapshot ${snapshotId}`, { machineId, snapshotId });
  }
}

/**
 * The requested operation is not legal from the machine's current state. A
 * concurrent operation produces this too: the first request moves the machine
 * into a transient state, which no second operation accepts as a source.
 */
export class InvalidTransitionError extends VmManagerError {
  constructor(machineId: string, operation: string, state: string) {
    super("invalid_transition", 409, `cannot ${operation} machine ${machineId} while it is ${state}`, { machineId, operation, state });
  }
}

/** A driver call failed. The machine is left `failed` with the reason recorded. */
export class MachineOperationFailedError extends VmManagerError {
  constructor(machineId: string, operation: string, reason: string) {
    super("operation_failed", 502, `${operation} failed for machine ${machineId}: ${reason}`, { machineId, operation });
  }
}

/** The selected driver cannot perform this operation (see `drivers/hypervisor.ts`). */
export class DriverUnsupportedError extends VmManagerError {
  constructor(driver: string, operation: string, detail: string) {
    super("driver_unsupported", 501, `driver "${driver}" does not implement ${operation}: ${detail}`, { driver, operation });
  }
}

export class ConfigurationError extends VmManagerError {
  constructor(message: string) {
    super("configuration", 500, message);
  }
}

/** Normalizes anything thrown into a payload the HTTP layer can return. */
export function describeError(error: unknown): { status: number; body: { error: { code: VmManagerErrorCode; message: string; details: Readonly<Record<string, string>> } } } {
  if (error instanceof VmManagerError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message, details: error.details } } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { error: { code: "internal", message, details: {} } } };
}
