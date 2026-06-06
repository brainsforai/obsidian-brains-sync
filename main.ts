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
}

const DEFAULT_SETTINGS: BrainsSettings = {
  instanceUrl: "https://lets.usebrains.app",
  vaultFolder: "brains",
};

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

// Obsidian's SecretStorage is not always reflected in the public type stubs;
// cast to this minimal interface where needed.
interface SecretStorageLike {
  store(key: string, value: string): Promise<void>;
  retrieve(key: string): Promise<string | null>;
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

    // Settings tab
    this.addSettingTab(new BrainsSettingTab(this.app, this));
  }

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
    // SecretStorage lives on vault in Obsidian ≥1.7; cast for older type stubs.
    const maybeVault = this.app.vault as unknown as {
      secretStorage?: SecretStorageLike;
    };
    return maybeVault.secretStorage ?? null;
  }

  async getApiKey(): Promise<string | null> {
    return (await this.secretStorage()?.retrieve("brains-api-key")) ?? null;
  }

  async storeApiKey(key: string): Promise<void> {
    await this.secretStorage()?.store("brains-api-key", key);
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
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      new Notice("Brains: No API key configured — open Settings → Brains Sync.");
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
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      new Notice("Brains: No API key configured — open Settings → Brains Sync.");
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

    new Setting(containerEl)
      .setName("API key")
      .setDesc(
        "Your Brains API key. Stored in Obsidian SecretStorage — never written to data.json.",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("paste your API key here");

        // Pre-fill if a key is already stored
        this.plugin
          .getApiKey()
          .then((key) => {
            if (key) text.setValue(key);
          })
          .catch(() => {
            // SecretStorage unavailable — silently ignore
          });

        text.onChange(async (value) => {
          await this.plugin.storeApiKey(value.trim());
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
  }
}
