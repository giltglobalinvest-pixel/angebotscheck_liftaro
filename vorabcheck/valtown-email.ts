// ════════════════════════════════════════════════════════════════════════
// Liftaro Email-Inbox Val (val.town email-Val)
// ────────────────────────────────────────────────────────────────────────
// Empfängt eingehende Emails an die val.town-Adresse, klassifiziert sie via
// Claude und legt einen Datensatz in der Airtable-Tabelle "Emails" an.
// Pro erkanntem Vorgang wird der KI-Output als JSON ins Feld `vorgaenge_json`
// gespeichert — die eigentliche Check-Erstellung passiert später im Frontend,
// wenn der Bearbeiter den Vorgang in der Inbox-UI bestätigt.
//
// Setup: siehe EMAIL_SETUP.md im selben Verzeichnis.
//
// Env-Variablen (in val.town Settings → Secrets):
//   AIRTABLE_KEY            — PAT für Airtable
//   AIRTABLE_BASE_ID        — gleiche Base wie der HTTP-Backend
//   ANTHROPIC_API_KEY       — für Claude-Klassifikation
//   EMAIL_INBOX_ENABLED     — "1" um Email-Verarbeitung freizugeben (Notbremse)
// ════════════════════════════════════════════════════════════════════════

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";
import { EMAIL_SPLITTER_PROMPT } from "https://check.liftaro.de/vorabcheck/prompts.js?v=4";
import { EMAILS_TARGET_FIELDS } from "https://check.liftaro.de/vorabcheck/backend-extras.js?v=6";

const MODEL_CLASSIFIER = "claude-haiku-4-5";   // schnell + günstig für Triage
const COST_PER_M_INPUT  = 1.0;                 // Haiku 4.5 — niedriger Preis
const COST_PER_M_OUTPUT = 5.0;
const USD_TO_EUR = 0.92;

const EMAILS_TABLE = "Emails";

// ──────────────────────────────────────────────────────────────────
// Schema-Ensurance: legt Tabelle + Felder beim ersten Aufruf an.
// Wird einmalig beim Empfang der ersten Email getriggert (idempotent).
// ──────────────────────────────────────────────────────────────────
let _schemaEnsured = false;
async function ensureEmailsSchema(): Promise<void> {
  if (_schemaEnsured) return;
  const key  = Deno.env.get("AIRTABLE_KEY");
  const base = Deno.env.get("AIRTABLE_BASE_ID");
  if (!key || !base) throw new Error("AIRTABLE_KEY/BASE_ID nicht gesetzt");
  const metaUrl = `https://api.airtable.com/v0/meta/bases/${base}/tables`;
  const meta = await fetch(metaUrl, { headers: { Authorization: `Bearer ${key}` } });
  if (!meta.ok) throw new Error("Meta-Read HTTP " + meta.status);
  const tables = (await meta.json()).tables || [];
  const existing = tables.find((t: any) => t.name === EMAILS_TABLE);

  if (!existing) {
    // Tabelle neu anlegen — Airtable verlangt MIN. 1 Feld bei create
    const createUrl = metaUrl;
    const createRes = await fetch(createUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: EMAILS_TABLE, fields: EMAILS_TARGET_FIELDS }),
    });
    if (!createRes.ok) {
      const t = await createRes.text();
      throw new Error("Tabelle Emails konnte nicht angelegt werden: " + t.slice(0, 300));
    }
  } else {
    // Tabelle existiert — fehlende Felder einzeln nachziehen
    const exNames = new Set((existing.fields || []).map((f: any) => f.name));
    const missing = EMAILS_TARGET_FIELDS.filter((f: any) => !exNames.has(f.name));
    for (const f of missing) {
      const addUrl = `${metaUrl}/${existing.id}/fields`;
      const r = await fetch(addUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(f),
      });
      if (!r.ok) {
        console.warn("Feld nicht angelegt:", f.name, await r.text());
      }
    }
  }
  _schemaEnsured = true;
}

// ──────────────────────────────────────────────────────────────────
// KI-Triage: schickt Subject + Body + Attachment-Filenames an Claude.
// Liefert das parsed JSON zurück + Kosten in EUR.
// ──────────────────────────────────────────────────────────────────
type KiResult = {
  parsed: any;
  cost_eur: number;
  raw_text: string;
};

async function classifyEmail(
  subject: string,
  bodyText: string,
  fromEmail: string,
  fromName: string,
  attachmentNames: string[]
): Promise<KiResult> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY nicht gesetzt");
  const client = new Anthropic({ apiKey });

  // Body kürzen, damit Token-Kosten kalkulierbar bleiben — Triage braucht
  // nicht den ganzen Roman, die ersten 6000 Zeichen reichen.
  const bodySnippet = (bodyText || "").slice(0, 6000);
  const userMsg = `Email-Empfangsdaten:

Absender: ${fromName || "(unbekannt)"} <${fromEmail}>
Betreff: ${subject || "(leer)"}
Anhänge: ${attachmentNames.length ? attachmentNames.join(", ") : "(keine)"}

Body (text/plain, ggf. gekürzt):
---
${bodySnippet}
---

Klassifiziere und antworte ausschließlich mit dem JSON gemäß Schema.`;

  const resp = await client.messages.create({
    model: MODEL_CLASSIFIER,
    max_tokens: 2048,
    system: EMAIL_SPLITTER_PROMPT,
    messages: [{ role: "user", content: userMsg }],
  });

  const usage: any = (resp as any).usage || {};
  const inTok  = usage.input_tokens  || 0;
  const outTok = usage.output_tokens || 0;
  const costUsd = (inTok / 1_000_000) * COST_PER_M_INPUT + (outTok / 1_000_000) * COST_PER_M_OUTPUT;
  const costEur = costUsd * USD_TO_EUR;

  const raw = (resp.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");

  // JSON aus der Antwort extrahieren (Claude wickelt es manchmal in Markdown)
  let parsed: any = null;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Fallback: greedy { ... }-Block
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
  }

  if (!parsed || typeof parsed !== "object") {
    parsed = {
      summary: subject || "(Email ohne erkennbares Anliegen)",
      classification: "unklar",
      confidence: "low",
      vorgaenge: [],
      reply_draft: "",
    };
  }

  return { parsed, cost_eur: Math.round(costEur * 10000) / 10000, raw_text: raw };
}

// ──────────────────────────────────────────────────────────────────
// Airtable-Write: Email-Record + Attachments anlegen
// ──────────────────────────────────────────────────────────────────
async function createEmailRecord(fields: any): Promise<string | null> {
  const key  = Deno.env.get("AIRTABLE_KEY");
  const base = Deno.env.get("AIRTABLE_BASE_ID");
  const url  = `https://api.airtable.com/v0/${base}/${encodeURIComponent(EMAILS_TABLE)}`;

  // Wir verwenden die gleiche atPostSafe-Strategie wie der HTTP-Backend:
  // Wenn Airtable über unbekannte Felder meckert, droppen wir sie einzeln.
  const headers = { Authorization: "Bearer " + key, "Content-Type": "application/json" };
  let working = { ...fields };
  let attempts = 0;
  while (attempts++ < 15) {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ fields: working }) });
    if (r.ok) {
      const j = await r.json();
      return j?.id || null;
    }
    const txt = await r.text();
    const m = txt.match(/Unknown field name:\s*"([^"]+)"/i);
    if (m && Object.prototype.hasOwnProperty.call(working, m[1])) {
      delete working[m[1]];
      continue;
    }
    console.error("[Emails] POST fehlgeschlagen:", txt.slice(0, 300));
    return null;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────
// Attachments: val.town liefert die Dateien als File[]-ähnliche Objekte.
// Wir laden sie nach Airtable hoch (per Upload-API) und sammeln die URLs.
// Airtable braucht Attachments als { url, filename } — wir nutzen
// content.airtable.com Upload für direkten Binary-Upload.
// ──────────────────────────────────────────────────────────────────
// Robuste Bytes-Konversion: val.town liefert Attachment-Content in unterschiedlichen
// Formaten (Uint8Array, ArrayBuffer, Buffer, base64-String). Wir akzeptieren alles.
function _toUint8Array(content: any): Uint8Array | null {
  if (content == null) return null;
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (typeof content === "string") {
    // Versuche base64 zu dekodieren
    try {
      const bin = atob(content);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (_) {
      // raw String → UTF-8-Bytes
      return new TextEncoder().encode(content);
    }
  }
  // Buffer (Node-Stil) oder andere Array-likes — duck-typing
  if (typeof content.length === "number") {
    try { return new Uint8Array(content); } catch (_) {}
  }
  if (content.buffer && content.buffer instanceof ArrayBuffer) {
    return new Uint8Array(content.buffer, content.byteOffset || 0, content.byteLength);
  }
  return null;
}

// Chunked base64-Konversion — String.fromCharCode(...) bei großen Arrays (>~100k)
// fällt sonst mit "Maximum call stack size exceeded" um.
function _bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000; // 32k Chunks
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

async function uploadAttachmentToAirtable(
  recordId: string,
  fieldName: string,
  fileName: string,
  contentType: string,
  bytes: Uint8Array
): Promise<boolean> {
  const key  = Deno.env.get("AIRTABLE_KEY");
  const base = Deno.env.get("AIRTABLE_BASE_ID");
  // Airtable Content-Upload-Endpoint (eingeführt 2024)
  const url = `https://content.airtable.com/v0/${base}/${recordId}/${encodeURIComponent(fieldName)}/uploadAttachment`;
  const b64 = _bytesToBase64(bytes);
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ contentType, filename: fileName, file: b64 }),
  });
  if (!r.ok) {
    console.warn("[Emails] Attachment-Upload fehlgeschlagen:", fileName, await r.text());
    return false;
  }
  return true;
}

// HTML → Plain-Text-Approximation (für body_text-Fallback, wenn nur HTML kam)
function _htmlToText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ──────────────────────────────────────────────────────────────────
// val.town Email-Handler — exportierte Funktion mit Signatur
//   (e: Email) => Promise<void>
// val.town ruft diese auf, sobald eine Email an die Val-Adresse geht.
// ──────────────────────────────────────────────────────────────────
export default async function (e: any): Promise<void> {
  // Notbremse: wenn EMAIL_INBOX_ENABLED nicht "1" ist, nur loggen und beenden
  if (Deno.env.get("EMAIL_INBOX_ENABLED") !== "1") {
    console.log("[Emails] Empfang deaktiviert (EMAIL_INBOX_ENABLED!=1) — Email verworfen:", e?.subject);
    return;
  }

  try {
    await ensureEmailsSchema();
  } catch (err) {
    console.error("[Emails] Schema-Ensure FAIL:", err);
    return; // ohne Schema kein sinnvoller Insert
  }

  // val.town Email-Objekt:
  // {
  //   from: "Max Mustermann <max@example.de>",
  //   to: ["liftaroinbox@val.email"],
  //   subject: "...",
  //   text: "plain body",
  //   html: "html body",
  //   attachments: [{ filename, contentType, size, content: Uint8Array }]
  //   raw: full RFC822 source,
  //   headers: { messageId, references, inReplyTo, ... }
  // }
  const from         = String(e?.from || "");
  const fromMatch    = from.match(/^(.*?)\s*<([^>]+)>$/);
  const fromName     = fromMatch ? fromMatch[1].replace(/^"|"$/g, "").trim() : "";
  const fromEmail    = fromMatch ? fromMatch[2].trim() : from.trim();
  const toArr        = Array.isArray(e?.to) ? e.to : (e?.to ? [String(e.to)] : []);
  const toEmail      = toArr[0] || "";
  const subject      = String(e?.subject || "");
  const html         = String(e?.html || "");
  // body_text Fallback: viele Mailclients senden nur HTML; wir leiten dann den
  // Text aus dem HTML ab, damit der KI-Klassifikator und die Inbox-UI was haben.
  const text         = String(e?.text || "") || _htmlToText(html);
  const attachments  = Array.isArray(e?.attachments) ? e.attachments : [];
  const attachNames  = attachments.map((a: any) => String(a?.filename || "anhang.bin"));
  const messageId    = String(e?.headers?.messageId  || e?.headers?.["message-id"]  || "");
  const inReplyTo    = String(e?.headers?.inReplyTo  || e?.headers?.["in-reply-to"] || "");
  const replyTo      = String(e?.headers?.replyTo    || e?.headers?.["reply-to"]    || fromEmail);

  console.log("[Emails] Empfangen:", { from, subject, attachments: attachNames.length });

  // KI-Triage
  let kiResult: KiResult;
  try {
    kiResult = await classifyEmail(subject, text || html, fromEmail, fromName, attachNames);
  } catch (err: any) {
    console.error("[Emails] KI-Triage FAIL:", err?.message || err);
    kiResult = {
      parsed: { summary: "(KI-Fehler — manuell sichten)", classification: "unklar", confidence: "low", vorgaenge: [], reply_draft: "" },
      cost_eur: 0, raw_text: "",
    };
  }

  // Airtable-Record anlegen (ohne Attachments — die kommen im 2. Step via Upload-Endpoint)
  const recordFields: any = {
    from_email:     fromEmail,
    from_name:      fromName,
    to_email:       toEmail,
    reply_to:       replyTo,
    subject:        subject,
    received_at:    new Date().toISOString(),
    message_id:     messageId,
    in_reply_to:    inReplyTo,
    body_text:      text.slice(0, 95000),  // Airtable Long-Text-Limit beachten
    body_html:      html.slice(0, 95000),
    attachment_count: attachments.length,
    ki_summary:        kiResult.parsed.summary || "",
    ki_classification: kiResult.parsed.classification || "unklar",
    ki_vorgaenge_count: Array.isArray(kiResult.parsed.vorgaenge) ? kiResult.parsed.vorgaenge.length : 0,
    vorgaenge_json:    JSON.stringify(kiResult.parsed.vorgaenge || [], null, 2).slice(0, 95000),
    reply_draft:       (kiResult.parsed.reply_draft || "").slice(0, 95000),
    ki_confidence:     kiResult.parsed.confidence || "low",
    ki_analyzed_at:    new Date().toISOString(),
    ki_model:          MODEL_CLASSIFIER,
    ki_cost_eur:       kiResult.cost_eur,
    status:            "neu",
    status_at:         new Date().toISOString(),
    linked_check_ids:  "",
    linked_checks_count: 0,
  };

  const recordId = await createEmailRecord(recordFields);
  if (!recordId) {
    console.error("[Emails] Konnte Email-Record nicht anlegen — Abbruch.");
    return;
  }

  // Attachments hochladen (sequentiell, damit wir Airtable nicht überlasten).
  // val.town liefert das Content-Feld in unterschiedlichen Formaten je nach
  // Email-Provider — wir akzeptieren Uint8Array, ArrayBuffer, Buffer, base64-String.
  let uploadedCount = 0;
  for (const att of attachments) {
    try {
      const fname = String(att?.filename || att?.name || "anhang.bin");
      const ctype = String(att?.contentType || att?.type || "application/octet-stream");
      // Try unterschiedliche Felder, je nach val.town-Email-Schema
      const rawContent = att?.content ?? att?.body ?? att?.data ?? att?.buffer;
      const bytes = _toUint8Array(rawContent);
      if (!bytes || bytes.byteLength === 0) {
        console.warn("[Emails] Attachment ohne lesbaren Content — skipped:", fname,
          "type=", typeof rawContent, "keys=", rawContent ? Object.keys(rawContent).slice(0, 5) : "(null)");
        continue;
      }
      if (bytes.byteLength > 20 * 1024 * 1024) {
        console.warn("[Emails] Attachment zu groß — skipped:", fname, bytes.byteLength);
        continue;
      }
      const ok = await uploadAttachmentToAirtable(recordId, "attachments", fname, ctype, bytes);
      if (ok) uploadedCount++;
    } catch (err) {
      console.warn("[Emails] Attachment-Upload-Error:", err);
    }
  }

  console.log("[Emails] Verarbeitet OK:", recordId, "—", kiResult.parsed.classification,
    `(${kiResult.parsed.vorgaenge?.length || 0} Vorgänge, ${uploadedCount}/${attachments.length} Anhänge hochgeladen)`);
}
