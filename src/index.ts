#!/usr/bin/env node
/**
 * Quolle MCP server — lets AI agents (Claude Desktop, Cursor, and other MCP
 * clients) send transactional email through Quolle.
 *
 * Auth: set QUOLLE_API_KEY in the client's MCP server config (env).
 * Transport: stdio (the standard for local MCP servers).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "1.0.0";
const BASE_URL = process.env.QUOLLE_BASE_URL?.replace(/\/+$/, "") || "https://api.quolle.com";
const API_KEY = process.env.QUOLLE_API_KEY;

// ── Minimal authenticated fetch to the Quolle API ─────────────────────────────
async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  if (!API_KEY) {
    return { ok: false, status: 0, data: { error: "QUOLLE_API_KEY is not set in this MCP server's environment." } };
  }
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": `quolle-mcp/${VERSION}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return { ok: false, status: 0, data: { error: `Network error: ${(err as Error).message}` } };
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

// Uniform tool result: JSON text the agent can read/act on.
function result(payload: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], isError };
}

const server = new McpServer({ name: "quolle", version: VERSION });

// ── send_email ────────────────────────────────────────────────────────────────
server.tool(
  "send_email",
  "Send a transactional email through Quolle. Use for OTPs, receipts, notifications, verifications. Provide either `html` (with `subject`) or a `template` slug with `variables`. The `from` domain must be verified in the account (see list_domains).",
  {
    from: z.string().describe("Sender address, e.g. \"Acme <hello@mail.acme.com>\". Domain must be verified."),
    to: z.union([z.string(), z.array(z.string())]).describe("Recipient address, or up to 50 addresses."),
    subject: z.string().optional().describe("Subject line (required when sending html)."),
    html: z.string().optional().describe("HTML body (mutually exclusive with template)."),
    text: z.string().optional().describe("Optional plain-text body (auto-generated from html if omitted)."),
    template: z.string().optional().describe("Slug of a saved template (mutually exclusive with html)."),
    variables: z.record(z.unknown()).optional().describe("Template variable substitutions."),
    replyTo: z.string().optional().describe("Reply-To address."),
    scheduledAt: z.string().optional().describe("ISO 8601 time to send in the future (schedules the email)."),
    idempotencyKey: z.string().optional().describe("Idempotency key — safe retries never send twice."),
  },
  async (args) => {
    const { idempotencyKey, ...payload } = args;
    const headers = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined;
    // idempotencyKey goes in a header, not the body — do a raw call.
    if (!API_KEY) return result({ error: "QUOLLE_API_KEY is not set." }, true);
    try {
      const res = await fetch(`${BASE_URL}/v1/emails/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "User-Agent": `quolle-mcp/${VERSION}`,
          ...(headers ?? {}),
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      return result(data, !res.ok);
    } catch (err) {
      return result({ error: `Network error: ${(err as Error).message}` }, true);
    }
  },
);

// ── send_batch ──────────────────────────────────────────────────────────────
server.tool(
  "send_batch",
  "Send up to 100 emails in one all-or-nothing request. Each item uses the same fields as send_email (from, to, subject, html/template, etc.).",
  {
    emails: z.array(z.record(z.unknown())).min(1).max(100).describe("Array of email payloads."),
  },
  async (args) => {
    const r = await api("POST", "/v1/emails/batch", { emails: args.emails });
    return result(r.data, !r.ok);
  },
);

// ── get_email ─────────────────────────────────────────────────────────────────
server.tool(
  "get_email",
  "Look up a single email by its ID to check delivery status (queued, sent, delivered, bounced, failed) and open/click counts.",
  { id: z.string().describe("The email ID returned by send_email.") },
  async (args) => {
    const r = await api("GET", `/v1/emails/${encodeURIComponent(args.id)}`);
    return result(r.data, !r.ok);
  },
);

// ── cancel_email ──────────────────────────────────────────────────────────────
server.tool(
  "cancel_email",
  "Cancel a scheduled email that has not been sent yet.",
  { id: z.string().describe("The scheduled email's ID.") },
  async (args) => {
    const r = await api("DELETE", `/v1/emails/${encodeURIComponent(args.id)}/cancel`);
    return result(r.data, !r.ok);
  },
);

// ── list_domains ──────────────────────────────────────────────────────────────
server.tool(
  "list_domains",
  "List the account's sending domains and their verification status. Use this to find a valid, verified `from` domain before sending.",
  {},
  async () => {
    const r = await api("GET", "/v1/domains");
    return result(r.data, !r.ok);
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr (stdout is the MCP protocol channel).
  console.error(`Quolle MCP server v${VERSION} running (base: ${BASE_URL})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
