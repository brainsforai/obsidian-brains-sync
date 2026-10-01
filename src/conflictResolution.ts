/**
 * Pure, Obsidian-API-free pull-conflict decision logic.
 * Extracted from main.ts's pullFile / pullPageByName so it can be unit tested
 * without a running Obsidian instance.
 */

export type PullDecision = "unchanged" | "conflict" | "updated";

/**
 * Decide what a pull should do with an existing local file, given the remote
 * content just fetched and whether the local file has pending (unsynced) edits.
 *
 * Mirrors the guard order in main.ts: identical content always wins as
 * "unchanged" even if the file is marked dirty, and a dirty file only turns
 * into a conflict once the content has actually diverged from remote.
 */
export function decidePullOutcome(params: {
  localContent: string;
  remoteContent: string;
  isDirty: boolean;
}): PullDecision {
  const { localContent, remoteContent, isDirty } = params;
  if (remoteContent === localContent) return "unchanged";
  if (isDirty) return "conflict";
  return "updated";
}
