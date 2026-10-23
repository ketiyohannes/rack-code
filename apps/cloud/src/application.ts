/**
 * Explicit composition of the control plane's capabilities.
 *
 * Each capability owns its document and receives its collaborators through
 * narrow interfaces: provisioning reads entitlement, relay reads the registry,
 * and nothing reaches into another module's storage. The composition root is
 * the only place that knows which payment provider and which vm-manager client
 * are in use, which is what lets the services be tested without either.
 */
import { AccountsService } from "./accounts/service.js";
import { BillingService } from "./billing/service.js";
import { ProvisioningService } from "./provisioning/service.js";
import { RegistryService } from "./registry/service.js";
import { RelayService } from "./relay/service.js";
import { MemoryDocument, type Document } from "./storage.js";
import { EMPTY_ACCOUNTS_DOCUMENT, type AccountsDocument } from "./accounts/types.js";
import { EMPTY_BILLING_DOCUMENT, type BillingDocument } from "./billing/types.js";
import { EMPTY_PROVISIONING_DOCUMENT, type ProvisioningDocument } from "./provisioning/types.js";
import { EMPTY_REGISTRY_DOCUMENT, type RegistryDocument } from "./registry/types.js";
import type { PaymentProvider } from "./billing/provider.js";
import type { VmManagerClient } from "./provisioning/vm-manager-client.js";

export interface CloudDocuments {
  readonly accounts: Document<AccountsDocument>;
  readonly billing: Document<BillingDocument>;
  readonly provisioning: Document<ProvisioningDocument>;
  readonly registry: Document<RegistryDocument>;
}

export interface CloudApplicationOptions {
  readonly documents: CloudDocuments;
  readonly paymentProvider: PaymentProvider;
  readonly vmManager: VmManagerClient;
  /** Signs relay tickets; shared with every relay node, with no other use. */
  readonly relaySigningSecret: string;
  readonly now?: () => Date;
}

export interface CloudApplication {
  readonly accounts: AccountsService;
  readonly billing: BillingService;
  readonly provisioning: ProvisioningService;
  readonly registry: RegistryService;
  readonly relay: RelayService;
}

export function createCloudApplication(options: CloudApplicationOptions): CloudApplication {
  const now = options.now ?? (() => new Date());
  const accounts = new AccountsService(options.documents.accounts, now);
  const billing = new BillingService(options.documents.billing, options.paymentProvider, now);
  const provisioning = new ProvisioningService(options.documents.provisioning, options.vmManager, billing, now);
  const registry = new RegistryService(options.documents.registry, now);
  const relay = new RelayService(registry, options.relaySigningSecret, now);
  return { accounts, billing, provisioning, registry, relay };
}

/** Test support: a full set of documents that never touches the filesystem. */
export function createMemoryDocuments(): CloudDocuments {
  return {
    accounts: new MemoryDocument(EMPTY_ACCOUNTS_DOCUMENT),
    billing: new MemoryDocument(EMPTY_BILLING_DOCUMENT),
    provisioning: new MemoryDocument(EMPTY_PROVISIONING_DOCUMENT),
    registry: new MemoryDocument(EMPTY_REGISTRY_DOCUMENT),
  };
}
