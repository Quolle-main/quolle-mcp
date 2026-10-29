#!/usr/bin/env node
/**
 * Quolle MCP server — lets AI agents (Claude Desktop, Cursor, and other MCP
 * clients) send transactional email through Quolle.
 *
 * Auth: set QUOLLE_API_KEY in the client's MCP server config (env). A
 * sending-only key is enough for every tool except list_domains and
 * list_emails, and is the safer thing to hand an agent.
 * Transport: stdio (the standard for local MCP servers).
 *
 * Deliberately transactional-only: there is no way to set `type: "marketing"`
 * here. Bulk marketing mail should go through Campaigns, where consent,
 * unsubscribes and sending limits are enforced, not through an agent loop.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "1.1.0";
const BASE_URL = process.env.QUOLLE_BASE_URL?.replace(/\/+$/, "") || "https://api.quolle.com";
const API_KEY = process.env.QUOLLE_API_KEY;
const MAX_RETRIES = 3;

type ApiResult = { ok: boolean; status: number; data: Record<string, unknown> };

// ── Authenticated fetch to the Quolle API ─────────────────────────────────────
// Same retry rules as the SDKs: a 429 was never processed, so it is retried
// (honouring Retry-After) unless it is a quota limit; a 5xx or network error is retried only for
// GET/DELETE or when an Idempotency-Key makes the POST safe to repeat.
async function api(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<ApiResult> {
  if (!API_KEY) {
    return {
      ok: false,
      status: 0,
      data: { code: "missing_api_key", error: "QUOLLE_API_KEY is not set in this MCP server's environment." },
    };
  }
  const safeToRepeat = method === "GET" || method === "DELETE" || Boolean(headers?.["Idempotency-Key"]);

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "User-Agent": `quolle-mcp/${VERSION}`,
          ...(headers ?? {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (safeToRepeat && attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return { ok: false, status: 0, data: { error: `Network error: ${(err as Error).message}` } };
    }

    const text = await res.text();
    let data: Record<string, unknown> = {};
    let parsed = true;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      parsed = false;
      data = { error: "Unexpected non-JSON response from the Quolle API", raw: text.slice(0, 500) };
    }

    // A quota 429 resets at midnight UTC or the next period, and a Retry-After
    // over a minute means "not soon": hand the agent the code at once so it can
    // tell the user, rather than stalling the tool call.
    const code = typeof data.code === "string" ? data.code : "";
    const wait = retryAfterMs(res.headers.get("retry-after"));
    const retryable =
      (res.status === 429 && !NO_RETRY_CODES.has(code)) || (res.status >= 500 && res.status <= 504 && safeToRepeat);
    if (retryable && attempt < MAX_RETRIES && (wait === null || wait <= MAX_RETRY_WAIT_MS)) {
      await sleep(wait ?? backoffMs(attempt));
      continue;
    }
    if (!parsed) return { ok: false, status: res.status, data };
    return { ok: res.ok, status: res.status, data };
  }
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}
function retryAfterMs(h: string | null): number | null {
  const secs = h ? Number(h) : NaN;
  return Number.isFinite(secs) ? Math.max(0, secs * 1000) : null;
}
const NO_RETRY_CODES = new Set(["daily_quota_exceeded", "warmup_limit_exceeded", "monthly_quota_exceeded"]);
const MAX_RETRY_WAIT_MS = 60_000;
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Uniform tool result: JSON the agent can read and act on. On failure the API's
// `code` (e.g. "domain_not_verified", "rate_limit_exceeded") is kept, so the
// agent can tell "fix the input" from "wait" from "stop".
function result(r: ApiResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(r.ok ? r.data : { status: r.status, ...r.data }, null, 2) }],
    isError: !r.ok,
  };
}

// ── Shared email fields (mirrors POST /v1/emails/send) ────────────────────────
const attachment = z.object({
  filename: z.string().describe('Attachment file name, e.g. "invoice.pdf".'),
  content: z.string().optional().describe("File bytes, base64-encoded (use this OR path)."),
  path: z.string().url().optional().describe("HTTPS URL Quolle fetches at send time (use this OR content)."),
  contentType: z.string().optional().describe('MIME type, e.g. "application/pdf".'),
  contentId: z.string().optional().describe('Set to embed inline via <img src="cid:the-id">.'),
});

const emailFields = {
  from: z.string().describe('Sender, e.g. "Acme <hello@mail.acme.com>". Its domain must be verified (see list_domains).'),
  to: z.union([z.string(), z.array(z.string()).min(1).max(50)]).describe("Recipient address, or up to 50 addresses."),
  subject: z.string().optional().describe("Subject line (required when sending html)."),
  html: z.string().optional().describe("HTML body. Use html OR template, not both."),
  text: z.string().optional().describe("Optional plain-text body (generated from html if omitted)."),
  template: z.string().optional().describe("Slug of a saved template. Use template OR html, not both."),
  variables: z.record(z.string(), z.unknown()).optional().describe("Template variables."),
  replyTo: z.string().optional().describe("Reply-To address."),
  scheduledAt: z.string().optional().describe("ISO 8601 time to send later, e.g. 2026-12-25T09:00:00Z."),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Your own key/values, echoed back in webhooks."),
};

const server = new McpServer({ name: "quolle", version: VERSION });

// ── send_email ────────────────────────────────────────────────────────────────
server.registerTool(
  "send_email",
  {
    title: "Send email",
    description:
      "Send one transactional email (OTP, receipt, notification, verification). Provide `html` with `subject`, or a `template` slug with `variables`. The `from` domain must be verified. Pass an `idempotencyKey` (e.g. the order or user id plus purpose) so that if you retry, the email is not sent twice.",
    inputSchema: {
      ...emailFields,
      attachments: z.array(attachment).max(20).optional().describe("Up to 20 files, 10 MB total."),
      idempotencyKey: z.string().optional().describe("Same key = same result, never a second send. Strongly recommended."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ idempotencyKey, ...payload }) =>
    result(await api("POST", "/v1/emails/send", payload, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined)),
);

// ── send_batch ────────────────────────────────────────────────────────────────
server.registerTool(
  "send_batch",
  {
    title: "Send a batch of emails",
    description:
      "Send up to 100 emails in one all-or-nothing request (no attachments in a batch). Each item takes the same fields as send_email.",
    inputSchema: {
      emails: z.array(z.object(emailFields)).min(1).max(100).describe("The emails to send."),
      idempotencyKey: z.string().optional().describe("Same key = same result, never a second send."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ emails, idempotencyKey }) =>
    result(await api("POST", "/v1/emails/batch", { emails }, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined)),
);

// ── get_email ─────────────────────────────────────────────────────────────────
server.registerTool(
  "get_email",
  {
    title: "Get email status",
    description: "Look up one email by id: status (queued, sent, delivered, bounced, complained, failed…) and open/click counts.",
    inputSchema: { id: z.string().describe("The email id returned by send_email.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id }) => result(await api("GET", `/v1/emails/${encodeURIComponent(id)}`)),
);

// ── list_emails ───────────────────────────────────────────────────────────────
server.registerTool(
  "list_emails",
  {
    title: "List recent emails",
    description: "List recent sends, newest first, optionally filtered by status or recipient. Needs a full-access API key.",
    inputSchema: {
      status: z.string().optional().describe("e.g. delivered, bounced, failed, queued."),
      recipient: z.string().optional().describe("Only emails to this address."),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ status, recipient, limit }) => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (recipient) q.set("recipient", recipient);
    q.set("limit", String(limit ?? 20));
    return result(await api("GET", `/v1/logs?${q}`));
  },
);

// ── cancel_email ──────────────────────────────────────────────────────────────
server.registerTool(
  "cancel_email",
  {
    title: "Cancel a scheduled email",
    description: "Cancel a scheduled email that has not been sent yet.",
    inputSchema: { id: z.string().describe("The scheduled email's id.") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ id }) => result(await api("DELETE", `/v1/emails/${encodeURIComponent(id)}/cancel`)),
);

// ── list_domains ──────────────────────────────────────────────────────────────
server.registerTool(
  "list_domains",
  {
    title: "List sending domains",
    description:
      "List the account's sending domains and whether each is verified. Use it to pick a valid `from` before sending. Needs a full-access API key.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => result(await api("GET", "/v1/domains")),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP protocol channel; log to stderr.
  console.error(`Quolle MCP server v${VERSION} running (base: ${BASE_URL})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
