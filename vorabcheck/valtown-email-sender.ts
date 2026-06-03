// ════════════════════════════════════════════════════════════════════════
// Liftaro Email-Sender Val (val.town HTTP-Val)
// ────────────────────────────────────────────────────────────────────────
// HTTP-Endpoint, der eine Mail über das All-Inkl-Postfach (SMTP) versendet.
// Wird vom Hauptcheck-Frontend aufgerufen, wenn der Bearbeiter eine Reply
// auf eine Inbox-Email absendet.
//
// POST <val-url>
// Header:  X-App-Secret: <APP_SECRET>
// Body (JSON): {
//   to:         "kunde@example.de"  (oder Array),
//   subject:    "Re: ...",
//   text:       "Plain-Text-Body",
//   html?:      "<p>HTML-Body</p>",
//   replyTo?:   "check@liftaro.de",
//   inReplyTo?: "<message-id@example.de>",
//   references?: "<msg1> <msg2>",
//   attachments?: [{ filename, contentType, contentBase64 }]
// }
//
// Response 200: { ok: true, messageId }
// Response 401: { error: "Auth failed" }
// Response 400: { error: "<details>" }
//
// Env-Variablen (in val.town Settings → Environment Variables):
//   APP_SECRET   — geheimer String, mit dem das Frontend sich authentifiziert
//   SMTP_HOST    — z.B. "w021201e.kasserver.com"
//   SMTP_PORT    — "465" (SSL) oder "587" (STARTTLS)
//   SMTP_USER    — Postfach-Login (oft die Email-Adresse oder eine Kürzel-ID)
//   SMTP_PASS    — Postfach-Passwort
//   SMTP_FROM    — Default-Absender, z.B. "check@liftaro.de"
//   SMTP_FROM_NAME — z.B. "Liftaro GmbH"
//   ALLOWED_ORIGIN — z.B. "https://check.liftaro.de" (oder "*" während Test)
// ════════════════════════════════════════════════════════════════════════

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

type Attachment = { filename: string; contentType: string; contentBase64: string };
type SendPayload = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  bcc?: string | string[];          // V12.138: BCC-Empfänger (optional, mehrere möglich)
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Attachment[];
};

function cors(allow: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Secret",
    "Access-Control-Max-Age":       "86400",
  };
}

function json(body: any, status: number, allow: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(allow) },
  });
}

function b64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default async function (req: Request): Promise<Response> {
  const ALLOW = Deno.env.get("ALLOWED_ORIGIN") || "*";

  // CORS-Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(ALLOW) });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, ALLOW);
  }

  // 1. App-Secret prüfen
  const expectedSecret = Deno.env.get("APP_SECRET") || "";
  const gotSecret = req.headers.get("X-App-Secret") || "";
  if (!expectedSecret || gotSecret !== expectedSecret) {
    return json({ error: "Auth failed" }, 401, ALLOW);
  }

  // 2. Body parsen
  let body: SendPayload;
  try { body = await req.json(); }
  catch { return json({ error: "Invalid JSON" }, 400, ALLOW); }

  const to = Array.isArray(body.to) ? body.to : [body.to];
  if (!to.length || !to[0]) return json({ error: "Missing 'to'" }, 400, ALLOW);
  if (!body.subject)        return json({ error: "Missing 'subject'" }, 400, ALLOW);
  if (!body.text && !body.html) return json({ error: "Missing 'text' or 'html'" }, 400, ALLOW);

  // 3. SMTP-Connection vorbereiten
  const host = Deno.env.get("SMTP_HOST") || "";
  const port = parseInt(Deno.env.get("SMTP_PORT") || "465", 10);
  const user = Deno.env.get("SMTP_USER") || "";
  const pass = Deno.env.get("SMTP_PASS") || "";
  const fromAddr = Deno.env.get("SMTP_FROM") || user;
  const fromName = Deno.env.get("SMTP_FROM_NAME") || "Liftaro GmbH";
  // Präzise Fehlermeldung: welche Variable fehlt?
  const missing: string[] = [];
  if (!host) missing.push("SMTP_HOST");
  if (!user) missing.push("SMTP_USER");
  if (!pass) missing.push("SMTP_PASS");
  if (missing.length) {
    return json({ error: "SMTP not configured — missing env-vars: " + missing.join(", ") }, 500, ALLOW);
  }

  // 4. Custom Headers für In-Reply-To / References (für Thread-Anbindung)
  const customHeaders: Record<string, string> = {};
  if (body.inReplyTo) {
    const mid = body.inReplyTo.startsWith("<") ? body.inReplyTo : `<${body.inReplyTo}>`;
    customHeaders["In-Reply-To"] = mid;
    if (!body.references) customHeaders["References"] = mid;
  }
  if (body.references) customHeaders["References"] = body.references;

  // 5. Attachments aufbereiten
  const attachments = (body.attachments || []).map(a => ({
    filename:    a.filename,
    contentType: a.contentType || "application/octet-stream",
    encoding:    "binary" as const,
    content:     b64ToUint8(a.contentBase64),
  }));

  // 6. SMTP-Client + Send
  const client = new SMTPClient({
    connection: {
      hostname: host,
      port: port,
      tls: port === 465,           // implicit TLS bei 465, STARTTLS bei 587
      auth: { username: user, password: pass },
    },
  });

  try {
    const fromHeader = fromName ? `${fromName} <${fromAddr}>` : fromAddr;
    // V12.138: BCC mitschicken — als Array normalisiert, undefined wenn leer
    const bccList = body.bcc
      ? (Array.isArray(body.bcc) ? body.bcc.filter(Boolean) : [body.bcc].filter(Boolean))
      : undefined;
    await client.send({
      from: fromHeader,
      to: to,
      bcc: (bccList && bccList.length) ? bccList : undefined,
      replyTo: body.replyTo || fromAddr,
      subject: body.subject,
      content: body.text || "",
      html:    body.html || undefined,
      headers: customHeaders,
      attachments: attachments.length ? attachments : undefined,
    });
    await client.close();
    return json({ ok: true, from: fromHeader, to: to, subject: body.subject }, 200, ALLOW);
  } catch (err: any) {
    try { await client.close(); } catch (_) {}
    console.error("[email-sender] SMTP-Send fehlgeschlagen:", err);
    return json({ error: "SMTP send failed: " + (err?.message || String(err)) }, 500, ALLOW);
  }
}
