import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  debounce,
  requestUrl,
  type RequestUrlParam,
} from "obsidian";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BrainsSettings {
  instanceUrl: string;
  vaultFolder: string;
  // OAuth2/PKCE state (non-secret; tokens live in SecretStorage).
  oauthClientId?: string;
  tokenExpiresAt?: number; // epoch ms when the access token should be refreshed
  // Auto-sync
  autoPush: boolean; // push edited files after a quiet period
  autoPushDebounceMs: number; // idle time before an auto-push fires
  pullOnOpen: boolean; // when a synced note is opened, refresh it from the server first
  pollIntervalMin: number; // minutes between freshness polls of the open note
  revisionCache?: Record<string, string>; // pageName -> server revision seen on pull
}

const DEFAULT_SETTINGS: BrainsSettings = {
  instanceUrl: "https://lets.usebrains.app",
  vaultFolder: "brains",
  autoPush: true,
  autoPushDebounceMs: 10000,
  pullOnOpen: true,
  pollIntervalMin: 2,
};

// OAuth2 + PKCE constants. The redirect uses Obsidian's custom URI scheme so the
// authorization server can hand the code back to this plugin on desktop.
const OAUTH_PROTOCOL_ACTION = "brains-sync-auth";
const OAUTH_REDIRECT_URI = `obsidian://${OAUTH_PROTOCOL_ACTION}`;
const OAUTH_SCOPE = "wiki.read wiki.write";

// SecretStorage keys.
const SECRET_PAT = "brains-api-key";
const SECRET_ACCESS = "brains-access-token";
const SECRET_REFRESH = "brains-refresh-token";

interface BrainsTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface BrainsPage {
  name: string;
  revision?: string;
}

// The Brains HTTP API wraps every success response as { ok: true, result: ... }.
interface BrainsEnvelope<T> {
  ok?: boolean;
  result?: T;
  error?: string;
}

interface BrainsPageList {
  pages?: BrainsPage[];
  count?: number;
}

interface BrainsPageRead {
  content?: string;
  fileId?: string;
  revision?: string;
}

// Preview shape from POST /api/v1/import-zip/upload?execute=false.
interface BrainsImportPreview {
  newCount?: number;
  modifiedCount?: number;
  unchangedCount?: number;
  skippedCount?: number;
  deletedCount?: number;
}

// Async job envelope from POST .../upload?execute=true and GET /api/v1/jobs/{id}.
interface BrainsJob {
  status?: "queued" | "running" | "done" | "failed";
  error?: string;
  result?: {
    success?: boolean;
    appliedCount?: number;
    deletedCount?: number;
    failedCount?: number;
    failures?: Array<{ name: string; error: string }>;
    // import-preview job results (execute=false)
    totalEntries?: number;
    newCount?: number;
    modifiedCount?: number;
    unchangedCount?: number;
    skippedCount?: number;
  };
}

// System pages that export (includeSystem=false) never emits, so a pull never
// writes them into the vault. They must be excluded from the push archive diff,
// or every push would try to archive them as "removed".
const NON_ARCHIVABLE_PAGES = new Set(["index", "log"]);

// Server page where the running, timestamped sync report is appended.
const SYNC_LOG_PAGE = "history/page-sync-log";

// Obsidian's SecretStorage (App.secretStorage, since 1.11.4). The real methods
// are synchronous; keep the return types await-tolerant so this also works if a
// future build returns promises. Not always present in older type stubs, so we
// cast to this minimal shape.
interface SecretStorageLike {
  setSecret(id: string, secret: string): void | Promise<void>;
  getSecret(id: string): string | null | Promise<string | null>;
}

// ---------------------------------------------------------------------------
// PKCE helpers (Web Crypto — available in Obsidian's Electron runtime)
// ---------------------------------------------------------------------------

/** base64url-encode bytes with no padding (RFC 7636). */
function base64UrlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A URL-safe random string from `byteLength` random bytes (~1.33x chars). */
function randomUrlSafe(byteLength: number): string {
  const arr = new Uint8Array(byteLength);
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr);
}

/** S256 PKCE challenge: base64url(sha256(verifier)). */
async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

// Stop polling an open page after this many consecutive no-change checks.
const POLL_MAX_QUIET = 3;
const PULL_EXPORT_TIMEOUT_MS = 120_000;
const PULL_EXPORT_MAX_RETRIES = 3;

type PollState = {
  path: string;
  revision?: string;
  noChange: number;
  timerId: number;
};

export default class BrainsPlugin extends Plugin {
  settings!: BrainsSettings;
  private settingsTab: BrainsSettingTab | null = null;
  private pullStatusEl: HTMLElement | null = null;
  private authReachabilityIssue: string | null = null;

  // Auto-push bookkeeping
  private dirtyFiles = new Set<string>();
  private suppressModify = new Set<string>(); // paths we wrote programmatically
  private autoPushDebouncer!: ReturnType<typeof debounce>;

  // Pull-on-open + poll bookkeeping
  private activePoll: PollState | null = null;
  private windowFocused = true;

  async onload() {
    await this.loadSettings();
    this.rebuildAutoPushDebouncer();

    // Ribbon icon — quick access to Pull
    this.addRibbonIcon("download", "Pull from Brains", () => {
      this.pullFromBrains();
    });

    // Command: Pull from Brains
    this.addCommand({
      id: "pull-from-brains",
      name: "Pull from Brains",
      callback: () => this.pullFromBrains(),
    });

    // Command: Push to Brains
    this.addCommand({
      id: "push-to-brains",
      name: "Push to Brains",
      callback: () => this.pushToBrains(),
    });

    // Command: Push current file to Brains (fast single-file round-trip)
    this.addCommand({
      id: "push-current-file-to-brains",
      name: "Push current file to Brains",
      callback: () => this.pushCurrentFile(),
    });

    // Command: Connect to Brains (OAuth2 + PKCE sign-in)
    this.addCommand({
      id: "connect-to-brains",
      name: "Connect to Brains (sign in)",
      callback: () => this.startOAuthConnect(),
    });

    // Handle the OAuth redirect back into Obsidian (obsidian://brains-sync-auth).
    this.registerObsidianProtocolHandler(OAUTH_PROTOCOL_ACTION, (params) => {
      void this.handleOAuthCallback(params as Record<string, string>);
    });

    // Settings tab
    this.settingsTab = new BrainsSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.pullStatusEl = this.addStatusBarItem();
    this.pullStatusEl.setText("");
    this.pullStatusEl.style.display = "none";

    // --- Auto-sync wiring ---------------------------------------------------
    // Typing and saves both mark the file dirty and (re)arm the push debounce.
    this.registerEvent(
      this.app.workspace.on("editor-change", () => this.onEditorActivity()),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.onVaultModify(file)),
    );

    // Pull-on-open + start the focused poll for the newly active note.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => void this.onFileOpen(file)),
    );

    // Focus gating: only poll while the window is focused; re-arm on refocus.
    this.registerDomEvent(window, "focus", () => {
      this.windowFocused = true;
      if (this.activePoll) this.activePoll.noChange = 0; // re-arm an idle poll
    });
    this.registerDomEvent(window, "blur", () => {
      this.windowFocused = false;
    });

    // Kick off pull-on-open for whatever is already open at load.
    this.app.workspace.onLayoutReady(() => {
      void this.onFileOpen(this.app.workspace.getActiveFile());
    });
  }

  onunload() {
    this.stopPoll();
  }

  rebuildAutoPushDebouncer(): void {
    this.autoPushDebouncer = debounce(
      () => void this.flushAutoPush(),
      this.settings.autoPushDebounceMs,
      true, // reset the timer on every new edit (true idle-gap behavior)
    );
  }

  // -------------------------------------------------------------------------
  // Auto-sync: debounced push on edit, pull-on-open, focused poll
  // -------------------------------------------------------------------------

  /** True for markdown files that live under the configured sync folder. */
  private isSyncedMd(file: TFile | null): file is TFile {
    return (
      !!file &&
      file.extension === "md" &&
      file.path.startsWith(this.settings.vaultFolder + "/")
    );
  }

  private onEditorActivity(): void {
    if (!this.settings.autoPush) return;
    const file = this.app.workspace.getActiveFile();
    if (this.isSyncedMd(file)) this.markDirty(file);
  }

  private onVaultModify(file: unknown): void {
    if (!this.settings.autoPush) return;
    if (!(file instanceof TFile) || !this.isSyncedMd(file)) return;
    // Ignore the modify event caused by our own programmatic write.
    if (this.suppressModify.has(file.path)) {
      this.suppressModify.delete(file.path);
      return;
    }
    this.markDirty(file);
  }

  private markDirty(file: TFile): void {
    this.dirtyFiles.add(file.path);
    this.autoPushDebouncer();
  }

  /** Push everything that has gone quiet since the last edit. */
  private async flushAutoPush(): Promise<void> {
    if (this.dirtyFiles.size === 0) return;
    const paths = Array.from(this.dirtyFiles);
    this.dirtyFiles.clear();

    const apiKey = await this.getAuthToken();
    if (!apiKey) {
      // Re-queue so a later Connect doesn't drop the edits silently.
      paths.forEach((p) => this.dirtyFiles.add(p));
      new Notice("Brains: auto-push skipped — not connected.");
      return;
    }

    const base = this.baseUrl();
    const folder = this.settings.vaultFolder;
    const log: string[] = [];
    let pushed = 0;

    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const res = await this.pushFile(file, apiKey, base, folder, log);
      if (res.ok) {
        pushed++;
        // Keep the open poll's revision in sync so we don't see our own write.
        if (this.activePoll?.path === path && res.revision) {
          this.activePoll.revision = res.revision;
        }
      }
    }

    if (pushed > 0 || log.some((l) => !l.startsWith("PUSH"))) {
      const failed = log.filter(
        (l) => l.startsWith("FAIL") || l.startsWith("ERROR"),
      ).length;
      new Notice(
        `Brains: auto-pushed ${pushed}/${paths.length}` +
          (failed ? ` — ⚠ ${failed} failed` : " ✓"),
      );
    }
    console.log(`[Brains Sync] Auto-push (${pushed}/${paths.length}):\n${log.join("\n")}`);
  }

  /**
   * Fetch one page and refresh the local file if the server copy differs.
   * Sends If-None-Match so a future ETag-aware server can answer 304 cheaply.
   * Never overwrites a file with pending local edits (returns "conflict").
   */
  private async pullFile(
    file: TFile,
    apiKey: string,
    base: string,
    folder: string,
    knownRevision?: string,
  ): Promise<{ status: "updated" | "unchanged" | "conflict" | "missing" | "error"; revision?: string }> {
    const pageName = this.filePathToPageName(folder, file.path);
    try {
      const headers = this.apiHeaders(apiKey);
      if (knownRevision) headers["If-None-Match"] = knownRevision;
      const resp = await requestUrl({
        url: `${base}/api/v1/page?name=${encodeURIComponent(pageName)}`,
        headers,
        throw: false,
      } as RequestUrlParam);

      if (resp.status === 304) return { status: "unchanged", revision: knownRevision };
      if (resp.status === 404) return { status: "missing" };
      if (resp.status !== 200) return { status: "error" };

      const remote = (resp.json as BrainsEnvelope<BrainsPageRead> | null)?.result;
      const remoteContent = typeof remote?.content === "string" ? remote.content : "";
      const revision = remote?.revision;
      const localContent = await this.app.vault.read(file);

      if (remoteContent === localContent) return { status: "unchanged", revision };
      if (this.dirtyFiles.has(file.path)) return { status: "conflict", revision };

      this.suppressModify.add(file.path);
      await this.app.vault.adapter.write(file.path, remoteContent);
      return { status: "updated", revision };
    } catch {
      return { status: "error" };
    }
  }

  /** On opening a synced note: refresh it from the server, then start polling. */
  async onFileOpen(file: TFile | null): Promise<void> {
    this.stopPoll();
    if (!this.isSyncedMd(file)) return;
    if (!this.settings.pullOnOpen) return;

    const apiKey = await this.getAuthToken();
    if (!apiKey) return;

    const res = await this.pullFile(file, apiKey, this.baseUrl(), this.settings.vaultFolder);
    if (res.status === "updated") new Notice(`Brains: refreshed ${file.name} from server`);
    else if (res.status === "conflict") {
      new Notice(`Brains: ${file.name} differs on server — local edits pending`);
    }
    this.startPoll(file, res.revision);
  }

  private startPoll(file: TFile, revision?: string): void {
    const intervalMs = Math.max(30_000, this.settings.pollIntervalMin * 60_000);
    const timerId = window.setInterval(() => void this.pollTick(file), intervalMs);
    this.registerInterval(timerId);
    this.activePoll = { path: file.path, revision, noChange: 0, timerId };
  }

  private stopPoll(): void {
    if (this.activePoll) {
      window.clearInterval(this.activePoll.timerId);
      this.activePoll = null;
    }
  }

  private async pollTick(file: TFile): Promise<void> {
    const poll = this.activePoll;
    if (!poll || poll.path !== file.path) return;
    // Focus-gate: don't poll a backgrounded window or a non-active note.
    if (!this.windowFocused) return;
    if (this.app.workspace.getActiveFile()?.path !== file.path) return;

    const apiKey = await this.getAuthToken();
    if (!apiKey) return;

    const res = await this.pullFile(
      file,
      apiKey,
      this.baseUrl(),
      this.settings.vaultFolder,
      poll.revision,
    );

    // The active poll may have changed while we awaited.
    if (this.activePoll !== poll || poll.path !== file.path) return;

    if (res.status === "updated") {
      poll.revision = res.revision ?? poll.revision;
      poll.noChange = 0;
      new Notice(`Brains: refreshed ${file.name} from server`);
    } else {
      if (res.revision) poll.revision = res.revision;
      poll.noChange++;
      if (poll.noChange >= POLL_MAX_QUIET) {
        console.log(
          `[Brains Sync] Poll: ${POLL_MAX_QUIET} quiet checks on ${file.name} — stopping`,
        );
        this.stopPoll();
      }
    }
  }

  // In-memory PKCE state for an in-progress authorization (not persisted; a
  // mid-flow plugin reload simply requires re-clicking Connect).
  private pendingAuth: { verifier: string; state: string } | null = null;

  // -------------------------------------------------------------------------
  // Settings persistence
  // -------------------------------------------------------------------------

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // -------------------------------------------------------------------------
  // Secret storage helpers
  // -------------------------------------------------------------------------

  private secretStorage(): SecretStorageLike | null {
    // SecretStorage lives on App (app.secretStorage), since Obsidian 1.11.4.
    const maybeApp = this.app as unknown as {
      secretStorage?: SecretStorageLike;
    };
    return maybeApp.secretStorage ?? null;
  }

  /** Read a secret by id (await-tolerant of the sync API). */
  private async readSecret(id: string): Promise<string | null> {
    const store = this.secretStorage();
    if (!store) return null;
    return (await store.getSecret(id)) ?? null;
  }

  /** Write a secret by id. */
  private async writeSecret(id: string, value: string): Promise<void> {
    await this.secretStorage()?.setSecret(id, value);
  }

  async getApiKey(): Promise<string | null> {
    return this.readSecret(SECRET_PAT);
  }

  async storeApiKey(key: string): Promise<void> {
    await this.writeSecret(SECRET_PAT, key);
  }

  // -------------------------------------------------------------------------
  // OAuth2 + PKCE
  // -------------------------------------------------------------------------

  /** True if an OAuth access token is currently stored. */
  async isConnected(): Promise<boolean> {
    return !!(await this.readSecret(SECRET_ACCESS));
  }

  /**
   * Resolve the bearer token to use for API calls: a fresh OAuth access token
   * (refreshing if it is near expiry) when connected, otherwise the manual PAT.
   */
  private async getAuthToken(): Promise<string | null> {
    this.authReachabilityIssue = null;
    const access = await this.readSecret(SECRET_ACCESS);
    if (access) {
      const exp = this.settings.tokenExpiresAt ?? 0;
      if (Date.now() >= exp) {
        if (await this.refreshTokens()) {
          return this.readSecret(SECRET_ACCESS);
        }
        if (this.authReachabilityIssue) return null;
        // Refresh failed — fall through to the PAT fallback below.
      } else {
        return access;
      }
    }
    return this.getApiKey();
  }

  /** Register a dynamic OAuth client once and cache the client_id in settings. */
  private async ensureClientId(): Promise<string | null> {
    if (this.settings.oauthClientId) return this.settings.oauthClientId;
    try {
      const resp = await requestUrl({
        url: `${this.baseUrl()}/oauth/register`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        throw: false,
        body: JSON.stringify({
          redirect_uris: [OAUTH_REDIRECT_URI],
          client_name: "Brains Sync (Obsidian)",
        }),
      } as RequestUrlParam);
      if (resp.status !== 200 && resp.status !== 201) {
        new Notice(`Brains: client registration failed (HTTP ${resp.status}).`);
        return null;
      }
      const clientId = (resp.json as { client_id?: string })?.client_id;
      if (!clientId) {
        new Notice("Brains: registration returned no client_id.");
        return null;
      }
      this.settings.oauthClientId = clientId;
      await this.saveSettings();
      return clientId;
    } catch (err) {
      new Notice(`Brains: registration error — ${(err as Error).message}`);
      return null;
    }
  }

  /** Begin the OAuth sign-in: build a PKCE challenge and open the browser. */
  async startOAuthConnect(): Promise<void> {
    if (!this.baseUrl()) {
      new Notice("Brains: set the instance URL first.");
      return;
    }
    const clientId = await this.ensureClientId();
    if (!clientId) return;

    const verifier = randomUrlSafe(32);
    const state = randomUrlSafe(16);
    const challenge = await pkceChallenge(verifier);
    this.pendingAuth = { verifier, state };

    const url =
      `${this.baseUrl()}/oauth/authorize?response_type=code` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}` +
      `&code_challenge=${encodeURIComponent(challenge)}` +
      `&code_challenge_method=S256` +
      `&scope=${encodeURIComponent(OAUTH_SCOPE)}` +
      `&state=${encodeURIComponent(state)}`;

    window.open(url, "_blank");
    new Notice("Brains: complete sign-in in your browser, then return to Obsidian.");
  }

  /** Handle the obsidian://brains-sync-auth redirect and exchange the code. */
  async handleOAuthCallback(params: Record<string, string>): Promise<void> {
    if (params.error) {
      new Notice(`Brains: sign-in failed — ${params.error_description ?? params.error}`);
      return;
    }
    const pending = this.pendingAuth;
    if (!pending || params.state !== pending.state) {
      new Notice("Brains: sign-in state mismatch — please try Connect again.");
      return;
    }
    if (!params.code) {
      new Notice("Brains: no authorization code returned.");
      return;
    }
    const clientId = this.settings.oauthClientId;
    if (!clientId) {
      new Notice("Brains: missing client_id — please try Connect again.");
      return;
    }

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: OAUTH_REDIRECT_URI,
      client_id: clientId,
      code_verifier: pending.verifier,
    }).toString();

    try {
      const resp = await requestUrl({
        url: `${this.baseUrl()}/oauth/token`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        throw: false,
        body: form,
      } as RequestUrlParam);
      const json = resp.json as BrainsTokenResponse | null;
      if (resp.status !== 200 || !json?.access_token) {
        new Notice(
          `Brains: token exchange failed — ${json?.error_description ?? json?.error ?? `HTTP ${resp.status}`}.`,
        );
        return;
      }
      await this.storeTokens(json);
      this.settingsTab?.display();
      new Notice("Brains: sign-in complete — connected ✓");
    } catch (err) {
      new Notice(`Brains: token exchange error — ${(err as Error).message}`);
    } finally {
      this.pendingAuth = null;
    }
  }

  /** Exchange a refresh token for a new access token. Returns success. */
  private async refreshTokens(): Promise<boolean> {
    const refresh = await this.readSecret(SECRET_REFRESH);
    const clientId = this.settings.oauthClientId;
    if (!refresh || !clientId) return false;

    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: clientId,
    }).toString();

    try {
      const resp = await requestUrl({
        url: `${this.baseUrl()}/oauth/token`,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        throw: false,
        body: form,
      } as RequestUrlParam);
      const json = resp.json as BrainsTokenResponse | null;
      if (resp.status !== 200 || !json?.access_token) {
        // Refresh token is dead — clear it so the UI prompts a re-connect.
        await this.clearTokens();
        return false;
      }
      await this.storeTokens(json);
      return true;
    } catch (err) {
      if (this.isUnreachableError(err)) {
        this.authReachabilityIssue = this.baseUrl();
      }
      return false;
    }
  }

  /** Persist access + refresh tokens and the refresh deadline (60s of slack). */
  private async storeTokens(t: BrainsTokenResponse): Promise<void> {
    if (t.access_token) await this.writeSecret(SECRET_ACCESS, t.access_token);
    if (t.refresh_token) await this.writeSecret(SECRET_REFRESH, t.refresh_token);
    const ttl = typeof t.expires_in === "number" ? t.expires_in : 3600;
    this.settings.tokenExpiresAt = Date.now() + Math.max(0, ttl - 60) * 1000;
    await this.saveSettings();
  }

  /** Forget all OAuth tokens (does not touch the manual PAT). */
  async clearTokens(): Promise<void> {
    await this.writeSecret(SECRET_ACCESS, "");
    await this.writeSecret(SECRET_REFRESH, "");
    this.settings.tokenExpiresAt = undefined;
    await this.saveSettings();
  }

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  private apiHeaders(apiKey: string): Record<string, string> {
    // PATs (and OAuth/Supabase tokens) authenticate via the Authorization
    // header. The `x-api-key` header is only honored for the server-level
    // BRAINS_API_KEY, never for user tokens.
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private baseUrl(): string {
    return this.settings.instanceUrl.replace(/\/$/, "");
  }

  private isTransientNetworkError(err: unknown): boolean {
    const msg = (err as Error)?.message ?? "";
    return /(ERR_NETWORK_CHANGED|network crashed|ECONNRESET|ETIMEDOUT|timed out|socket hang up)/i.test(
      msg,
    );
  }

  private isUnreachableError(err: unknown): boolean {
    const msg = (err as Error)?.message ?? "";
    return /network|ENOTFOUND|ECONNREFUSED|failed to fetch|ERR_|timeout|timed out/i.test(msg);
  }

  private showAuthMissingNotice(): void {
    if (this.authReachabilityIssue) {
      new Notice(`Brains: cannot reach ${this.authReachabilityIssue} — check the instance URL.`);
      return;
    }
    new Notice(
      'Brains: not connected — run "Connect to Brains", or add a token in Settings → Brains Sync.',
    );
  }

  private setPullStatus(text: string): void {
    if (!this.pullStatusEl) return;
    this.pullStatusEl.style.display = "";
    this.pullStatusEl.setText(text);
  }

  private clearPullStatus(): void {
    if (!this.pullStatusEl) return;
    this.pullStatusEl.setText("");
    this.pullStatusEl.style.display = "none";
  }

  // -------------------------------------------------------------------------
  // Pull: fetch all pages from Brains and write them into the vault folder
  // -------------------------------------------------------------------------

  async pullFromBrains(): Promise<void> {
    console.log("[Brains Sync] Pull: command invoked");
    new Notice("Brains: Pulling…");
    this.setPullStatus("Brains: Pulling…");
    const apiKey = await this.getAuthToken();
    if (!apiKey) {
      this.clearPullStatus();
      this.showAuthMissingNotice();
      return;
    }

    const base = this.baseUrl();
    const folder = this.settings.vaultFolder;
    const log: string[] = [];

    try {
      const index = await this.listServerPageIndex(base, apiKey);
      if (index.length === 0) {
        const bootstrap = await this.pullFromExportBootstrap(base, apiKey, folder, log);
        if (bootstrap.total > 0) {
          this.settings.revisionCache = bootstrap.revisions;
          await this.saveSettings();
          this.showSyncLog("Pull complete", bootstrap.written, bootstrap.total, log);
          new Notice(`Brains: Pull complete — ${bootstrap.written}/${bootstrap.total} pages.`);
        }
        return;
      }

      const known = this.settings.revisionCache ?? {};
      const hasRevisionsInIndex = index.some((p) => !!p.revision);
      if (!hasRevisionsInIndex || Object.keys(known).length === 0) {
        const bootstrap = await this.pullFromExportBootstrap(base, apiKey, folder, log);
        if (bootstrap.total > 0) {
          this.settings.revisionCache = bootstrap.revisions;
          await this.saveSettings();
          this.showSyncLog("Pull complete", bootstrap.written, bootstrap.total, log);
          new Notice(`Brains: Pull complete — ${bootstrap.written}/${bootstrap.total} pages.`);
        }
        return;
      }

      if (!(await this.app.vault.adapter.exists(folder))) {
        await this.app.vault.createFolder(folder);
      }

      const toFetch = index.filter((p) => !p.revision || known[p.name] !== p.revision);
      if (toFetch.length === 0) {
        const nextCache: Record<string, string> = {};
        for (const page of index) {
          if (page.revision) nextCache[page.name] = page.revision;
        }
        this.settings.revisionCache = nextCache;
        await this.saveSettings();
        new Notice("Brains: Pull complete — already up to date.");
        return;
      }

      let applied = 0;
      const nextCache: Record<string, string> = { ...known };
      for (let i = 0; i < toFetch.length; i++) {
        const page = toFetch[i];
        this.setPullStatus(`Brains: Pulling… (${i + 1}/${toFetch.length})`);
        const res = await this.pullPageByName(
          page.name,
          apiKey,
          base,
          folder,
          known[page.name],
        );
        if (res.status === "updated" || res.status === "created") {
          applied++;
          log.push(`PULL  ${page.name}.md`);
        } else if (res.status === "conflict") {
          log.push(`FAIL  ${page.name} (local edits pending)`);
        } else if (res.status === "error") {
          log.push(`ERROR ${page.name}: fetch failed`);
        }
        const rev = res.revision ?? page.revision;
        if (rev) nextCache[page.name] = rev;
      }

      for (const page of index) {
        if (page.revision) nextCache[page.name] = page.revision;
      }
      this.settings.revisionCache = nextCache;
      await this.saveSettings();
      this.showSyncLog("Pull complete", applied, toFetch.length, log);
      new Notice(`Brains: Pull complete — ${applied}/${toFetch.length} pages updated.`);
    } catch (err) {
      if (this.isUnreachableError(err)) {
        new Notice(`Brains: cannot reach ${base} — check the instance URL.`);
      } else {
        new Notice(`Brains: Pull error — ${(err as Error).message}`);
      }
    } finally {
      this.clearPullStatus();
    }
  }

  // -------------------------------------------------------------------------
  // Push: scan vault folder and PATCH each file back to Brains
  // -------------------------------------------------------------------------

  async pushToBrains(): Promise<void> {
    console.log("[Brains Sync] Push: command invoked");
    new Notice("Brains: Pushing…");
    const apiKey = await this.getAuthToken();
    if (!apiKey) {
      this.showAuthMissingNotice();
      return;
    }

    const base = this.baseUrl();
    const folder = this.settings.vaultFolder;

    try {
      if (!(await this.app.vault.adapter.exists(folder))) {
        new Notice(`Brains: Folder "${folder}" not found. Run Pull first.`);
        return;
      }

      const files = this.app.vault
        .getFiles()
        .filter((f) => f.path.startsWith(folder + "/") && f.extension === "md");

      if (files.length === 0) {
        new Notice(`Brains: No markdown files found in "${folder}".`);
        return;
      }

      // 1. Zip the vault folder. Entry paths are server page paths with the
      //    folder prefix stripped, e.g. "canonical/topic.md".
      const entries: Record<string, Uint8Array> = {};
      const vaultPageNames = new Set<string>();
      for (const file of files) {
        const content = await this.app.vault.read(file);
        const entryPath = file.path.slice(folder.length + 1); // strip "folder/"
        entries[entryPath] = strToU8(content);
        vaultPageNames.add(this.filePathToPageName(folder, file.path));
      }
      const zipBytes = zipSync(entries);

      // 2. Preview the import (no writes) to learn create/update counts.
      //    The server runs the preview as an async job (202 + jobId) to dodge
      //    the Railway gateway timeout on large wikis, so poll the job for the
      //    counts. Fall back to a synchronous { result } body for older servers.
      const preview = await this.uploadZip(base, apiKey, zipBytes, false);
      if (!preview) {
        new Notice("Brains: Push preview failed — no changes made.");
        return;
      }
      let addCount: number;
      let modCount: number;
      const previewJobId = (preview as { jobId?: string }).jobId;
      if (previewJobId) {
        const previewJob = await this.pollJob(base, apiKey, previewJobId);
        if (previewJob.status !== "done") {
          new Notice(
            `Brains: Push preview failed (${previewJob.error ?? "job did not complete"}) — no changes made.`,
          );
          return;
        }
        addCount = previewJob.result?.newCount ?? 0;
        modCount = previewJob.result?.modifiedCount ?? 0;
      } else {
        const previewResult =
          (preview as BrainsEnvelope<BrainsImportPreview>)?.result ?? {};
        addCount = previewResult.newCount ?? 0;
        modCount = previewResult.modifiedCount ?? 0;
      }

      // 3. Compute the archive set: server pages absent from the vault, minus
      //    system pages a pull never wrote (index/log) — otherwise every push
      //    would try to archive them.
      const serverPages = await this.listServerPageNames(base, apiKey);
      const toArchive = serverPages.filter(
        (name) => !vaultPageNames.has(name) && !NON_ARCHIVABLE_PAGES.has(name),
      );

      // 4. Dry-run confirm before any destructive (archive) activity.
      const proceed = await this.confirmSync(addCount, modCount, toArchive.length);
      if (!proceed) {
        new Notice("Brains: Push cancelled — no changes made.");
        return;
      }

      // 5. Execute the import (additive, overwrite) — the one atomic server-side
      //    step. If it fails we STOP before archiving anything: no partial replace.
      const execResp = await this.uploadZip(base, apiKey, zipBytes, true);
      const jobId = (execResp as { jobId?: string } | null)?.jobId;
      if (!jobId) {
        new Notice("Brains: Push failed — server did not start the import job. No changes made.");
        return;
      }
      const job = await this.pollJob(base, apiKey, jobId);
      if (job.status !== "done" || job.result?.success === false) {
        const reason = job.error ?? `${job.result?.failedCount ?? 0} page(s) failed`;
        new Notice(`Brains: Import failed (${reason}). Nothing archived — push aborted.`, 10000);
        return;
      }
      const applied = job.result?.appliedCount ?? addCount + modCount;

      // 6. Archive removed pages. Reversible (move to history/), so a per-page
      //    failure here loses nothing — it is reported, not fatal.
      const archived: string[] = [];
      const archiveFailures: string[] = [];
      for (const name of toArchive) {
        try {
          const resp = await requestUrl({
            url: `${base}/api/v1/page/move`,
            method: "POST",
            headers: this.apiHeaders(apiKey),
            throw: false,
            body: JSON.stringify({ name, action: "archive" }),
          } as RequestUrlParam);
          if (resp.status === 200) archived.push(name);
          else archiveFailures.push(`${name} (HTTP ${resp.status})`);
        } catch (moveErr) {
          archiveFailures.push(`${name}: ${(moveErr as Error).message}`);
        }
      }

      // 7. Audit the index (cleanup ghost rows / unindexed pages). Best-effort.
      let auditNote = "";
      try {
        const auditResp = await requestUrl({
          url: `${base}/api/v1/audit`,
          method: "POST",
          headers: this.apiHeaders(apiKey),
          throw: false,
          body: JSON.stringify({ cleanup: true }),
        } as RequestUrlParam);
        auditNote = auditResp.status === 200 ? "audit ok" : `audit HTTP ${auditResp.status}`;
      } catch (auditErr) {
        auditNote = `audit error: ${(auditErr as Error).message}`;
      }

      // 8. Append a timestamped report of every change to the growing sync-log
      //    page on the server.
      const pushedNames = [...vaultPageNames].sort();
      await this.appendSyncReport(base, apiKey, {
        applied,
        addCount,
        modCount,
        archived,
        archiveFailures,
        auditNote,
        pushedPages: pushedNames,
      });

      // 9. Report to the user.
      const summary: string[] = [
        `${addCount} added`,
        `${modCount} modified`,
        `${archived.length} archived`,
      ];
      if (archiveFailures.length > 0) summary.push(`${archiveFailures.length} archive failures`);
      const detail = [
        `Applied ${applied} page(s). ${auditNote}.`,
        ...archived.map((n) => `ARCHIVE ${n}`),
        ...archiveFailures.map((n) => `FAIL    ${n}`),
      ];
      this.showSyncLog(`Push complete — ${summary.join(", ")}`, applied, files.length, detail);
    } catch (err) {
      new Notice(`Brains: Push error — ${(err as Error).message}`);
    }
  }

  /**
   * Push a single vault file to Brains: read the page to get fileId+revision and
   * full-rewrite PUT it; create via POST if it doesn't exist yet. Appends a
   * PUSH/FAIL/ERROR line to `log` and returns the new server revision on success.
   */
  private async pushFile(
    file: TFile,
    apiKey: string,
    base: string,
    folder: string,
    log: string[],
  ): Promise<{ ok: boolean; revision?: string }> {
    const content = await this.app.vault.read(file);
    const pageName = this.filePathToPageName(folder, file.path);

    try {
      // Look up the page first: an existing page needs a full-rewrite PUT
      // (update_page requires fileId + revision); a missing page is created.
      const readResp = await requestUrl({
        url: `${base}/api/v1/page?name=${encodeURIComponent(pageName)}`,
        headers: this.apiHeaders(apiKey),
        throw: false,
      } as RequestUrlParam);

      let resp;
      if (readResp.status === 200) {
        const read = (
          readResp.json as BrainsEnvelope<BrainsPageRead> | null
        )?.result;
        if (!read?.fileId || !read?.revision) {
          log.push(`FAIL  ${pageName} (missing fileId/revision)`);
          return { ok: false };
        }
        resp = await requestUrl({
          url: `${base}/api/v1/page`,
          method: "PUT",
          headers: this.apiHeaders(apiKey),
          throw: false,
          body: JSON.stringify({
            name: pageName,
            fileId: read.fileId,
            revision: read.revision,
            body: content,
          }),
        } as RequestUrlParam);
      } else {
        resp = await requestUrl({
          url: `${base}/api/v1/pages`,
          method: "POST",
          headers: this.apiHeaders(apiKey),
          throw: false,
          body: JSON.stringify({
            name: pageName,
            title: this.pageNameToTitle(pageName),
            body: content,
          }),
        } as RequestUrlParam);
      }

      if (resp.status === 200 || resp.status === 201) {
        log.push(`PUSH  ${pageName}`);
        const revision = (resp.json as BrainsEnvelope<BrainsPageRead> | null)
          ?.result?.revision;
        return { ok: true, revision };
      }
      log.push(`FAIL  ${pageName} (HTTP ${resp.status})`);
      return { ok: false };
    } catch (fileErr) {
      log.push(`ERROR ${pageName}: ${(fileErr as Error).message}`);
      return { ok: false };
    }
  }

  /**
   * Push only the active note to Brains — a fast, observable round-trip for
   * verifying sync without grinding through the whole vault.
   */
  async pushCurrentFile(): Promise<void> {
    console.log("[Brains Sync] Push current file: command invoked");
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Brains: open a markdown note first.");
      return;
    }

    const folder = this.settings.vaultFolder;
    if (!file.path.startsWith(folder + "/")) {
      new Notice(`Brains: "${file.path}" is outside the "${folder}" sync folder.`);
      return;
    }

    const apiKey = await this.getAuthToken();
    if (!apiKey) {
      this.showAuthMissingNotice();
      return;
    }

    new Notice(`Brains: Pushing ${file.name}…`);
    const log: string[] = [];
    const res = await this.pushFile(file, apiKey, this.baseUrl(), folder, log);
    if (res.ok && this.activePoll?.path === file.path && res.revision) {
      this.activePoll.revision = res.revision; // keep the poll's ETag current
    }
    new Notice(
      res.ok
        ? `Brains: Pushed ${file.name} ✓`
        : `Brains: Push failed — ${log[0] ?? "unknown error"}`,
      8000,
    );
    console.log(`[Brains Sync] Push current file: ${log[0] ?? "(no result)"}`);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Convert a Brains page name (e.g. "projects/foo/bar") to a vault file path. */
  private pageToFilePath(folder: string, name: string): string {
    const normalized = name.endsWith(".md") ? name : `${name}.md`;
    return `${folder}/${normalized}`;
  }

  /** Convert a vault file path back to a Brains page name (no extension). */
  private filePathToPageName(folder: string, filePath: string): string {
    let name = filePath.slice(folder.length + 1); // strip "folder/"
    if (name.endsWith(".md")) name = name.slice(0, -3);
    return name;
  }

  /** Derive a human title from a page name's final path segment. */
  private pageNameToTitle(pageName: string): string {
    const last = pageName.split("/").pop() ?? pageName;
    const cleaned = last.replace(/[-_]+/g, " ").trim();
    return cleaned.length > 0 ? cleaned : pageName;
  }

  /** Ensure every intermediate directory in a file path exists in the vault. */
  private async ensureParentDirs(filePath: string): Promise<void> {
    const parts = filePath.split("/");
    parts.pop(); // remove filename
    let accumulated = "";
    for (const part of parts) {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(accumulated))) {
        await this.app.vault.createFolder(accumulated);
      }
    }
  }

  /**
   * Upload a ZIP to the bulk import endpoint. Both execute=false (preview) and
   * execute=true (import) start an async job and return { jobId }; poll it for
   * results. Older servers returned preview counts synchronously ({ result }).
   * Additive mode with overwrite so push is authoritative for page content.
   */
  private async uploadZip(
    base: string,
    apiKey: string,
    zipBytes: Uint8Array,
    execute: boolean,
  ): Promise<Record<string, unknown> | null> {
    // Copy into an exact-sized ArrayBuffer — fflate may return a view.
    const buffer = zipBytes.buffer.slice(
      zipBytes.byteOffset,
      zipBytes.byteOffset + zipBytes.byteLength,
    );
    const resp = await requestUrl({
      url: `${base}/api/v1/import-zip/upload?execute=${execute}&mode=additive&conflictStrategy=overwrite`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/zip",
      },
      throw: false,
      body: buffer,
    } as RequestUrlParam);

    // Preview returns 200; execute returns 202 (job queued).
    if (resp.status !== 200 && resp.status !== 202) return null;
    return resp.json as Record<string, unknown>;
  }

  /** Poll an async import job until it finishes (or fails / times out). */
  private async pollJob(
    base: string,
    apiKey: string,
    jobId: string,
    maxAttempts = 600,
    intervalMs = 500,
  ): Promise<BrainsJob> {
    for (let i = 0; i < maxAttempts; i++) {
      const resp = await requestUrl({
        url: `${base}/api/v1/jobs/${encodeURIComponent(jobId)}`,
        headers: this.apiHeaders(apiKey),
        throw: false,
      } as RequestUrlParam);
      if (resp.status === 200) {
        const job =
          (resp.json as BrainsEnvelope<BrainsJob>)?.result ??
          (resp.json as { job?: BrainsJob })?.job ??
          {};
        if (job.status === "done" || job.status === "failed") return job;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
    return { status: "failed", error: "timed out waiting for import job" };
  }

  private normalizeServerPages(payload: unknown): BrainsPage[] {
    const body = payload as
      | BrainsEnvelope<BrainsPageList | BrainsPage[]>
      | { pages?: BrainsPage[] }
      | BrainsPage[];
    if (Array.isArray(body)) return body;
    if ("result" in body && body.result) {
      const r = body.result as BrainsPageList | BrainsPage[];
      return Array.isArray(r) ? r : (r.pages ?? []);
    }
    return (body as { pages?: BrainsPage[] }).pages ?? [];
  }

  /** List all server page names, normalized without the .md extension. */
  private async listServerPageNames(base: string, apiKey: string): Promise<string[]> {
    const resp = await requestUrl({
      url: `${base}/api/v1/pages`,
      headers: this.apiHeaders(apiKey),
      throw: false,
    } as RequestUrlParam);
    if (resp.status !== 200) return [];
    return this.normalizeServerPages(resp.json).map((p) =>
      p.name.endsWith(".md") ? p.name.slice(0, -3) : p.name,
    );
  }

  private async listServerPageIndex(
    base: string,
    apiKey: string,
  ): Promise<Array<{ name: string; revision?: string }>> {
    const resp = await requestUrl({
      url: `${base}/api/v1/pages`,
      headers: this.apiHeaders(apiKey),
      throw: false,
    } as RequestUrlParam);
    if (resp.status !== 200) return [];
    return this.normalizeServerPages(resp.json).map((p) => ({
      name: p.name.endsWith(".md") ? p.name.slice(0, -3) : p.name,
      revision: p.revision,
    }));
  }

  private async pullPageByName(
    pageName: string,
    apiKey: string,
    base: string,
    folder: string,
    knownRevision?: string,
  ): Promise<{
    status: "updated" | "created" | "unchanged" | "conflict" | "missing" | "error";
    revision?: string;
  }> {
    try {
      const headers = this.apiHeaders(apiKey);
      if (knownRevision) headers["If-None-Match"] = knownRevision;
      const resp = await requestUrl({
        url: `${base}/api/v1/page?name=${encodeURIComponent(pageName)}`,
        headers,
        throw: false,
      } as RequestUrlParam);
      if (resp.status === 304) return { status: "unchanged", revision: knownRevision };
      if (resp.status === 404) return { status: "missing" };
      if (resp.status !== 200) return { status: "error" };

      const remote = (resp.json as BrainsEnvelope<BrainsPageRead> | null)?.result;
      const remoteContent = typeof remote?.content === "string" ? remote.content : "";
      const revision = remote?.revision;
      const filePath = this.pageToFilePath(folder, pageName);
      const existing = this.app.vault.getAbstractFileByPath(filePath);

      if (existing instanceof TFile) {
        const localContent = await this.app.vault.read(existing);
        if (remoteContent === localContent) return { status: "unchanged", revision };
        if (this.dirtyFiles.has(existing.path)) return { status: "conflict", revision };
        this.suppressModify.add(existing.path);
        await this.app.vault.adapter.write(existing.path, remoteContent);
        return { status: "updated", revision };
      }

      await this.ensureParentDirs(filePath);
      await this.app.vault.create(filePath, remoteContent);
      return { status: "created", revision };
    } catch {
      return { status: "error" };
    }
  }

  private async downloadExportZipWithRetry(
    base: string,
    apiKey: string,
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status?: number; error?: string }> {
    let lastError: string | undefined;
    let lastStatus: number | undefined;
    for (let attempt = 1; attempt <= PULL_EXPORT_MAX_RETRIES; attempt++) {
      try {
        const resp = await requestUrl({
          url: `${base}/api/v1/export/download`,
          headers: { Authorization: "Bearer " + apiKey },
          throw: false,
          timeout: PULL_EXPORT_TIMEOUT_MS,
        } as RequestUrlParam);
        if (resp.status === 200) {
          // Legacy synchronous export: the body is the zip.
          return { ok: true, bytes: new Uint8Array(resp.arrayBuffer) };
        }
        if (resp.status === 202) {
          // Async export: poll the job, then download the produced zip.
          const body = resp.json as { jobId?: string; downloadUrl?: string };
          if (!body?.jobId) {
            lastStatus = 202;
            return { ok: false, status: 202 };
          }
          const job = await this.pollJob(base, apiKey, body.jobId);
          if (job.status !== "done") {
            lastError = job.error ?? "export job did not complete";
            return { ok: false, error: lastError };
          }
          const downloadPath =
            body.downloadUrl ?? `/api/v1/jobs/${body.jobId}/download`;
          const dlResp = await requestUrl({
            url: `${base}${downloadPath}`,
            headers: { Authorization: "Bearer " + apiKey },
            throw: false,
            timeout: PULL_EXPORT_TIMEOUT_MS,
          } as RequestUrlParam);
          if (dlResp.status === 200) {
            return { ok: true, bytes: new Uint8Array(dlResp.arrayBuffer) };
          }
          lastStatus = dlResp.status;
          if (dlResp.status < 500 || attempt === PULL_EXPORT_MAX_RETRIES) {
            return { ok: false, status: dlResp.status };
          }
        } else {
          lastStatus = resp.status;
          if (resp.status < 500 || attempt === PULL_EXPORT_MAX_RETRIES) {
            return { ok: false, status: resp.status };
          }
        }
      } catch (err) {
        lastError = (err as Error).message;
        if (!this.isTransientNetworkError(err) || attempt === PULL_EXPORT_MAX_RETRIES) {
          return { ok: false, error: lastError };
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 600 * attempt));
    }
    return { ok: false, status: lastStatus, error: lastError };
  }

  private async pullFromExportBootstrap(
    base: string,
    apiKey: string,
    folder: string,
    log: string[],
  ): Promise<{ written: number; total: number; revisions: Record<string, string> }> {
    this.setPullStatus("Brains: Pulling… (bootstrap export)");
    const dl = await this.downloadExportZipWithRetry(base, apiKey);
    if (!dl.ok) {
      if (dl.status) new Notice(`Brains: Pull failed — server returned ${dl.status}.`);
      else new Notice(`Brains: Pull error — ${dl.error ?? "download failed"}`);
      return { written: 0, total: 0, revisions: {} };
    }

    const entries = unzipSync(dl.bytes);
    const pageNames = Object.keys(entries).filter((name) => name.endsWith(".md"));
    if (pageNames.length === 0) {
      new Notice("Brains: No pages found on server.");
      return { written: 0, total: 0, revisions: {} };
    }

    if (!(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.createFolder(folder);
    }

    let written = 0;
    for (let i = 0; i < pageNames.length; i++) {
      const name = pageNames[i];
      this.setPullStatus(`Brains: Pulling… (bootstrap ${i + 1}/${pageNames.length})`);
      try {
        const content = strFromU8(entries[name]);
        const filePath = `${folder}/${name}`;
        await this.ensureParentDirs(filePath);
        this.suppressModify.add(filePath);
        await this.app.vault.adapter.write(filePath, content);
        written++;
        log.push(`PULL  ${name}`);
      } catch (entryErr) {
        log.push(`ERROR ${name}: ${(entryErr as Error).message}`);
      }
    }

    const index = await this.listServerPageIndex(base, apiKey);
    const revisions: Record<string, string> = {};
    for (const page of index) {
      if (page.revision) revisions[page.name] = page.revision;
    }
    return { written, total: pageNames.length, revisions };
  }

  /** Modal confirm shown before any destructive (archive) push activity. */
  private confirmSync(
    addCount: number,
    modCount: number,
    archiveCount: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      new SyncConfirmModal(this.app, addCount, modCount, archiveCount, resolve).open();
    });
  }

  /**
   * Append a timestamped report of this push to the running sync-log page,
   * creating it on first run. Best-effort — a logging failure must not fail the
   * push itself.
   */
  private async appendSyncReport(
    base: string,
    apiKey: string,
    r: {
      applied: number;
      addCount: number;
      modCount: number;
      archived: string[];
      archiveFailures: string[];
      auditNote: string;
      pushedPages: string[];
    },
  ): Promise<void> {
    const ts = new Date().toISOString();
    const lines: string[] = [
      `## ${ts}`,
      "",
      `- Applied: ${r.applied} (added ${r.addCount}, modified ${r.modCount})`,
      `- Archived: ${r.archived.length}`,
      `- Audit: ${r.auditNote}`,
    ];
    if (r.pushedPages.length > 0) {
      lines.push("- Pushed pages:");
      lines.push(...r.pushedPages.map((n) => `  - ${n}`));
    }
    if (r.archived.length > 0) {
      lines.push("- Archived pages:");
      lines.push(...r.archived.map((n) => `  - ${n}`));
    }
    if (r.archiveFailures.length > 0) {
      lines.push("- Archive failures:");
      lines.push(...r.archiveFailures.map((n) => `  - ${n}`));
    }
    const block = lines.join("\n") + "\n";

    try {
      // Append if the page exists; otherwise create it.
      const read = await requestUrl({
        url: `${base}/api/v1/page?name=${encodeURIComponent(SYNC_LOG_PAGE)}`,
        headers: this.apiHeaders(apiKey),
        throw: false,
      } as RequestUrlParam);

      if (read.status === 200) {
        await requestUrl({
          url: `${base}/api/v1/page`,
          method: "PATCH",
          headers: this.apiHeaders(apiKey),
          throw: false,
          body: JSON.stringify({
            name: SYNC_LOG_PAGE,
            operations: [{ type: "append", text: `\n${block}` }],
          }),
        } as RequestUrlParam);
      } else {
        await requestUrl({
          url: `${base}/api/v1/pages`,
          method: "POST",
          headers: this.apiHeaders(apiKey),
          throw: false,
          body: JSON.stringify({
            name: SYNC_LOG_PAGE,
            title: "Page Sync Log",
            body: `# Page Sync Log\n\nTimestamped record of bulk pushes from the Obsidian plugin.\n\n${block}`,
          }),
        } as RequestUrlParam);
      }
    } catch {
      // Logging is best-effort; never fail the push over it.
    }
  }

  /** Display a sync summary in a Notice and in the dev console. */
  private showSyncLog(
    title: string,
    done: number,
    total: number,
    log: string[],
  ): void {
    const failures = log.filter((l) => l.startsWith("FAIL") || l.startsWith("ERROR"));
    const failSummary = failures.length > 0 ? ` — ⚠ ${failures.length} failed` : "";
    const preview = (failures.length > 0 ? failures : log).slice(0, 8).join("\n");
    const shown = failures.length > 0 ? failures.length : log.length;
    const overflow = shown > 8 ? `\n…and ${shown - 8} more` : "";
    new Notice(`Brains: ${title} — ${done}/${total} pages${failSummary}.\n${preview}${overflow}`, 8000);
    console.log(`[Brains Sync] ${title} (${done}/${total}):\n${log.join("\n")}`);
  }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class BrainsSettingTab extends PluginSettingTab {
  plugin: BrainsPlugin;

  constructor(app: App, plugin: BrainsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Brains Sync" });

    new Setting(containerEl)
      .setName("Brains instance URL")
      .setDesc("Base URL of your Brains instance (e.g. https://lets.usebrains.app).")
      .addText((text) =>
        text
          .setPlaceholder("https://lets.usebrains.app")
          .setValue(this.plugin.settings.instanceUrl)
          .onChange(async (value) => {
            this.plugin.settings.instanceUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // --- Account: one-click OAuth2 sign-in (no manual token) ---
    const accountSetting = new Setting(containerEl)
      .setName("Account")
      .setDesc("Checking connection…");
    void this.plugin.isConnected().then((connected) => {
      accountSetting.setDesc(
        connected
          ? "Connected to Brains via OAuth. Tokens refresh automatically."
          : "Not connected. Click Connect to sign in — no manual token needed.",
      );
      accountSetting.addButton((btn) => {
        if (connected) {
          btn
            .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              await this.plugin.clearTokens();
              this.display();
            });
        } else {
          btn
            .setButtonText("Connect to Brains")
            .setCta()
            .onClick(() => this.plugin.startOAuthConnect());
        }
      });
    });

    new Setting(containerEl)
      .setName("Vault folder")
      .setDesc(
        "Subfolder inside your vault where Brains pages are stored (default: brains).",
      )
      .addText((text) =>
        text
          .setPlaceholder("brains")
          .setValue(this.plugin.settings.vaultFolder)
          .onChange(async (value) => {
            this.plugin.settings.vaultFolder = value.trim() || "brains";
            await this.plugin.saveSettings();
          }),
      );

    // --- Auto-sync ---
    containerEl.createEl("h3", { text: "Auto-sync" });

    new Setting(containerEl)
      .setName("Auto-push on edit")
      .setDesc(
        "Push a note back to Brains automatically once you stop editing it for the delay below.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoPush).onChange(async (v) => {
          this.plugin.settings.autoPush = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Auto-push delay (seconds)")
      .setDesc("Idle time after your last keystroke/save before the note is pushed.")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(Math.round(this.plugin.settings.autoPushDebounceMs / 1000)))
          .onChange(async (value) => {
            const secs = Math.max(1, Number(value) || 10);
            this.plugin.settings.autoPushDebounceMs = secs * 1000;
            await this.plugin.saveSettings();
            this.plugin.rebuildAutoPushDebouncer();
          }),
      );

    new Setting(containerEl)
      .setName("Refresh on open")
      .setDesc(
        "When you open a synced note, pull the latest from Brains first (skipped if you have unsaved local edits).",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.pullOnOpen).onChange(async (v) => {
          this.plugin.settings.pullOnOpen = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Poll interval (minutes)")
      .setDesc(
        `While a note is open and focused, check Brains for updates this often. ` +
          `Stops after ${POLL_MAX_QUIET} unchanged checks; resumes on activity.`,
      )
      .addText((text) =>
        text
          .setPlaceholder("2")
          .setValue(String(this.plugin.settings.pollIntervalMin))
          .onChange(async (value) => {
            this.plugin.settings.pollIntervalMin = Math.max(0.5, Number(value) || 2);
            await this.plugin.saveSettings();
          }),
      );

    // --- Advanced: manual token fallback (self-hosters / non-OAuth setups) ---
    containerEl.createEl("h3", { text: "Advanced" });

    new Setting(containerEl)
      .setName("API token (fallback)")
      .setDesc(
        "Optional. A Personal Access Token, used only when not connected via OAuth above. " +
          "Stored in Obsidian SecretStorage — never written to data.json.",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("paste a Personal Access Token");

        // Pre-fill if a token is already stored.
        this.plugin
          .getApiKey()
          .then((key) => {
            if (key) text.setValue(key);
          })
          .catch(() => {
            // SecretStorage unavailable — silently ignore.
          });

        text.onChange(async (value) => {
          await this.plugin.storeApiKey(value.trim());
        });
      });
  }
}

// ---------------------------------------------------------------------------
// Push confirmation modal
// ---------------------------------------------------------------------------

/**
 * Dry-run confirmation shown before a bulk push. Surfaces the add/modify/archive
 * counts so the user approves destructive (archive) activity explicitly.
 */
class SyncConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private addCount: number,
    private modCount: number,
    private archiveCount: number,
    private done: (proceed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Push to Brains" });
    contentEl.createEl("p", { text: "Review the changes before pushing:" });

    const list = contentEl.createEl("ul");
    list.createEl("li", { text: `${this.addCount} page(s) added` });
    list.createEl("li", { text: `${this.modCount} page(s) modified` });
    list.createEl("li", {
      text: `${this.archiveCount} page(s) archived (moved to history/, reversible)`,
    });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const confirm = buttons.createEl("button", { text: "Push", cls: "mod-cta" });
    confirm.addEventListener("click", () => {
      this.resolved = true;
      this.done(true);
      this.close();
    });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.resolved = true;
      this.done(false);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    // Closing via Esc / click-outside counts as cancel.
    if (!this.resolved) this.done(false);
  }
}
