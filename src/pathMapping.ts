/**
 * Pure, Obsidian-API-free path <-> page name mapping.
 * Extracted from main.ts so it can be unit tested without a running Obsidian instance.
 */

/** Convert a Brains page name (e.g. "projects/foo/bar") to a vault file path. */
export function pageToFilePath(folder: string, name: string): string {
  const normalized = name.endsWith(".md") ? name : `${name}.md`;
  return `${folder}/${normalized}`;
}

/** Convert a vault file path back to a Brains page name (no extension). */
export function filePathToPageName(folder: string, filePath: string): string {
  let name = filePath.slice(folder.length + 1); // strip "folder/"
  if (name.endsWith(".md")) name = name.slice(0, -3);
  return name;
}

/** Derive a human title from a page name's final path segment. */
export function pageNameToTitle(pageName: string): string {
  const last = pageName.split("/").pop() ?? pageName;
  const cleaned = last.replace(/[-_]+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : pageName;
}
