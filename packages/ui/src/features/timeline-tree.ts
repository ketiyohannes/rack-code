/**
 * Folder tree for historical paths, including unchanged snapshot members.
 * Kept free of DOM and icon
 * imports so it can be unit tested under Node.
 */
import type { TimelineChangedPath } from "@rack/contracts";

export interface TreeFolder<T extends { readonly path: string } = TimelineChangedPath> {
  readonly name: string;
  readonly path: string;
  readonly folders: TreeFolder<T>[];
  readonly files: T[];
}

/** Groups paths into folders; folders first, both sorted by name. */
export function buildTree<T extends { readonly path: string }>(files: readonly T[]): TreeFolder<T> {
  const root: TreeFolder<T> = { name: "", path: "", folders: [], files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const path = node.path === "" ? part : `${node.path}/${part}`;
      let child = node.folders.find((folder) => folder.name === part);
      if (child === undefined) {
        child = { name: part, path, folders: [], files: [] };
        node.folders.push(child);
      }
      node = child;
    }
    node.files.push(file);
  }
  const sort = (node: TreeFolder<T>) => {
    node.folders.sort((left, right) => left.name.localeCompare(right.name));
    node.files.sort((left, right) => left.path.localeCompare(right.path));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}
