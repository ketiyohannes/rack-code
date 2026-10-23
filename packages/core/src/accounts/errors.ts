/** Base error for account-domain failures. */
export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountError";
  }
}

/** Raised when an operation refers to an account that is not saved. */
export class AccountNotFoundError extends AccountError {
  constructor(accountId: string) {
    super(`Account '${accountId}' was not found.`);
    this.name = "AccountNotFoundError";
  }
}

/** Raised when an account is used with a different provider namespace. */
export class AccountProviderMismatchError extends AccountError {
  constructor(accountId: string, expectedProvider: string, actualProvider: string) {
    super(
      `Account '${accountId}' belongs to provider '${actualProvider}', not '${expectedProvider}'.`,
    );
    this.name = "AccountProviderMismatchError";
  }
}

/** Raised when the same provider account has already been registered. */
export class DuplicateAccountError extends AccountError {
  /** Exposed so clients can locate the existing account without parsing text. */
  constructor(readonly providerId: string, readonly providerAccountId: string) {
    super(
      `Provider account '${providerAccountId}' is already registered for provider '${providerId}'.`,
    );
    this.name = "DuplicateAccountError";
  }
}

/** Raised when a required account input is empty or internally inconsistent. */
export class InvalidAccountError extends AccountError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAccountError";
  }
}
