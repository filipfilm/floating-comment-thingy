# 💬 FCT — Floating Comment Thingy

> Google Docs-style floating comments for your code — without modifying source files.

Leave comments on any line of code, reply in threads, tag teammates with `@mentions`, and have comments follow your code across Git branches and commits. All without ever touching a source file.

## ✨ Features

- **🗨️ Native VS Code Comments** — Uses the built-in `vscode.comments` API. Comments appear in the gutter, just like in a code review.
- **🔀 Git-Aware Anchoring** — Comments follow code across commits and branches. If the code moves, the comments move with it. If the code is deleted, comments are marked as orphaned.
- **💾 Local-First** — Works entirely offline with `workspaceState`. No backend required for solo use.
- **🌐 Real-Time Sync** — Connect a backend server for team collaboration. Comments sync instantly via WebSocket.
- **📢 @Mention Notifications** — Tag a teammate with `@username` and they get a Slack/Discord notification with a deep link straight into their editor.
- **🔗 Deep Links** — `vscode://filipdobosz.fct/open?file=main.go&line=42` opens the exact file and line.

## 🚀 Quick Start

### Solo Use (No Backend)

1. Install the extension
2. Open any project in VS Code
3. Click the `+` icon in the gutter (or select code and use the command palette)
4. Set your username: Settings → `fct.username`
5. Start commenting!

### Team Use (With Backend)

1. **Start the backend:**
   ```bash
   cd backend
   docker compose up -d
   ```

2. **Configure the extension:**
   - `fct.backendUrl`: `http://<your-tailscale-ip>:8420`
   - `fct.username`: Your display name

3. **Optional: Set up notifications:**
   - `fct.slackWebhookUrl`: Your Slack incoming webhook URL
   - `fct.discordWebhookUrl`: Your Discord webhook URL

## 🛠️ Development

### Extension

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch

# Launch in debug mode
# Press F5 in VS Code
```

### Backend

```bash
cd backend

# Run locally
go run .

# Build Docker image
docker compose build

# Start with Docker
docker compose up -d
```

## ⚙️ Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `fct.username` | string | `""` | Your display name for comments |
| `fct.backendUrl` | string | `""` | Backend server URL. Empty = local-only mode |
| `fct.enableGitAnchoring` | boolean | `true` | Enable Git-aware comment anchoring |
| `fct.slackWebhookUrl` | string | `""` | Slack webhook for @mention notifications |
| `fct.discordWebhookUrl` | string | `""` | Discord webhook for @mention notifications |

## 📐 Architecture

```
VS Code Extension                        Backend (Docker)
┌─────────────────┐                      ┌─────────────────┐
│ CommentController│──── REST API ───────▶│  Go HTTP Server  │
│ GitService       │                      │  SQLite Database │
│ AnchoringEngine  │◀── WebSocket ───────│  WebSocket Hub   │
│ DiffParser       │                      │  Notification    │
│ WebSocketClient  │                      │  Dispatcher      │
└─────────────────┘                      └─────────────────┘
```

## 🗂️ Project Structure

```
fct/
├── src/
│   ├── extension.ts          # Entry point
│   ├── commentController.ts  # Comment CRUD + UI
│   ├── storage.ts            # Local + Backend storage
│   ├── gitService.ts         # Git API wrapper
│   ├── anchoringEngine.ts    # Line remapping logic
│   ├── diffParser.ts         # Unified diff parser
│   ├── websocketClient.ts    # Real-time sync
│   ├── uriHandler.ts         # Deep link handler
│   ├── types.ts              # Shared TypeScript types
│   └── types/git.d.ts        # VS Code Git API types
├── backend/
│   ├── main.go               # HTTP + WebSocket server
│   ├── models.go             # Data models
│   ├── db.go                 # SQLite data layer
│   ├── websocket.go          # WebSocket hub
│   ├── notifications.go      # Slack/Discord webhooks
│   ├── Dockerfile
│   └── docker-compose.yml
├── package.json
└── tsconfig.json
```

## 📝 License

MIT
