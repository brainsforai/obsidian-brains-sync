// Whether a page has pending local edits a pull must not overwrite.
//
// GH #934: the old check was `dirtyFiles.has(path)` alone — an in-memory Set
// populated on modify and cleared on push. It knows nothing that happened
// before the plugin's current load, so a saved-but-unpushed edit that
// survived an Obsidian restart read as clean on the next pull and was
// silently overwritten.
//
// The in-memory signal still matters on its own: an edit sitting in the
// editor buffer, not yet saved to disk, moves no mtime at all. Neither
// signal subsumes the other, so both are kept.

export interface DirtyCheckInput {
  /** Flagged dirty this session via the in-memory `dirtyFiles` set. */
  inMemoryDirty: boolean;
  /** mtime recorded the last time this page's local content was known to match the server, or undefined if never recorded. */
  syncedMtime: number | undefined;
  /** The file's current on-disk mtime. */
  currentMtime: number;
}

export function isPageDirty(input: DirtyCheckInput): boolean {
  if (input.inMemoryDirty) return true;
  if (input.syncedMtime === undefined) return false;
  return input.currentMtime > input.syncedMtime;
}
