import assert from "node:assert/strict";
import test from "node:test";
import { AccountsService } from "./service.js";
import { EMPTY_ACCOUNTS_DOCUMENT, type AccountsDocument } from "./types.js";
import { MemoryDocument } from "../storage.js";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "../errors.js";

function service(): { accounts: AccountsService; document: MemoryDocument<AccountsDocument> } {
  const document = new MemoryDocument<AccountsDocument>(EMPTY_ACCOUNTS_DOCUMENT);
  return { accounts: new AccountsService(document), document };
}

test("sign-up stores no recoverable credential and refuses a duplicate address", async () => {
  const { accounts, document } = service();
  const { account, token } = await accounts.signUp({ email: "ada@example.com", password: "correct horse battery", displayName: "Ada" });
  assert.equal(account.status, "active");

  const stored = await document.read();
  const serialized = JSON.stringify(stored);
  assert.equal(serialized.includes("correct horse battery"), false, "the password must not be recoverable from the document");
  assert.equal(serialized.includes(token.secret), false, "only a digest of the token is stored");
  assert.equal(stored.accounts[0]?.password.algorithm, "scrypt");

  await assert.rejects(
    accounts.signUp({ email: "ada@example.com", password: "another good password", displayName: "Ada again" }),
    ConflictError,
  );
});

test("sign-in answers the same way for an unknown address and a wrong password", async () => {
  const { accounts } = service();
  await accounts.signUp({ email: "ada@example.com", password: "correct horse battery", displayName: "Ada" });

  const unknown = await accounts.signIn("nobody@example.com", "correct horse battery").catch((error: unknown) => error);
  const wrong = await accounts.signIn("ada@example.com", "incorrect horse battery").catch((error: unknown) => error);
  assert.ok(unknown instanceof UnauthorizedError);
  assert.ok(wrong instanceof UnauthorizedError);
  assert.equal(unknown.message, wrong.message, "the error must not reveal which addresses are registered");

  const { account } = await accounts.signIn("ada@example.com", "correct horse battery");
  assert.equal(account.email, "ada@example.com");
});

test("tokens authenticate their account until they are revoked", async () => {
  const { accounts } = service();
  const { account, token } = await accounts.signUp({ email: "ada@example.com", password: "correct horse battery", displayName: "Ada" });
  assert.equal((await accounts.authenticate(token.secret)).id, account.id);

  const second = await accounts.issueToken(account.id, "laptop");
  assert.deepEqual((await accounts.listTokens(account.id)).map((entry) => entry.name), ["initial", "laptop"]);

  await accounts.revokeToken(account.id, second.record.id);
  await assert.rejects(accounts.authenticate(second.secret), UnauthorizedError);
  assert.equal((await accounts.authenticate(token.secret)).id, account.id, "revoking one token leaves the others usable");
  await assert.rejects(accounts.authenticate("rck_not-a-real-token"), UnauthorizedError);
});

test("one account cannot revoke another account's token", async () => {
  const { accounts } = service();
  const first = await accounts.signUp({ email: "ada@example.com", password: "correct horse battery", displayName: "Ada" });
  const second = await accounts.signUp({ email: "alan@example.com", password: "correct horse battery", displayName: "Alan" });

  // "Not found" rather than "forbidden": whether the ID exists is not the
  // caller's business.
  await assert.rejects(accounts.revokeToken(second.account.id, first.token.record.id), NotFoundError);
  assert.equal((await accounts.authenticate(first.token.secret)).id, first.account.id);
});

test("a suspended account cannot sign in or use existing tokens", async () => {
  const { accounts } = service();
  const { account, token } = await accounts.signUp({ email: "ada@example.com", password: "correct horse battery", displayName: "Ada" });
  await accounts.setStatus(account.id, "suspended", "payment disputed");

  await assert.rejects(accounts.authenticate(token.secret), ForbiddenError);
  await assert.rejects(accounts.signIn("ada@example.com", "correct horse battery"), ForbiddenError);

  const restored = await accounts.setStatus(account.id, "active");
  assert.equal(restored.suspendedReason, undefined, "the reason does not outlive the suspension");
  assert.equal((await accounts.authenticate(token.secret)).id, account.id);
});
