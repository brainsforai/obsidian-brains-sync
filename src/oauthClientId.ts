/**
 * Pure helpers for the per-instance OAuth client_id lifecycle. Kept separate
 * from main.ts (which depends on the Obsidian runtime) so the recovery logic
 * is testable without mocking the plugin host.
 */

export interface StoredOAuthClient {
  clientId?: string;
  instanceUrl?: string;
}

/**
 * A cached client_id is only usable against the instance that issued it.
 * OAuth client registrations are per-instance, so a client_id minted by one
 * Brains deployment is unknown to another — treat any mismatch (including no
 * cached id at all) as "no client id", forcing a fresh registration.
 */
export function isClientIdValidForInstance(
  stored: StoredOAuthClient | undefined,
  currentInstanceUrl: string,
): boolean {
  return Boolean(stored?.clientId) && stored?.instanceUrl === currentInstanceUrl;
}

/** Shape of a token-endpoint (or generic) error body from a Brains instance. */
export interface OAuthErrorBody {
  error?: string;
  error_description?: string;
}

/** True when a token-endpoint error body names an unrecognized client_id. */
export function isUnknownClientIdError(json: OAuthErrorBody | null | undefined): boolean {
  const text = `${json?.error ?? ""} ${json?.error_description ?? ""}`.toLowerCase();
  return text.includes("unknown client");
}
