# Quolle MCP Server

Let AI agents — Claude Desktop, Cursor, and any [Model Context Protocol](https://modelcontextprotocol.io) client — send transactional email through [Quolle](https://quolle.com).

The agent gets tools to **send email**, **send batches**, **check delivery status**, **cancel scheduled sends**, and **list your verified domains** — so it can do things like *"email the new signup their verification code"* or *"send everyone on this list their receipt"* using your Quolle account.

## Tools

| Tool | What it does |
|---|---|
| `send_email` | Send one email (OTP, receipt, notification). Supports HTML or templates, scheduling, and idempotency. |
| `send_batch` | Send up to 100 emails in one all-or-nothing request. |
| `get_email` | Check an email's delivery status and open/click counts by ID. |
| `list_emails` | List recent sends, filtered by status or recipient. |
| `cancel_email` | Cancel a scheduled email before it sends. |
| `list_domains` | List your sending domains + verification status (to find a valid `from`). |

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`), so clients can auto-approve the read-only ones and ask before a send or cancel.

**Transactional only.** There's deliberately no way to send marketing mail from an agent; use Campaigns for that, where consent and unsubscribes are enforced.

**Use a sending-only key** (Dashboard → API Keys → scope "Sending"). It can send, look up and cancel emails, which is all an agent usually needs. `list_domains` and `list_emails` need a full-access key. You can also restrict a key to specific sending domains.

**Errors keep the API's `code`** (for example `domain_not_verified`, `rate_limit_exceeded`), so the agent can tell "fix the request" from "wait and retry". Rate-limited calls are retried automatically.

## Install

Once published, no install step is needed; point your client at `npx -y @quolle/mcp` (below). To run from source instead:

```bash
npm install
npm run build
# then use "command": "node", "args": ["/absolute/path/to/quolle-mcp/dist/index.js"]
```

## Configure your MCP client

You need a Quolle API key (starts with `qle_`) from your [dashboard](https://app.quolle.com) → API Keys.

### Claude Desktop

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "quolle": {
      "command": "npx",
      "args": ["-y", "@quolle/mcp"],
      "env": {
        "QUOLLE_API_KEY": "qle_your_sending_key"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project (or global settings):

```json
{
  "mcpServers": {
    "quolle": {
      "command": "npx",
      "args": ["-y", "@quolle/mcp"],
      "env": { "QUOLLE_API_KEY": "qle_your_sending_key" }
    }
  }
}
```

Once published to npm, you can skip the local build and use `npx`:

```json
{
  "mcpServers": {
    "quolle": {
      "command": "npx",
      "args": ["-y", "@quolle/mcp"],
      "env": { "QUOLLE_API_KEY": "qle_your_api_key" }
    }
  }
}
```

## Try it

After restarting your MCP client, ask the agent:

> "Using Quolle, send a test email from hello@mail.mydomain.com to me@example.com with the subject 'Hello from my agent' and a short HTML body."

The agent calls `send_email` (and, with a full-access key, may first call `list_domains` to confirm a verified sender).

## Environment

- `QUOLLE_API_KEY` — **required.** Your Quolle API key.
- `QUOLLE_BASE_URL` — optional, defaults to `https://api.quolle.com`.

## Safety

Sends go through your real Quolle account and count against your quota. To test agent flows without touching your reputation, point the agent at Quolle's reserved test addresses: `delivered@test.quolle.com`, `bounced@test.quolle.com`, `complained@test.quolle.com`.

## License

MIT
