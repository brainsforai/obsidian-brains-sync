# Brains Sync — Obsidian Plugin

Bidirectional sync between your [Obsidian](https://obsidian.md) vault and a [Brains](https://usebrains.app) wiki instance.

## Features

- **Pull from Brains** — fetches all wiki pages via the Brains API and writes them into a configurable vault subfolder (`brains/` by default).
- **Push to Brains** — scans the vault subfolder for markdown files and syncs each one back (updates existing pages, creates new ones).
- **Remote-wins** on pull (V1): pulling always overwrites local copies with the server version.
- **Sync log** — a sidebar Notice summarises every operation and logs details to the developer console.

## Requirements

- Obsidian ≥ 1.11.4 (desktop and mobile)
- A [Brains](https://usebrains.app) account (sign in with **Connect to Brains** — no manual token needed)

## Installation

### Manual (developer install)

1. Build the plugin:
   ```bash
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

Open **Settings → Brains Sync**:

| Field | Description | Default |
|---|---|---|
| Brains instance URL | Base URL of your Brains deployment | `https://lets.usebrains.app` |
| Account | **Connect to Brains** — one-click OAuth2 sign-in | — |
| Vault folder | Subfolder where pages are synced | `brains` |
| API token (Advanced) | Optional Personal Access Token fallback for self-hosters | — |

Click **Connect to Brains** to sign in: your browser opens the Brains login, you approve, and Obsidian receives the access token automatically. Tokens (and any fallback PAT) are stored via Obsidian's `SecretStorage` and are **never** written to `data.json` or the vault.

## Usage

### Pull from Brains

- Click the **download** ribbon icon, or
- Open the Command Palette (`Cmd/Ctrl+P`) → **Brains Sync: Pull from Brains**

The first pull bootstraps from `GET /api/v1/export/download`. Later pulls use `GET /api/v1/pages` (name + revision index) and fetch only changed pages, writing them to `<vault-folder>/<page-name>.md`.

### Push to Brains

- Open the Command Palette → **Brains Sync: Push to Brains**

Every `.md` file under `<vault-folder>/` is read and synced back: existing pages are updated with a full-rewrite `PUT /api/v1/page`, and new pages are created with `POST /api/v1/pages`.

## Auth

Sign-in uses **OAuth 2.0 with PKCE** (authorization-code flow). Click **Connect to Brains**, approve in the browser, and the plugin exchanges the code for an access token + refresh token; the access token is refreshed automatically before it expires. All API requests send `Authorization: Bearer <token>`.

For self-hosted servers or non-OAuth setups, an optional **Personal Access Token** can be entered under **Settings → Brains Sync → Advanced**.

## License

MIT — see [LICENSE](LICENSE).
