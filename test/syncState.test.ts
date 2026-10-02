import { describe, expect, it } from "vitest";
import { isPageDirty } from "../src/syncState";

describe("isPageDirty", () => {
  it("is dirty when the in-memory set flags it, regardless of mtime", () => {
    expect(
      isPageDirty({ inMemoryDirty: true, syncedMtime: 1000, currentMtime: 500 }),
    ).toBe(true);
  });

  it("is not dirty when nothing was ever recorded as synced and the in-memory set is clear", () => {
    expect(
      isPageDirty({ inMemoryDirty: false, syncedMtime: undefined, currentMtime: 123 }),
    ).toBe(false);
  });

  it("is not dirty when the file's mtime has not moved past the last recorded sync point", () => {
    expect(
      isPageDirty({ inMemoryDirty: false, syncedMtime: 1000, currentMtime: 1000 }),
    ).toBe(false);
  });

  it("GH #934: is dirty when a saved-but-unpushed edit survives a restart — mtime moved past the last sync point even though the in-memory set was cleared", () => {
    expect(
      isPageDirty({ inMemoryDirty: false, syncedMtime: 1000, currentMtime: 2000 }),
    ).toBe(true);
  });
});
