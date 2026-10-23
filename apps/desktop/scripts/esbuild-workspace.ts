/**
 * Shared esbuild settings for bundles that run under Node or Electron.
 *
 * Workspace packages (`@rack/*`) export TypeScript sources rather than
 * compiled JavaScript, so every Node-side bundle must compile them in.
 * Third-party packages must stay external: some (the Claude Agent SDK, the
 * Codex platform binaries, node-pty) locate files relative to their own
 * install directory at runtime and break when bundled. esbuild's
 * `packages: "external"` cannot make that distinction, so this plugin marks
 * every bare specifier external except workspace packages.
 */
import type { Plugin } from "esbuild";

/** Name prefix shared by all workspace packages. */
const WORKSPACE_SCOPE = "@rack/";

export const externalizeThirdPartyPackages: Plugin = {
  name: "externalize-third-party-packages",
  setup(build) {
    // Bare specifiers start with neither "." nor "/". Entry points are always
    // resolved normally; Node built-ins are already external on platform "node".
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === "entry-point" || args.path.startsWith(WORKSPACE_SCOPE)) return undefined;
      return { path: args.path, external: true };
    });
  },
};
