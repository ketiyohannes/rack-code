/**
 * Command-line and environment configuration for `rack daemon`.
 *
 * The defaults encode one security decision worth stating plainly: the
 * daemon binds to loopback unless told otherwise. It serves a command
 * surface that can read any file the user can read and run any process the
 * user can run, so the intended way to reach it from another machine is
 * through the tsnet sidecar (`native/tsnet-sidecar`) or a relay, both of
 * which authenticate before any traffic arrives. Exposing it directly on a
 * public interface has to be a deliberate `--host` argument, not something
 * that happens because a default looked convenient.
 */
import { join } from "node:path";
import { hostname } from "node:os";

import { defaultDataDirectory } from "@rack/host";

export interface DaemonConfig {
  /** Interface to bind. Loopback unless explicitly widened. */
  readonly host: string;
  readonly port: number;
  /** Where the application keeps its JSON records. */
  readonly dataDirectory: string;
  /** Identifies this machine to controllers. */
  readonly machineId: string;
  /** File holding the pairing token; created on first start. */
  readonly tokenFile: string;
  /** Token supplied by the environment, which wins over the file. */
  readonly tokenFromEnvironment?: string;
  /** How many recent events stay replayable for reconnecting controllers. */
  readonly replayBuffer: number;
  /** Seconds a bounded shutdown waits for active runs to reach a terminal state. */
  readonly shutdownTimeoutMs: number;
  /** Print the pairing token and exit, instead of serving. */
  readonly printToken: boolean;
}

export const DEFAULT_PORT = 7420;
/**
 * Matches `createApplication`'s own default so both hosts share records.
 * Pure, so importing this module touches no file system: adopting a
 * directory written under the product's former name is the entry point's
 * job, and its result is passed to `parseConfig`.
 */
export const DEFAULT_DATA_DIRECTORY = defaultDataDirectory();

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export const USAGE = `Usage: rack-daemon [options]

  --host <address>          Interface to bind (default 127.0.0.1; loopback only)
  --port <number>           Port to listen on (default ${String(DEFAULT_PORT)})
  --data-directory <path>   Application records (default ~/.rack)
  --machine-id <id>         Identifier shown to controllers (default: hostname)
  --token-file <path>       Pairing token file (default <data-directory>/daemon/token)
  --replay-buffer <n>       Events retained for reconnecting clients (default 1024)
  --shutdown-timeout <s>    Seconds to wait for active runs on exit (default 10)
  --print-token             Print the pairing token and exit
  --help                    Show this message

Environment:
  RACK_DAEMON_TOKEN         Pairing token; overrides --token-file. Preferred in
                            containers and VMs, where a file would outlive the
                            secret.`;

/**
 * Parses arguments without a dependency. Unknown flags are an error rather
 * than being ignored: a mistyped `--data-dir` that silently fell back to the
 * default would point a VM at the wrong records.
 *
 * `defaultDirectory` exists so the entry point can supply the directory it
 * adopted; `--data-directory` still wins over it.
 */
export function parseConfig(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
  defaultDirectory: string = DEFAULT_DATA_DIRECTORY,
): DaemonConfig {
  let host = "127.0.0.1";
  let port = DEFAULT_PORT;
  let dataDirectory = defaultDirectory;
  let machineId = hostname();
  let tokenFile: string | undefined;
  let replayBuffer = 1024;
  let shutdownTimeoutMs = 10_000;
  let printToken = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new ConfigurationError(`${argument} needs a value.`);
      }
      index += 1;
      return next;
    };
    switch (argument) {
      case "--host":
        host = value();
        break;
      case "--port":
        port = parsePort(value());
        break;
      case "--data-directory":
        dataDirectory = value();
        break;
      case "--machine-id":
        machineId = value();
        break;
      case "--token-file":
        tokenFile = value();
        break;
      case "--replay-buffer":
        replayBuffer = parsePositiveInteger(value(), "--replay-buffer");
        break;
      case "--shutdown-timeout":
        shutdownTimeoutMs = parsePositiveInteger(value(), "--shutdown-timeout") * 1000;
        break;
      case "--print-token":
        printToken = true;
        break;
      default:
        throw new ConfigurationError(`Unknown option ${argument}.\n\n${USAGE}`);
    }
  }

  const fromEnvironment = environment["RACK_DAEMON_TOKEN"];
  return {
    host,
    port,
    dataDirectory,
    machineId,
    tokenFile: tokenFile ?? join(dataDirectory, "daemon", "token"),
    ...(fromEnvironment === undefined || fromEnvironment === "" ? {} : { tokenFromEnvironment: fromEnvironment }),
    replayBuffer,
    shutdownTimeoutMs,
    printToken,
  };
}

function parsePort(raw: string): number {
  const port = Number(raw);
  // Port 0 is valid and useful (the operating system picks a free port),
  // which is how the tests bind without racing for a fixed number.
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigurationError(`--port must be between 0 and 65535, received "${raw}".`);
  }
  return port;
}

function parsePositiveInteger(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ConfigurationError(`${flag} must be a positive integer, received "${raw}".`);
  }
  return parsed;
}

/** True when the daemon is reachable from outside this machine. */
export function isPubliclyBound(host: string): boolean {
  return host !== "127.0.0.1" && host !== "::1" && host !== "localhost";
}
