# apps/cloud (`@rack/cloud`)

The control plane. It owns accounts, subscriptions, machine ownership and the
registry that tells a client where its daemons are. It asks
`apps/vm-manager` for machines and never touches a hypervisor itself.

**It never runs agents.** No runtime adapter, no session, no project file and
no provider credential belongs here; that work happens in `apps/daemon`, inside
the machines this service has provisioned. Accordingly it depends on no
`@rack/*` package and on nothing outside the Node standard library.

## Running it

```sh
RACK_CLOUD_WEBHOOK_SECRET=<32+ chars> \
RACK_CLOUD_RELAY_SIGNING_SECRET=<32+ chars> \
npm start --workspace @rack/cloud
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `RACK_CLOUD_WEBHOOK_SECRET` | *(required)* | Verifies payment-provider webhooks |
| `RACK_CLOUD_RELAY_SIGNING_SECRET` | *(required)* | Signs relay tickets; shared with relay nodes |
| `RACK_CLOUD_PAYMENT_PROVIDER` | `manual` | `manual` or `stripe` |
| `RACK_CLOUD_VM_MANAGER_URL` / `_TOKEN` | *(unset)* | vm-manager location and token; both or neither |
| `RACK_CLOUD_RELAY_NODE_TOKEN` | *(unset)* | Credential relay nodes present when redeeming tickets |
| `RACK_CLOUD_HOST` / `RACK_CLOUD_PORT` | `127.0.0.1` / `8790` | Bind address and port; the default expects a terminating proxy in front |
| `RACK_CLOUD_DATA_DIR` | `./.rack-cloud` | JSON documents for the four capabilities |

Secrets are required rather than generated: a key invented at startup would
invalidate every outstanding ticket on restart. Optional capabilities may be
absent, and the routes that need them then answer `501` — provisioning without
a vm-manager, relay redemption without a relay-node token — instead of
accepting a request the service cannot serve. `GET /health` reports which of
them are configured.

## HTTP API

`Authorization: Bearer <token>` carries an account token, except where noted.

| Route | Auth | Effect |
| --- | --- | --- |
| `POST /v1/accounts` | public | Sign up; returns the account, an API token and a trial subscription |
| `POST /v1/accounts/sessions` | public | Sign in; returns a new API token |
| `GET /v1/accounts/me` | account | Account, subscription and entitlement |
| `GET`/`POST /v1/accounts/tokens` | account | List or issue API tokens |
| `DELETE /v1/accounts/tokens/:tokenId` | account | Revoke one token |
| `GET /v1/billing/plans` | public | Plan catalogue with its limits |
| `GET /v1/billing/subscription` | account | Subscription and entitlement |
| `POST /v1/billing/checkout` | account | Start a plan change at the provider |
| `POST /v1/billing/cancel` | account | Cancel at period end, or `immediate` |
| `POST /v1/billing/webhook` | signature | Apply a provider event (`X-Rack-Signature`) |
| `GET`/`POST /v1/machines` | account | List or provision machines |
| `GET /v1/machines/:machineId` | account | Assignment plus its upstream machine |
| `POST /v1/machines/:machineId/snapshots` | account | Take a safe shot |
| `POST /v1/machines/:machineId/restore` | account | Roll back to a snapshot |
| `DELETE /v1/machines/:machineId` | account | Destroy the machine and free quota |
| `POST`/`GET /v1/registry/daemons` | account | Register a daemon, or list the account's |
| `POST /v1/registry/daemons/:daemonId/heartbeat` | daemon secret | Report liveness and current endpoints |
| `DELETE /v1/registry/daemons/:daemonId` | account | Deregister |
| `POST /v1/relay/tickets` | account | Issue a short-lived ticket for one daemon |
| `POST /v1/relay/redeem` | relay node | Verify a ticket and resolve its endpoints |

Errors are `{ "error": { "code", "message", "details" } }`; codes are
`invalid_request` (400), `unauthorized` (401), `payment_required` (402),
`forbidden` (403), `not_found` (404), `conflict` and `quota_exceeded` (409),
`unsupported` (501) and `upstream` (502).

## Capabilities

**`src/accounts/`** — sign-up, sign-in and API tokens. Passwords are stored as
scrypt hashes with their cost parameters; tokens only as SHA-256 digests. An
unknown address and a wrong password produce the same error after the same
work, so sign-in cannot be used to enumerate accounts. Suspension disables
sign-in and existing tokens without deleting anything.

**`src/billing/`** — plans, the subscription state machine and provider
events. `subscriptions.ts` holds the rules as pure functions: only a payment
event extends a period, an early renewal does not shorten the paid one, a
failed payment degrades to `past_due` for the rest of the period, and expiry
is applied on read so entitlement is correct without a scheduler. Webhook
events are applied exactly once, because providers retry deliveries.

**`src/provisioning/`** — turns an entitled request into a machine in
vm-manager and keeps the ownership record that authorizes every later
operation. The assignment is recorded *before* the upstream call, so a timeout
leaves evidence of a machine that may exist rather than a silent leak; a failed
call settles it as `failed` and stops counting against quota. Restoring is
allowed while a subscription has lapsed — recovering a broken machine should
not require a payment first.

**`src/registry/`** — daemon registration, heartbeats and account-scoped
lookup. Liveness is computed from the last heartbeat at read time rather than
stored, so a destroyed machine cannot leave an `online` row behind, and a
registration is evidence that a daemon announced itself, never that it is
reachable now. Heartbeats are authenticated with the daemon's own rotating
secret, not an account token.

**`src/relay/`** — short-lived HMAC-signed tickets. A relay node verifies a
ticket with the shared signing secret alone, needing no database access, and
each ticket is redeemable once. The control plane carries no traffic and the
daemon's own pairing token is still required at the far end.

## Ports and where real infrastructure plugs in

- **`src/billing/provider.ts`** is the payment port. `createManualProvider`
  takes no payment and says so — in `takesPayment: false`, in `/health` and in
  the instructions returned with every checkout — while really verifying
  webhook signatures, so the whole subscription lifecycle can be exercised
  locally. `src/billing/stripe.ts` is the seam for the real integration: it
  holds no keys, fails every call with 501, and documents what each operation
  must do, including that webhook verification needs the exact received bytes.
- **`src/provisioning/vm-manager-client.ts`** is the vm-manager port.
  `HttpVmManagerClient` is a working client for the API in `apps/vm-manager`.
  When no vm-manager is configured, `createUnconfiguredVmManagerClient` fails
  every call with 501 rather than accepting requests it cannot serve.

## Not implemented

No email delivery, so there is no address verification, password reset or
dunning notification. No organizations or roles: an account is one tenant and
owns its machines directly. No metered usage or invoices — plans carry limits,
not consumption. Storage is one JSON document per capability, which suits a
single instance; running several requires a shared database, as the composition
root is already arranged for. Tokens have no expiry and are revoked explicitly.
