export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export class SessionNotFoundError extends SessionError {
  constructor(sessionId: string) {
    super(`Session '${sessionId}' was not found.`);
    this.name = "SessionNotFoundError";
  }
}

export class InvalidSessionError extends SessionError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSessionError";
  }
}
