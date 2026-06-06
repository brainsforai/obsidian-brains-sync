import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
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
}

const DEFAULT_SETTINGS: BrainsSettings = {
  instanceUrl: "https://lets.usebrains.app",
  vaultFolder: "brains",
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

export default class BrainsPlugin extends Plugin {
  settings!: BrainsSettings;

  async onload() {
    await this.loadSettings();

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
          // remote-wins: always overwrite
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

      for (const file of files) {
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
              continue;
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
            pushed++;
            log.push(`PUSH  ${pageName}`);
          } else {
            log.push(`FAIL  ${pageName} (HTTP ${resp.status})`);
          }
        } catch (fileErr) {
          log.push(`ERROR ${pageName}: ${(fileErr as Error).message}`);
        }
      }

      this.showSyncLog("Push complete", pushed, files.length, log);
    } catch (err) {
      new Notice(`Brains: Push error — ${(err as Error).message}`);
    }
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
    const preview = log.slice(0, 8).join("\n");
    const overflow = log.length > 8 ? `\n…and ${log.length - 8} more` : "";
    new Notice(`Brains: ${title} — ${done}/${total} pages.\n${preview}${overflow}`, 8000);
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
