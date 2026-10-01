import { describe, expect, it } from "vitest";
import { decidePushOutcome } from "../src/pushOutcome";

describe("decidePushOutcome", () => {
  // GH #1047: the exact shape from the live repro — one page intended to
  // change, the import job's result carries no appliedCount at all (older
  // server / a response shape the client didn't expect), and nothing was
  // actually written. The notice must not claim the push applied the
  // change just because that's what it intended to do.
  it("never falls back to the intended change count when appliedCount is missing", () => {
    const outcome = decidePushOutcome({ success: true }, 1);
    expect(outcome.appliedCount).toBe(0);
  });

  it("flags allFailed when pages were intended to change but none applied", () => {
    const outcome = decidePushOutcome({ success: true, appliedCount: 0 }, 1);
    expect(outcome.allFailed).toBe(true);
  });

  it("does not flag allFailed when at least one page applied", () => {
    const outcome = decidePushOutcome({ success: true, appliedCount: 1 }, 2);
    expect(outcome.allFailed).toBe(false);
  });

  it("does not flag allFailed when nothing was intended to change", () => {
    const outcome = decidePushOutcome(undefined, 0);
    expect(outcome.allFailed).toBe(false);
    expect(outcome.appliedCount).toBe(0);
  });

  it("surfaces failed-page names and reasons as failure lines", () => {
    const outcome = decidePushOutcome(
      {
        success: false,
        appliedCount: 0,
        failedCount: 1,
        failures: [{ name: "projects/x/open-loops.md", error: "already exists" }],
      },
      1,
    );
    expect(outcome.failureLines).toEqual(["projects/x/open-loops.md: already exists"]);
    expect(outcome.allFailed).toBe(true);
  });

  it("reports confirmed appliedCount exactly, even when it is 0 for a no-op push", () => {
    const outcome = decidePushOutcome({ success: true, appliedCount: 0 }, 0);
    expect(outcome.appliedCount).toBe(0);
    expect(outcome.allFailed).toBe(false);
  });
});
