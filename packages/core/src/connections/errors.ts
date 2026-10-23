export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

/** Raised when no connector is registered for a provider. */
export class ConnectorNotFoundError extends ConnectionError {
  constructor(providerId: string) {
    super(`No sign-in is available for provider '${providerId}'.`);
    this.name = "ConnectorNotFoundError";
  }
}

/** Raised when a connect ID does not refer to a sign-in in progress. */
export class ConnectNotFoundError extends ConnectionError {
  constructor(connectId: string) {
    super(`Sign-in '${connectId}' is not in progress.`);
    this.name = "ConnectNotFoundError";
  }
}
