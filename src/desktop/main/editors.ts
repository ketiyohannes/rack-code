/** Native editor discovery and launching, independent of Electron for tests.
 * Only installed, catalogued applications can be addressed by renderer IDs.
 * File paths are passed as arguments, with no shell command interpolation.
 */
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { EditorTarget, OpenEditorRequest, OpenEditorResult } from "../../contracts/desktop/editors.js";
import { resolveClickedPath } from "./open-path.js";

interface EditorDefinition {
  readonly id: string; readonly label: string;
  readonly mac: readonly string[]; readonly commands: readonly string[];
  readonly windows?: readonly string[];
}
/** Common editors across supported platforms; the native chooser covers others. */
const EDITORS: readonly EditorDefinition[] = [
  { id: "vscode", label: "Visual Studio Code", mac: ["Visual Studio Code.app"], commands: ["code"], windows: ["Microsoft VS Code/Code.exe"] },
  { id: "vscode-insiders", label: "VS Code Insiders", mac: ["Visual Studio Code - Insiders.app"], commands: ["code-insiders"], windows: ["Microsoft VS Code Insiders/Code - Insiders.exe"] },
  { id: "cursor", label: "Cursor", mac: ["Cursor.app"], commands: ["cursor"], windows: ["cursor/Cursor.exe"] },
  { id: "windsurf", label: "Windsurf", mac: ["Windsurf.app"], commands: ["windsurf"], windows: ["Windsurf/Windsurf.exe"] },
  { id: "zed", label: "Zed", mac: ["Zed.app", "Zed Preview.app"], commands: ["zed", "zeditor"], windows: ["Zed/zed.exe"] },
  { id: "sublime", label: "Sublime Text", mac: ["Sublime Text.app"], commands: ["subl"], windows: ["Sublime Text/sublime_text.exe"] },
  { id: "webstorm", label: "WebStorm", mac: ["WebStorm.app"], commands: ["webstorm"] },
  { id: "idea", label: "IntelliJ IDEA", mac: ["IntelliJ IDEA.app", "IntelliJ IDEA CE.app", "IntelliJ IDEA Ultimate.app"], commands: ["idea"] },
  { id: "pycharm", label: "PyCharm", mac: ["PyCharm.app", "PyCharm CE.app"], commands: ["pycharm"] },
  { id: "phpstorm", label: "PhpStorm", mac: ["PhpStorm.app"], commands: ["phpstorm"] },
  { id: "goland", label: "GoLand", mac: ["GoLand.app"], commands: ["goland"] },
  { id: "rustrover", label: "RustRover", mac: ["RustRover.app"], commands: ["rustrover"] },
  { id: "rider", label: "Rider", mac: ["Rider.app"], commands: ["rider"] },
  { id: "clion", label: "CLion", mac: ["CLion.app"], commands: ["clion"] },
  { id: "android-studio", label: "Android Studio", mac: ["Android Studio.app"], commands: ["android-studio", "studio"] },
  { id: "nova", label: "Nova", mac: ["Nova.app"], commands: ["nova"] },
  { id: "bbedit", label: "BBEdit", mac: ["BBEdit.app"], commands: ["bbedit"] },
  { id: "textmate", label: "TextMate", mac: ["TextMate.app"], commands: ["mate"] },
  { id: "macvim", label: "MacVim", mac: ["MacVim.app"], commands: ["mvim"] },
  { id: "neovide", label: "Neovide", mac: ["Neovide.app"], commands: ["neovide"] },
  { id: "notepad-plus-plus", label: "Notepad++", mac: [], commands: ["notepad++"], windows: ["Notepad++/notepad++.exe"] },
];
export interface EditorEnvironment {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
}
export interface InstalledEditor extends EditorTarget { readonly application: string }
export interface EditorPorts {
  readonly environment?: EditorEnvironment;
  readonly exists?: (path: string, directory: boolean) => Promise<boolean>;
  readonly launch?: (application: string, path: string, platform: NodeJS.Platform) => Promise<void>;
}

/** Resolves known app bundles on macOS or editor binaries on Windows/Linux. */
export async function discoverEditors(environment: EditorEnvironment, exists: NonNullable<EditorPorts["exists"]>): Promise<readonly InstalledEditor[]> {
  const { platform, home, env } = environment;
  const roots = platform === "darwin" ? ["/Applications", join(home, "Applications"), "/Applications/JetBrains Toolbox"]
    : platform === "win32" ? [env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs") : "", env.ProgramFiles, env["ProgramFiles(x86)"]].filter((value): value is string => !!value) : [];
  const found = await Promise.all(EDITORS.map(async (editor) => {
    const candidates = platform === "darwin" ? roots.flatMap((root) => editor.mac.map((app) => join(root, app)))
      : [...roots.flatMap((root) => (editor.windows ?? []).map((file) => join(root, file))),
        ...(env.PATH ?? "").split(platform === "win32" ? ";" : delimiter).filter((root) => isAbsolute(root)).flatMap((root) => editor.commands.map((command) => join(root, platform === "win32" ? `${command}.exe` : command)))];
    for (const application of candidates) if (await exists(application, platform === "darwin")) return { id: editor.id, label: editor.label, application };
    return undefined;
  }));
  return found.filter((editor): editor is InstalledEditor => editor !== undefined);
}

/** GUI executables stay independent of Rack's lifetime. macOS's launcher
 * returns a real launch result; other platforms report process creation.
 */
async function launchEditor(application: string, path: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "darwin") { await promisify(execFile)("/usr/bin/open", ["-a", application, path], { timeout: 15_000 }); return; }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(application, [path], { detached: true, stdio: "ignore", shell: false });
    child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export class DesktopEditors {
  private readonly environment: EditorEnvironment;
  private readonly exists: NonNullable<EditorPorts["exists"]>;
  private readonly launch: NonNullable<EditorPorts["launch"]>;
  constructor(ports: EditorPorts = {}) {
    this.environment = ports.environment ?? { platform: process.platform, home: homedir(), env: process.env };
    this.exists = ports.exists ?? (async (path, directory) => {
      try { const info = await stat(path); if (directory) return info.isDirectory(); await access(path, constants.X_OK); return info.isFile(); } catch { return false; }
    });
    this.launch = ports.launch ?? launchEditor;
  }
  async list(): Promise<readonly EditorTarget[]> { return (await discoverEditors(this.environment, this.exists)).map(({ id, label }) => ({ id, label })); }
  /** Re-discovery prevents client-supplied commands and stale installation paths. */
  async open(request: OpenEditorRequest, choose?: () => Promise<string | undefined>): Promise<OpenEditorResult> {
    const path = resolveClickedPath(request.path, request.base);
    if (!path) return "invalid";
    try { const info = await stat(path); if (!info.isFile() && !info.isDirectory()) return "invalid"; } catch { return "missing"; }
    let application: string | undefined;
    if (request.editorId === "choose") {
      application = await choose?.();
      if (!application) return "cancelled";
      if (!isAbsolute(application) || !await this.exists(application, this.environment.platform === "darwin")) return "invalid";
      if (this.environment.platform === "darwin" && !application.endsWith(".app")) return "invalid";
    } else application = (await discoverEditors(this.environment, this.exists)).find((editor) => editor.id === request.editorId)?.application;
    if (!application) return "unavailable";
    try { await this.launch(application, path, this.environment.platform); return "opened"; } catch { return "unavailable"; }
  }
}
