# Brains Sync — Obsidian Plugin

Bidirectional sync between your [Obsidian](https://obsidian.md) vault and a [Brains](https://usebrains.app) wiki instance.

## Features

- **Pull from Brains** — fetches all wiki pages via the Brains API and writes them into a configurable vault subfolder (`brains/` by default).
- **Push to Brains** — scans the vault subfolder for markdown files and PATCHes each one back to your Brains instance.
- **Remote-wins** on pull (V1): pulling always overwrites local copies with the server version.
- **Sync log** — a sidebar Notice summarises every operation and logs details to the developer console.

## Requirements

- Obsidian ≥ 1.4.0 (desktop only)
- A running [Brains](https://usebrains.app) instance with an API key

## Installation

### Manual (developer install)

1. Build the plugin:
   ```bash
   cd obsidian-plugin
   npm install
   npm run build
   ```
2. Copy `main.js` and `manifest.json` to your vault's plugin folder:
   ```
   <vault>/.obsidian/plugins/brains-sync/
   ```
3. Enable the plugin in **Settings → Community Plugins**.

### Community Plugin Registry

Once listed, search for **Brains Sync** in **Settings → Community Plugins → Browse**.

## Configuration

Open **Settings → Brains Sync** and fill in:

| Field | Description | Default |
|---|---|---|
| Brains instance URL | Base URL of your Brains deployment | `https://lets.usebrains.app` |
| API key | Your Brains API key (stored in Obsidian SecretStorage) | — |
| Vault folder | Subfolder where pages are synced | `brains` |

The API key is stored via Obsidian's `SecretStorage` and is **never** written to `data.json` or the vault.

## Usage

### Pull from Brains

- Click the **download** ribbon icon, or
- Open the Command Palette (`Cmd/Ctrl+P`) → **Brains Sync: Pull from Brains**

All pages are fetched from `GET /api/v1/pages` and written to `<vault-folder>/<page-name>.md`. Sub-paths (e.g. `projects/foo/bar`) become nested folders.

### Push to Brains

- Open the Command Palette → **Brains Sync: Push to Brains**

Every `.md` file under `<vault-folder>/` is read and sent via `PATCH /api/v1/page`.

## Auth

All HTTP requests use the `x-api-key: <key>` header. No OAuth flow is required for V1.

## License

MIT — see [LICENSE](LICENSE).
