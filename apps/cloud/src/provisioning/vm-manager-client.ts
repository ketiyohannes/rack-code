/**
 * The vm-manager port and its HTTP implementation.
 *
 * `HttpVmManagerClient` is a real client for the API in `apps/vm-manager`, not
 * a placeholder: it sends the documented requests, carries the shared token
 * and maps upstream error payloads onto `UpstreamError` so a failure keeps its
 * cause. Tests substitute an in-memory implementation of the same interface.
 *
 * The port is deliberately narrow. The control plane never exposes vm-manager
 * directly, because that service has no account model: it would happily
 * destroy any machine for any caller holding its token.
 */
import { UnsupportedError, UpstreamError } from "../errors.js";

export interface VmMachineRequest {
  readonly name: string;
  readonly image: string;
  readonly vcpus?: number;
  readonly memoryMiB?: number;
  readonly diskGiB?: number;
  readonly labels: Readonly<Record<string, string>>;
}

/** The subset of a vm-manager machine record the control plane relies on. */
export interface VmMachine {
  readonly id: string;
  readonly state: string;
  readonly snapshots: readonly VmSnapshot[];
}

export interface VmSnapshot {
  readonly id: string;
  readonly label: string;
  readonly capturedAt: string;
  readonly sizeBytes: number;
}

export interface VmManagerClient {
  createMachine(request: VmMachineRequest): Promise<VmMachine>;
  getMachine(machineId: string): Promise<VmMachine>;
  snapshotMachine(machineId: string, label?: string): Promise<VmMachine>;
  restoreMachine(machineId: string, snapshotId: string): Promise<VmMachine>;
  destroyMachine(machineId: string): Promise<VmMachine>;
}

export interface HttpVmManagerOptions {
  /** Base URL of the vm-manager service, for example `http://10.0.0.4:8791`. */
  readonly baseUrl: string;
  readonly token: string;
  /** Bounds a call; vm-manager operations are slow but not unbounded. */
  readonly timeoutMs?: number;
}

export class HttpVmManagerClient implements VmManagerClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpVmManagerOptions) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  createMachine(request: VmMachineRequest): Promise<VmMachine> {
    return this.call("POST", "/v1/machines", request);
  }

  getMachine(machineId: string): Promise<VmMachine> {
    return this.call("GET", `/v1/machines/${encodeURIComponent(machineId)}`);
  }

  snapshotMachine(machineId: string, label?: string): Promise<VmMachine> {
    return this.call("POST", `/v1/machines/${encodeURIComponent(machineId)}/snapshots`, label === undefined ? {} : { label });
  }

  restoreMachine(machineId: string, snapshotId: string): Promise<VmMachine> {
    return this.call("POST", `/v1/machines/${encodeURIComponent(machineId)}/restore`, { snapshotId });
  }

  destroyMachine(machineId: string): Promise<VmMachine> {
    return this.call("DELETE", `/v1/machines/${encodeURIComponent(machineId)}`);
  }

  private async call(method: string, path: string, body?: unknown): Promise<VmMachine> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(new URL(path, this.options.baseUrl), {
        method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // A transport failure leaves the outcome genuinely unknown: the request
      // may have been performed. The caller records that rather than retrying
      // a machine creation that might already have succeeded.
      throw new UpstreamError("vm-manager", error instanceof Error ? error.message : String(error), { method, path });
    }
    const payload = (await response.json().catch(() => ({}))) as { machine?: VmMachine; error?: { code?: string; message?: string } };
    if (!response.ok) {
      throw new UpstreamError("vm-manager", payload.error?.message ?? `HTTP ${response.status}`, {
        method,
        path,
        status: String(response.status),
        ...(payload.error?.code === undefined ? {} : { upstreamCode: payload.error.code }),
      });
    }
    if (payload.machine === undefined) throw new UpstreamError("vm-manager", "response contained no machine", { method, path });
    return payload.machine;
  }
}

/**
 * Used when no vm-manager is configured. Every call fails with 501 so a
 * deployment without machine hosting reports that plainly instead of
 * accepting provisioning requests it cannot serve.
 */
export function createUnconfiguredVmManagerClient(): VmManagerClient {
  const fail = (): never => {
    throw new UnsupportedError("machine provisioning", "RACK_CLOUD_VM_MANAGER_URL and RACK_CLOUD_VM_MANAGER_TOKEN are not set");
  };
  return {
    createMachine: async () => fail(),
    getMachine: async () => fail(),
    snapshotMachine: async () => fail(),
    restoreMachine: async () => fail(),
    destroyMachine: async () => fail(),
  };
}
