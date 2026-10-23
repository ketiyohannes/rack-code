/**
 * Typed failures with stable codes and HTTP statuses.
 *
 * Two distinctions matter for a control plane. First, "the caller may not do
 * this" (`forbidden`, `payment_required`, `quota_exceeded`) is kept apart from
 * "this did not work" (`upstream`, `internal`), so a client can tell a billing
 * problem from an outage. Second, anything that is not implemented raises
 * `unsupported` (501) rather than returning a success: a sign-up must never
 * report a subscription that no payment provider knows about, and a
 * provisioning call must never report a machine that was not created.
 */

export type CloudErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "payment_required"
  | "quota_exceeded"
  | "unsupported"
  | "upstream"
  | "configuration"
  | "internal";

export class CloudError extends Error {
  constructor(
    readonly code: CloudErrorCode,
    readonly status: number,
    message: string,
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class RequestValidationError extends CloudError {
  constructor(path: string, message: string) {
    super("invalid_request", 400, `${path === "" ? "body" : path}: ${message}`, { path });
  }
}

/**
 * Deliberately uniform. Sign-in uses the same message for an unknown address
 * and a wrong password so the endpoint cannot be used to enumerate accounts.
 */
export class UnauthorizedError extends CloudError {
  constructor(message = "invalid credentials") {
    super("unauthorized", 401, message);
  }
}

export class ForbiddenError extends CloudError {
  constructor(message: string) {
    super("forbidden", 403, message);
  }
}

export class NotFoundError extends CloudError {
  constructor(resource: string, id: string) {
    super("not_found", 404, `${resource} ${id} does not exist`, { resource, id });
  }
}

export class ConflictError extends CloudError {
  constructor(message: string, details: Readonly<Record<string, string>> = {}) {
    super("conflict", 409, message, details);
  }
}

/** The account's subscription does not currently permit the operation. */
export class PaymentRequiredError extends CloudError {
  constructor(message: string, details: Readonly<Record<string, string>> = {}) {
    super("payment_required", 402, message, details);
  }
}

export class QuotaExceededError extends CloudError {
  constructor(resource: string, limit: number, planId: string) {
    super("quota_exceeded", 409, `plan "${planId}" allows at most ${limit} ${resource}`, { resource, limit: String(limit), planId });
  }
}

/** A capability that exists as a port but has no implementation in this build. */
export class UnsupportedError extends CloudError {
  constructor(capability: string, detail: string) {
    super("unsupported", 501, `${capability} is not implemented: ${detail}`, { capability });
  }
}

/** A dependency (vm-manager, the payment provider) failed or refused. */
export class UpstreamError extends CloudError {
  constructor(service: string, detail: string, details: Readonly<Record<string, string>> = {}) {
    super("upstream", 502, `${service} failed: ${detail}`, { service, ...details });
  }
}

/** A startup misconfiguration. Raised before the service begins serving. */
export class ConfigurationError extends CloudError {
  constructor(message: string) {
    super("configuration", 500, message);
  }
}

export function describeError(error: unknown): { status: number; body: { error: { code: CloudErrorCode; message: string; details: Readonly<Record<string, string>> } } } {
  if (error instanceof CloudError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message, details: error.details } } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { error: { code: "internal", message, details: {} } } };
}
