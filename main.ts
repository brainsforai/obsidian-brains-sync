import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  debounce,
  requestUrl,
  type RequestUrlParam,
} from "obsidian";

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

type PollState = {
  path: string;
  revision?: string;
  noChange: number;
  timerId: number;
};

export default class BrainsPlugin extends Plugin {
  settings!: BrainsSettings;

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
    this.addSettingTab(new BrainsSettingTab(this.app, this));

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
    const access = await this.readSecret(SECRET_ACCESS);
    if (access) {
      const exp = this.settings.tokenExpiresAt ?? 0;
      if (Date.now() >= exp) {
        if (await this.refreshTokens()) {
          return this.readSecret(SECRET_ACCESS);
        }
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
      new Notice("Brains: connected ✓");
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
    } catch {
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

  // -------------------------------------------------------------------------
  // Pull: fetch all pages from Brains and write them into the vault folder
  // -------------------------------------------------------------------------

  async pullFromBrains(): Promise<void> {
    console.log("[Brains Sync] Pull: command invoked");
    new Notice("Brains: Pulling…");
    const apiKey = await this.getAuthToken();
    if (!apiKey) {
      new Notice(
        'Brains: not connected — run "Connect to Brains", or add a token in Settings → Brains Sync.',
      );
      return;
    }

    const base = this.baseUrl();
    const folder = this.settings.vaultFolder;
    const log: string[] = [];

    try {
      // 1. List all pages
      const listResp = await requestUrl({
        url: `${base}/api/v1/pages`,
        headers: this.apiHeaders(apiKey),
      } as RequestUrlParam);

      if (listResp.status !== 200) {
        new Notice(`Brains: Pull failed — server returned ${listResp.status}.`);
        return;
      }

      // Server shape: { ok: true, result: { pages: [{ name }], count, backend } }.
      // Tolerate a bare array, a result-as-array, or a legacy { pages } envelope.
      const body = listResp.json as
        | BrainsEnvelope<BrainsPageList | BrainsPage[]>
        | { pages?: BrainsPage[] }
        | BrainsPage[];
      let pages: BrainsPage[];
      if (Array.isArray(body)) {
        pages = body;
      } else if ("result" in body && body.result) {
        const r = body.result as BrainsPageList | BrainsPage[];
        pages = Array.isArray(r) ? r : (r.pages ?? []);
      } else {
        pages = (body as { pages?: BrainsPage[] }).pages ?? [];
      }

      if (pages.length === 0) {
        new Notice("Brains: No pages found on server.");
        return;
      }

      // 2. Ensure root folder exists
      if (!(await this.app.vault.adapter.exists(folder))) {
        await this.app.vault.createFolder(folder);
      }

      let written = 0;

      for (const page of pages) {
        try {
          const pageResp = await requestUrl({
            url: `${base}/api/v1/page?name=${encodeURIComponent(page.name)}`,
            headers: this.apiHeaders(apiKey),
          } as RequestUrlParam);

          if (pageResp.status !== 200) {
            log.push(`SKIP  ${page.name} (HTTP ${pageResp.status})`);
            continue;
          }

          // Server shape: { ok: true, result: { content, fileId, revision } }.
          const pageBody = pageResp.json as BrainsEnvelope<BrainsPageRead> | null;
          const page2 = pageBody?.result;
          const content =
            typeof page2?.content === "string" ? page2.content : "";

          const filePath = this.pageToFilePath(folder, page.name);
          await this.ensureParentDirs(filePath);
          // remote-wins: always overwrite (suppress the auto-push echo)
          this.suppressModify.add(filePath);
          await this.app.vault.adapter.write(filePath, content);
          written++;
          log.push(`PULL  ${page.name}`);
        } catch (pageErr) {
          log.push(`ERROR ${page.name}: ${(pageErr as Error).message}`);
        }
      }

      this.showSyncLog("Pull complete", written, pages.length, log);
    } catch (err) {
      new Notice(`Brains: Pull error — ${(err as Error).message}`);
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
      new Notice(
        'Brains: not connected — run "Connect to Brains", or add a token in Settings → Brains Sync.',
      );
      return;
    }

    const base = this.baseUrl();
    const folder = this.settings.vaultFolder;
    const log: string[] = [];

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

      let pushed = 0;
      // Progress notice we mutate in place so the long bulk run shows life.
      const progress = new Notice(`Brains: Pushing 0/${files.length}…`, 0);

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const res = await this.pushFile(file, apiKey, base, folder, log);
        if (res.ok) pushed++;
        progress.setMessage(`Brains: Pushing ${i + 1}/${files.length}… (${pushed} ok)`);
      }

      progress.hide();
      this.showSyncLog("Push complete", pushed, files.length, log);
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
      new Notice(
        'Brains: not connected — run "Connect to Brains", or add a token in Settings → Brains Sync.',
      );
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
