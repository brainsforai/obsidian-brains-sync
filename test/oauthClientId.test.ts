import { describe, expect, it } from "vitest";
import { isClientIdValidForInstance, isUnknownClientIdError } from "../src/oauthClientId";

describe("isClientIdValidForInstance", () => {
  // Repro for GH #1046: a vault switches instanceUrl (e.g. production ->
  // staging). The plugin used to reuse `oauthClientId` unconditionally,
  // which is exactly the bug — a client_id minted by one Brains deployment
  // is unknown to another.
  it("rejects a client_id cached for a different instance", () => {
    const stored = { clientId: "mcpsrv_abc", instanceUrl: "https://lets.usebrains.app" };
    expect(isClientIdValidForInstance(stored, "https://brains-staging.up.railway.app")).toBe(false);
  });

  it("accepts a client_id cached for the current instance", () => {
    const stored = { clientId: "mcpsrv_abc", instanceUrl: "https://lets.usebrains.app" };
    expect(isClientIdValidForInstance(stored, "https://lets.usebrains.app")).toBe(true);
  });

  it("treats switching back to the original instance as valid again (no pointless re-registration)", () => {
    // After re-registering against staging, switching back to the instance
    // that originally issued stored.clientId is not re-validated here (the
    // plugin overwrites the cache on each switch) — but switching back to
    // whichever instance is currently cached must not force a re-register.
    const stored = { clientId: "mcpsrv_prod", instanceUrl: "https://lets.usebrains.app" };
    expect(isClientIdValidForInstance(stored, "https://lets.usebrains.app")).toBe(true);
  });

  it("treats no stored client_id as invalid for any instance", () => {
    expect(isClientIdValidForInstance(undefined, "https://lets.usebrains.app")).toBe(false);
    expect(isClientIdValidForInstance({}, "https://lets.usebrains.app")).toBe(false);
  });
});

describe("isUnknownClientIdError", () => {
  it("detects the generic fallback error shape the server returns for an unrecognized client_id", () => {
    expect(isUnknownClientIdError({ error: "Unknown client_id" })).toBe(true);
  });

  it("detects a standard invalid_client error_description naming an unknown client", () => {
    expect(isUnknownClientIdError({ error: "invalid_client", error_description: "unknown client_id" })).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isUnknownClientIdError({ error: "UNKNOWN CLIENT_ID" })).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isUnknownClientIdError({ error: "invalid_grant", error_description: "code expired" })).toBe(false);
    expect(isUnknownClientIdError(null)).toBe(false);
    expect(isUnknownClientIdError(undefined)).toBe(false);
  });
});
