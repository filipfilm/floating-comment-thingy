# 💬 FCT — Floating Comment Thingy

> Google Docs-style floating comments for your code — without modifying source files.

Leave comments on any line or selection of code, reply in threads, tag teammates with `@mentions`, and have comments follow your code across Git branches and commits. All without ever touching a source file.

---

## ✨ Features

### Core
- **🗨️ Native VS Code Comments** — Uses the built-in `vscode.comments` API. Comments appear inline in the gutter, just like a code review on GitHub.
- **✍️ Word-Level Precision** — Select a few words (not just a whole line) and comment on exactly that. When you navigate back to the comment, those exact words are re-highlighted.
- **💬 Threaded Replies** — Full reply threads. Every comment supports replies, edits, and deletes.
- **👁️ Hover to Peek** — Hover over any commented code to instantly preview the thread without clicking into it.

### Git-Aware Anchoring
- **🔀 Diff-Based Remapping** — Comments follow code across commits and branches using `git diff`. If a function moves 20 lines down after a refactor, the comment moves with it.
- **🔍 Fuzzy Fallback** — If an exact diff match fails (e.g. the code was reformatted), FCT falls back to fuzzy matching using the original code snippet.
- **⚠️ Orphan Detection** — If the anchored code is deleted entirely, the comment is marked `⚠️ Orphaned` instead of silently disappearing.
- **🤖 Auto-Resolve Orphans** — Enable `fct.autoResolveOrphans` to automatically close orphaned threads when their code is deleted.
- **📸 Commit + Branch Tracking** — Each comment stores the commit hash and branch it was created on, so anchoring works even after branch switches.

### Severity & Tags
- **🔴🟡🔵 Priority Levels** — Add `#p1`, `#p2`, or `#p3` to a comment to set its priority. The thread header is labelled and coloured accordingly.
- **📋 Semantic Tags** — Use `#todo`, `#bug`, or `#idea` to categorise a comment. The tag is bolded and the thread icon updates in the sidebar.

### Team Collaboration
- **👥 `@` Autocomplete from Git History** — Type `@` in any comment box and get a dropdown of everyone who has ever committed to the repo, pulled live from `git log`.
- **🕵️ Dynamic `@author` Tag** — Type `@author` and FCT runs `git blame` on the anchored line. When you save, `@author` is automatically replaced with the real name of the person who wrote that line.
- **📢 @Mention Notifications** — Tag a teammate with `@username` and they get a Slack or Discord notification with a deep link that opens the exact file and line in their VS Code.
- **😄 Emoji Reactions** — React to individual comments with 👍 👎 🚀 👀 🎉. Reactions are persisted and synced to the backend.

### Explorer & Navigation
- **🗂️ Comments Explorer** — A dedicated panel in the Activity Bar lists all active comments across the entire project, grouped by file. Click any entry to jump straight to the anchored code.
- **🔭 CodeLens Indicators** — `💬 2 Active Comments` appears above any function or class that contains comments. Click it to jump to the first one.
- **🔗 Deep Links** — Share a `vscode://filipdobosz.fct/open?file=main.go&line=42` link (e.g. in Slack) that opens the exact file and line in any teammate's VS Code.

### Storage & Export
- **💾 Local-First** — Works entirely offline. Comments are stored in `.fct/comments.json` inside the workspace, written atomically (temp file + rename) with one `.bak` rotation.
- **🌐 Real-Time Sync** — Optionally connect a self-hosted backend for team collaboration. Comments sync instantly via WebSocket.
- **📤 Export to Markdown** — Run **FCT: Export Active Comments to Markdown** from the Command Palette to generate a full report of all active threads (with code snippets and replies), copy it to your clipboard, and open it in a new editor tab — ready to paste into a PR description or Jira ticket.

---

## 🚀 Quick Start

### Solo Use (No Backend)

1. Install the extension from the `.vsix` file:
   ```bash
   code --install-extension fct-0.3.1.vsix
   ```
2. Open any project in VS Code.
3. Select some code, right-click → **FCT: Add Comment** (or click the `+` gutter icon).
4. Set your display name: **Settings** → search `fct.username`.
5. Start commenting!

### Team Use (With Backend)

1. **Start the backend:**
   ```bash
   cd backend
   docker compose up -d
   ```

2. **Configure the extension** (Settings → search `fct`):
   - `fct.backendUrl`: `http://<your-server-ip>:8420`
   - `fct.username`: Your display name

3. **Optional — set up notifications:**
   - `fct.slackWebhookUrl`: Slack incoming webhook URL
   - `fct.discordWebhookUrl`: Discord webhook URL

---

## ⌨️ Commands

| Command | Description |
|---------|-------------|
| **FCT: Add Comment** | Add a comment on the selected code |
| **FCT: Export Active Comments to Markdown** | Generate a Markdown report of all active threads |
| **FCT: Reveal Comment** | Jump to a comment's anchored location (also triggered by clicking the Explorer tree or a CodeLens) |

---

## ⚙️ Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `fct.username` | string | `""` | Your display name for comments |
| `fct.backendUrl` | string | `""` | Backend server URL. Empty = local-only mode |
| `fct.enableGitAnchoring` | boolean | `true` | Enable Git-aware comment anchoring |
| `fct.autoResolveOrphans` | boolean | `false` | Auto-resolve threads when anchored code is deleted |
| `fct.slackWebhookUrl` | string | `""` | Slack webhook for @mention notifications |
| `fct.discordWebhookUrl` | string | `""` | Discord webhook for @mention notifications |

---

## 🛠️ Development

### Extension

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode (recompiles on save)
npm run watch

# Package as .vsix
npx @vscode/vsce package

# Launch in debug mode — press F5 in VS Code
```

### Backend

```bash
cd backend

# Run locally (SQLite, no Docker)
go run .

# Build and start with Docker
docker compose up -d --build
```

---

## 📐 Architecture

```
VS Code Extension                        Backend (Docker, optional)
┌──────────────────────┐                 ┌──────────────────────┐
│ CommentController    │──── REST API ──▶│  Go HTTP Server       │
│ GitService           │                 │  SQLite Database      │
│ AnchoringEngine      │◀─── WebSocket ──│  WebSocket Hub        │
│ DiffParser           │                 │  Slack/Discord Notify │
│ FCTTreeDataProvider  │                 └──────────────────────┘
│ FCTCodeLensProvider  │
│ FCTMentionProvider   │
│ LocalStorage         │  ← .fct/comments.json (atomic writes + .bak)
│ WebSocketClient      │
│ FCTUriHandler        │
└──────────────────────┘
```

---

## 🗂️ Project Structure

```
fct/
├── src/
│   ├── extension.ts          # Entry point — wires everything together
│   ├── commentController.ts  # Comment CRUD, reactions, tag parsing, hover
│   ├── storage.ts            # Local (atomic JSON) + Backend (REST) storage
│   ├── gitService.ts         # Git API wrapper (blame, diff, contributors)
│   ├── anchoringEngine.ts    # Diff-based + fuzzy line remapping
│   ├── diffParser.ts         # Unified diff parser
│   ├── treeView.ts           # Comments Explorer sidebar panel
│   ├── codeLensProvider.ts   # CodeLens "💬 N Active Comments" indicators
│   ├── mentionProvider.ts    # @ autocomplete from git log
│   ├── export.ts             # Markdown report generator
│   ├── websocketClient.ts    # Real-time sync client
│   ├── uriHandler.ts         # Deep link handler (vscode://...)
│   ├── types.ts              # Shared TypeScript types
│   └── types/git.d.ts        # VS Code Git extension API types
├── backend/
│   ├── main.go               # HTTP routes + WebSocket server
│   ├── models.go             # Data models (threads, comments, reactions)
│   ├── db.go                 # SQLite data layer
│   ├── websocket.go          # WebSocket hub
│   ├── notifications.go      # Slack/Discord webhook dispatch
│   ├── Dockerfile
│   └── docker-compose.yml
├── package.json
└── tsconfig.json
```

---

## 📝 License

MIT
