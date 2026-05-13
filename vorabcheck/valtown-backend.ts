// ════════════════════════════════════════════════════════════════════
// LIFTARO VORABCHECK — val.town HTTP-Endpoint
//
// Setup-Anleitung:
//   1. Auf val.town anmelden (kostenlos): https://www.val.town
//   2. Neuen HTTP val anlegen (z.B. "liftaroVorabcheck")
//   3. Diesen Code einfügen
//   4. Im val.town Secrets-Tab folgende Variablen anlegen:
//        - ANTHROPIC_KEY          (dein Anthropic API Key)
//        - TURNSTILE_SECRET_KEY   (Cloudflare Turnstile Secret)
//        - AIRTABLE_KEY           (dein Airtable Personal Access Token)
//        - AIRTABLE_BASE_ID       (Base-ID der Liftaro-Base, z.B. appXXXX)
//   5. Den Endpoint deployen
//   6. Die HTTP-URL aus dem val (z.B. https://USERNAME-liftaroVorabcheck.web.val.run)
//      ins Frontend bei LIFTARO_API_URL eintragen
// ════════════════════════════════════════════════════════════════════

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.30.0";

// ───────────────────────────────────────────────────────────────
// Konfiguration
// ───────────────────────────────────────────────────────────────
const MODEL = "claude-sonnet-4-5-20250929";
const COST_PER_M_INPUT_TOKENS = 3.0;   // $ pro 1M Input-Tokens (Sonnet 4.5)
const COST_PER_M_OUTPUT_TOKENS = 15.0; // $ pro 1M Output-Tokens
const USD_TO_EUR = 0.92;

// ───────────────────────────────────────────────────────────────
// Prompt-Loader — liest Custom-Prompts aus Airtable mit 5-Min-Cache.
// Fallback auf die hardcoded DEFAULT_SYSTEM_PROMPTS weiter unten.
// ───────────────────────────────────────────────────────────────
let _promptCache: Record<string, string> | null = null;
let _promptCacheTs = 0;
const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

async function loadCustomPrompts(): Promise<Record<string, string>> {
  if (_promptCache && Date.now() - _promptCacheTs < PROMPT_CACHE_TTL_MS) return _promptCache;
  const key = Deno.env.get("AIRTABLE_KEY");
  const base = Deno.env.get("AIRTABLE_BASE_ID");
  if (!key || !base) { _promptCache = {}; _promptCacheTs = Date.now(); return _promptCache; }
  try {
    const res = await fetch(`https://api.airtable.com/v0/${base}/Vorabcheck-Prompts`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const map: Record<string, string> = {};
    (data.records || []).forEach((r: any) => {
      const t = r.fields?.check_type;
      const p = r.fields?.system_prompt;
      if (t && p && p.trim().length > 50) map[t] = p;
    });
    _promptCache = map;
    _promptCacheTs = Date.now();
    return map;
  } catch (e) {
    console.warn("loadCustomPrompts:", e);
    return _promptCache || {};
  }
}

// ───────────────────────────────────────────────────────────────
// DEFAULT-System-Prompts pro Check-Typ (Fallback, wenn nichts in
// Airtable hinterlegt ist)
// ───────────────────────────────────────────────────────────────
const DEFAULT_SYSTEM_PROMPTS: Record<string, string> = {
  nebenkosten: `Du bist Aufzug-Experte und Mietrechts-Analyst bei Liftaro. Du prüfst Nebenkostenabrechnungen auf die Aufzug-Position.

PRÜFE FOLGENDE PUNKTE:

1. UMLAGEFÄHIGKEIT (§2 Nr. 7 BetrKV)
   - Umlagefähig: Wartung, Strom, Aufsicht, TÜV (ZÜS), Reinigung
   - NICHT umlagefähig (§1 BetrKV): Reparaturen, Instandsetzung, Modernisierung

2. VOLLWARTUNGSVERTRAG
   - Bei Vollwartung muss ein Vorwegabzug für Instandsetzung erfolgen (20–50%, BGH)
   - Wenn nicht ausgewiesen → Rotflag

3. WARTUNGSPAUSCHALE
   - Marktmedian für Wohnaufzüge: 450–550 €/Jahr je Anlage
   - Über 700 € → mit Verdacht prüfen, kontextabhängig

4. SERVICESTUNDEN-SATZ
   - Marktüblich 95–125 €/h, regional unterschiedlich
   - >140 €/h → gelb, >160 €/h → rot

5. ANZAHL WARTUNGEN P.A.
   - TRBS 1201 Teil 4: 2 Wartungen/Jahr für Wohnaufzüge ausreichend
   - 4 Wartungen → gelb (kann ok sein bei stark genutzten Anlagen)

6. VERTEILUNGSSCHLÜSSEL
   - Erdgeschoss-Mieter zahlt nur wenn vertraglich vereinbart
   - Übliche Schlüssel: m² Wohnfläche oder Person

7. FRIST §556 Abs. 3 BGB
   - 12 Monate ab Erhalt der Abrechnung für Einwendungen

ANTWORTE NUR MIT JSON, OHNE MARKDOWN-CODE-BLOCKS:
{
  "ampel": "gruen" | "gelb" | "rot",
  "summary": "Ein-Satz-Bewertung",
  "findings": [
    {
      "severity": "warn" | "amber" | "blue",
      "title": "Kurze Überschrift",
      "description": "1–2 Sätze Erklärung mit konkreten Beträgen wenn möglich",
      "tag": "z.B. Position 4.2 oder §556 BGB"
    }
  ],
  "savings_estimate_eur": Zahl (geschätzte jährliche Ersparnis in EUR, 0 wenn keine),
  "savings_text": "z.B. 'rund 40% der bisherigen Aufzug-Kosten'",
  "anonymized_data": {
    "abrechnungszeitraum": "z.B. 2024",
    "betrag_aufzug_brutto": Zahl,
    "verteilerschluessel": "qm" | "person" | "wohneinheit" | "unbekannt",
    "vollwartung_erwaehnt": true | false,
    "vorwegabzug_ausgewiesen": true | false,
    "anzahl_wartungen": Zahl | null,
    "anbieter_branche": "kone" | "schindler" | "tk-elevator" | "otis" | "sonstige" | "unbekannt"
  }
}

WICHTIG: anonymized_data darf KEINE personenbezogenen Daten enthalten (keine Namen, Adressen, Kontonummern).`,

  angebot: `Du bist Aufzug-Experte bei Liftaro. Du prüfst Reparatur- oder Wartungs-Angebote auf Plausibilität.

PRÜFE:
1. Marktüblichkeit der Positionspreise (Reparaturkomponenten, Servicestunden)
2. Vollständigkeit (Gewährleistung, Lieferzeit, Anschrift, Steuer-ID)
3. Auffällige Klauseln (lange Bindefristen, Preisgleitklauseln)

Servicestunden-Marktwerte: 95–125 €/h Wohnaufzug, 110–145 €/h Gewerbe.

ANTWORTE NUR MIT JSON wie folgt (gleiches Schema wie nebenkosten, mit angepasstem anonymized_data):
{
  "ampel": "gruen" | "gelb" | "rot",
  "summary": "...",
  "findings": [{ "severity": "warn"|"amber"|"blue", "title": "...", "description": "...", "tag": "..." }],
  "savings_estimate_eur": Zahl,
  "savings_text": "...",
  "anonymized_data": {
    "angebotssumme_netto": Zahl,
    "angebotssumme_brutto": Zahl,
    "gewaehrleistung_monate": Zahl | null,
    "lieferzeit_wochen": Zahl | null,
    "anbieter_branche": "..."
  }
}`,

  vertrag: `Du bist Aufzug-Experte bei Liftaro. Du prüfst Wartungsverträge auf ungünstige Konditionen.

PRÜFE:
1. Laufzeit & Kündigungsfrist (typisch: 3 Monate vor Ablauf, max. 5 Jahre Erstlaufzeit)
2. Vertragstyp (Voll- vs. Teilwartung)
3. Preisgleitklauseln
4. Anzahl Wartungen p.a. (TRBS-konform)
5. Bereitschaftsdienst / Notruf-Kosten

ANTWORTE NUR MIT JSON wie folgt:
{
  "ampel": "gruen" | "gelb" | "rot",
  "summary": "...",
  "findings": [{ "severity": "warn"|"amber"|"blue", "title": "...", "description": "...", "tag": "..." }],
  "savings_estimate_eur": Zahl,
  "savings_text": "...",
  "anonymized_data": {
    "vertragstyp": "vollwartung" | "teilwartung" | "unbekannt",
    "laufzeit_jahre": Zahl | null,
    "kuendigungsfrist_monate": Zahl | null,
    "kosten_pro_jahr": Zahl,
    "anzahl_wartungen": Zahl | null,
    "anbieter_branche": "..."
  }
}`,
};

// ───────────────────────────────────────────────────────────────
// Hauptfunktion
// ───────────────────────────────────────────────────────────────
export default async function (req: Request): Promise<Response> {
  // CORS für GitHub-Pages-Frontend
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResp({ error: "POST only" }, 405, corsHeaders);

  try {
    const body = await req.json();
    const { check_type, file, lead, turnstile_token, consent_given } = body;

    // 1. Turnstile validieren (wenn konfiguriert)
    const turnstileSecret = Deno.env.get("TURNSTILE_SECRET_KEY");
    if (turnstileSecret && turnstile_token) {
      const ok = await verifyTurnstile(turnstile_token, turnstileSecret);
      if (!ok) return jsonResp({ error: "Captcha ungültig" }, 403, corsHeaders);
    }

    // 2. Consent prüfen
    if (!consent_given) return jsonResp({ error: "Einwilligung fehlt" }, 400, corsHeaders);

    // 3. Check-Type validieren (Custom-Prompt aus Airtable > Default)
    const custom = await loadCustomPrompts();
    const systemPrompt = custom[check_type] || DEFAULT_SYSTEM_PROMPTS[check_type];
    if (!systemPrompt) return jsonResp({ error: "Unbekannter Check-Typ" }, 400, corsHeaders);

    // 4. Anthropic-Call
    const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_KEY") });
    const t0 = Date.now();

    const isPdf = file.mime === "application/pdf";
    const userContent: any[] = [
      {
        type: isPdf ? "document" : "image",
        source: { type: "base64", media_type: file.mime, data: file.base64 },
      },
      { type: "text", text: "Prüfe das beigefügte Dokument gemäß den Vorgaben und antworte ausschließlich mit dem geforderten JSON." },
    ];

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    const duration_ms = Date.now() - t0;
    const tokens_in = response.usage.input_tokens;
    const tokens_out = response.usage.output_tokens;
    const cost_eur = ((tokens_in * COST_PER_M_INPUT_TOKENS + tokens_out * COST_PER_M_OUTPUT_TOKENS) / 1_000_000) * USD_TO_EUR;

    // 5. JSON parsen
    const textBlock = response.content.find((c: any) => c.type === "text");
    const rawText = textBlock?.text || "{}";
    const cleaned = rawText.replace(/^```json\s*|\s*```$/g, "").trim();
    let result: any;
    try { result = JSON.parse(cleaned); }
    catch { return jsonResp({ error: "KI-Antwort konnte nicht geparst werden", raw: rawText }, 500, corsHeaders); }

    // 6. Check-Nummer erzeugen
    const checkNr = await generateCheckNr();
    result.check_nr = checkNr;

    // 7. Lead + Vorab-Check in Airtable speichern
    await saveToAirtable({
      check_nr: checkNr,
      check_type,
      lead,
      result,
      file_name: file.name,
      cost_eur,
      tokens_in,
      tokens_out,
      model: MODEL,
      duration_ms,
    });

    // 8. Return — nur die Daten, die das Frontend braucht
    return jsonResp({
      ampel: result.ampel,
      summary: result.summary,
      findings: result.findings || [],
      savings_estimate_eur: result.savings_estimate_eur || 0,
      savings_text: result.savings_text || "",
      check_nr: checkNr,
    }, 200, corsHeaders);

  } catch (e: any) {
    console.error("[liftaro-vorabcheck]", e);
    return jsonResp({ error: e.message || "Server-Fehler" }, 500, corsHeaders);
  }
}

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────
function jsonResp(body: any, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

async function verifyTurnstile(token: string, secret: string): Promise<boolean> {
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`,
  });
  const json = await res.json();
  return !!json.success;
}

async function generateCheckNr(): Promise<string> {
  // Fortlaufende Nummer aus Airtable (oder einfacher Zähler via val.town blob)
  const year = new Date().getFullYear();
  const random = Math.floor(Math.random() * 9000) + 1000;
  return `VC-${year}-${random}`;
}

async function saveToAirtable(data: {
  check_nr: string;
  check_type: string;
  lead: any;
  result: any;
  file_name: string;
  cost_eur: number;
  tokens_in: number;
  tokens_out: number;
  model: string;
  duration_ms: number;
}) {
  const key = Deno.env.get("AIRTABLE_KEY");
  const base = Deno.env.get("AIRTABLE_BASE_ID");
  if (!key || !base) { console.warn("Airtable-Keys fehlen — überspringe Persistenz"); return; }
  const at = `https://api.airtable.com/v0/${base}`;
  const headers = { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" };

  // Lead-Tabelle (mit PII)
  await fetch(`${at}/Vorabcheck-Leads`, {
    method: "POST", headers,
    body: JSON.stringify({
      fields: {
        check_nr: data.check_nr,
        check_type: data.check_type,
        vorname: data.lead.vorname,
        nachname: data.lead.nachname,
        email: data.lead.email,
        telefon: data.lead.telefon || "",
        adresse: data.lead.adresse,
        file_name: data.file_name,
        savedAt: new Date().toISOString(),
      },
    }),
  }).catch(e => console.warn("Lead-Save:", e.message));

  // Vorab-Check-Tabelle (anonymisiert für KI-Lernen)
  await fetch(`${at}/Vorab-Checks`, {
    method: "POST", headers,
    body: JSON.stringify({
      fields: {
        check_nr: data.check_nr,
        check_type: data.check_type,
        ampel: data.result.ampel,
        summary: data.result.summary,
        savings_estimate_eur: data.result.savings_estimate_eur || 0,
        findings_json: JSON.stringify(data.result.findings || []),
        anonymized_data_json: JSON.stringify(data.result.anonymized_data || {}),
        savedAt: new Date().toISOString(),
      },
    }),
  }).catch(e => console.warn("VorabCheck-Save:", e.message));

  // Cost-Tracking
  await fetch(`${at}/API-Cost-Log`, {
    method: "POST", headers,
    body: JSON.stringify({
      fields: {
        check_nr: data.check_nr,
        endpoint: "vorabcheck",
        model: data.model,
        tokens_in: data.tokens_in,
        tokens_out: data.tokens_out,
        cost_eur: Math.round(data.cost_eur * 10000) / 10000,
        duration_ms: data.duration_ms,
        savedAt: new Date().toISOString(),
      },
    }),
  }).catch(e => console.warn("Cost-Log:", e.message));
}
