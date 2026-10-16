import { resolve, win32 } from "node:path";

/** Compare local transcript folders using host path conventions. Windows history
 * can mix drive casing, separators and extended-length prefixes. This is lexical
 * identity only: it does not broaden discovery to child folders or worktrees.
 */
export function sameImportProject(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const normalize = (value: string) => {
    if (platform !== "win32") return resolve(value);
    return win32.resolve(value).replace(/^\\\\\?\\UNC\\/i, "\\\\")
      .replace(/^\\\\\?\\/, "").toLowerCase();
  };
  return normalize(a) === normalize(b);
}
