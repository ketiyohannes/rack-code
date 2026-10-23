import type {
  CredentialMaterial,
  CredentialResolver,
} from "@rack/core/authentication/contracts";
import type { CredentialReference } from "@rack/core/authentication";

/**
 * Test and embedding implementation of the authentication boundary.
 *
 * Credential material is supplied by the host process and is deliberately
 * held only in memory. It is never serialized with account or execution
 * records. A desktop credential-vault integration can implement the same
 * interface without changing core code.
 */
export class InMemoryCredentialResolver implements CredentialResolver {
  private readonly materials = new Map<string, CredentialMaterial>();

  constructor(entries: ReadonlyMap<string, CredentialMaterial> = new Map()) {
    for (const [id, material] of entries) {
      this.materials.set(id, cloneMaterial(material));
    }
  }

  set(reference: CredentialReference, material: CredentialMaterial): void {
    this.materials.set(reference.id, cloneMaterial(material));
  }

  async resolve(reference: CredentialReference): Promise<CredentialMaterial> {
    const material = this.materials.get(reference.id);
    if (material === undefined) {
      throw new Error(`Credential '${reference.id}' is not available.`);
    }
    return cloneMaterial(material);
  }
}

function cloneMaterial(material: CredentialMaterial): CredentialMaterial {
  return { environment: { ...material.environment } };
}
