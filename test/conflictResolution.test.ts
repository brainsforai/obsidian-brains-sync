import { describe, expect, it } from "vitest";
import { decidePullOutcome } from "../src/conflictResolution";

describe("decidePullOutcome", () => {
  it("is unchanged when remote content matches local content", () => {
    const result = decidePullOutcome({
      localContent: "same",
      remoteContent: "same",
      isDirty: false,
    });
    expect(result).toBe("unchanged");
  });

  it("is unchanged even when the file is marked dirty, if content already matches", () => {
    // Guards against a local edit that was reverted back to the synced content
    // being reported as a conflict just because the dirty flag wasn't cleared.
    const result = decidePullOutcome({
      localContent: "same",
      remoteContent: "same",
      isDirty: true,
    });
    expect(result).toBe("unchanged");
  });

  it("is a conflict when content diverges and the local file has pending edits", () => {
    const result = decidePullOutcome({
      localContent: "local edit",
      remoteContent: "remote edit",
      isDirty: true,
    });
    expect(result).toBe("conflict");
  });

  it("is updated when content diverges but the local file has no pending edits", () => {
    const result = decidePullOutcome({
      localContent: "stale",
      remoteContent: "fresh",
      isDirty: false,
    });
    expect(result).toBe("updated");
  });
});
