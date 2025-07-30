// api/elevenlabs-webhook.js
// Webhook ElevenLabs → Clientify con fallback de baseURL y saneo de token.

import axios from "axios";

// ─── Utilidades ───────────────────────────────────────────────
function isDryRun(req) {
  return (
    process.env.DRY_RUN === "true" ||
    req.query?.dryRun === "1" ||
    req.headers["x-dry-run"] === "true"
  );
}

function wrapIfFlat(raw) {
  if (!raw || typeof raw !== "object") return raw;
  if (raw.payload && raw.type && raw.intent) return raw;

  if (raw.name || raw.email || raw.phone) {
    const { name, email, phone, summary, source, tags, intent, type, ...rest } = raw;
    return {
      type: type || "intent_detected",
      intent: intent || "create_lead",
      payload: {
        name,
        email,
        phone,
        summary,
        source,
        tags: Array.isArray(tags) ? tags : tags ? [tags] : []
      },
      ...rest
    };
  }
  return raw;
}

// ─── Config Clientify (con fallback de host) ───────────────────
const PRIMARY_BASE  = (process.env.CLIENTIFY_BASE_URL?.trim()) || "https://api.clientify.com/api/v1";
const FALLBACK_BASE = "https://app.clientify.com/api/v1";

// Sanea token (quita comillas/CRLF/espacios)
const RAW_TOKEN = process.env.CLIENTIFY_TOKEN ?? "";
const CLEAN_TOKEN = String(RAW_TOKEN).replace(/^['"]|['"]$/g, "").replace(/[\r\n]/g, "").trim();
const AUTH_HEADER = `Token ${CLEAN_TOKEN}`;

function makeClient(baseURL) {
  return axios.create({
    baseURL,
    headers: { Authorization: AUTH_HEADER, Accept: "application/json" },
    timeout: 15000,
    // Evita que axios trate 404/500 como error antes de nuestro catch,
    // pero seguiremos lanzando manualmente si hace falta.
    validateStatus: () => true
  });
}

async function callWithFallback(doCall) {
  // 1º intento en PRIMARY_BASE
  let client = makeClient(PRIMARY_BASE);
  let res = await doCall(client);
  if (res && typeof res.status === "number" && res.status !== 404) return { res, usedBase: PRIMARY_BASE };

  // Si 404 o respuesta HTML “Clientify - 404”, probamos FALLBACK_BASE
  const looksLikeHtml404 =
    typeof res?.data === "string" && /<title>.*Clientify.*404/i.test(res.data);

  if (res?.status === 404 || looksLikeHtml404) {
    client = makeClient(FALLBACK_BASE);
    const res2 = await doCall(client);
    return { res: res2, usedBase: FALLBACK_BASE };
  }

  return { res, usedBase: PRIMARY_BASE };
}

// ─── Helpers de negocio ────────────────────────────────────────
async function findContactBy(field, value) {
  if (!value) return { res: null, usedBase: null };
  const { res, usedBase } = await callWithFallback((client) =>
    client.get("/contacts/", { params: { [field]: value } })
  );
  if (res.status >= 200 && res.status < 300) {
    return { res: res.data.results?.[0] ?? null, usedBase };
  }
  throw new Error(`findContactBy ${field}=${value} -> ${res.status} @ ${usedBase}`);
}

async function createContact({ name, email, phone, source, tags = [] }) {
  const payload = {
    name, email, phone,
    tags: ["AI_Agent", source].filter(Boolean).concat(tags || [])
  };
  const { res, usedBase } = await callWithFallback((client) =>
    client.post("/contacts/", payload)
  );
  if (res.status >= 200 && res.status < 300) return { data: res.data, usedBase };
  throw new Error(`createContact -> ${res.status} @ ${usedBase} :: ${JSON.stringify(res.data)}`);
}

async function createDeal({ name, contactId, stage = 1 }) {
  const body = { name, contact: contactId, stage };
  const { res, usedBase } = await callWithFallback((client) =>
    client.post("/deals/", body)
  );
  if (res.status >= 200 && res.status < 300) return { data: res.data, usedBase };
  throw new Error(`createDeal -> ${res.status} @ ${usedBase} :: ${JSON.stringify(res.data)}`);
}

async function addNote({ contactId, content }) {
  const { res, usedBase } = await callWithFallback((client) =>
    client.post("/notes/", { content, contact: contactId })
  );
  if (res.status >= 200 && res.status < 300) return { data: res.data, usedBase };
  throw new Error(`addNote -> ${res.status} @ ${usedBase} :: ${JSON.stringify(res.data)}`);
}

// ─── Validaciones ──────────────────────────────────────────────
function validateEnvelope(body) {
  if (!body || typeof body !== "object") return "Body vacío o no es JSON";
  const { type, intent, payload } = body;
  if (type !== "intent_detected") return "type debe ser 'intent_detected'";
  if (!intent) return "Falta 'intent'";
  if (!payload || typeof payload !== "object") return "Falta 'payload'";
  return null;
}

function validateCreateLeadPayload(p) {
  if (!p?.name) return "Falta 'name' en payload";
  if (!p.email && !p.phone) return "Debes enviar al menos 'email' o 'phone'";
  return null;
}

// ─── Handler ───────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    // Secret opcional
    if (process.env.ELEVENLABS_SECRET) {
      const incoming = req.headers["x-elevenlabs-secret"];
      if (incoming !== process.env.ELEVENLABS_SECRET) {
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    // Sanea token
    if (!CLEAN_TOKEN) return res.status(500).json({ error: "CLIENTIFY_TOKEN no está definido" });

    // Normaliza body
    let body = req.body;
    console.log("Evento recibido (raw):", JSON.stringify(body));
    body = wrapIfFlat(body);

    // Dry-run
    const dryRun = isDryRun(req);
    if (dryRun) {
      return res.status(200).json({
        ok: true,
        mode: "dry-run",
        intent: body.intent ?? "unknown",
        received: body.payload ?? body
      });
    }

    // Validación formal
    const vErr = validateEnvelope(body);
    if (vErr) return res.status(400).json({ error: vErr });

    const { intent, payload } = body;

    switch (intent) {
      case "create_lead": {
        const pErr = validateCreateLeadPayload(payload);
        if (pErr) return res.status(400).json({ error: pErr });

        const { name, email, phone, summary, source, tags } = payload;

        // 1) Buscar contacto
        let contact = null, baseUsed = null;
        if (email) {
          const r = await findContactBy("email", email);
          contact = r.res; baseUsed = r.usedBase;
        }
        if (!contact && phone) {
          const r = await findContactBy("phone", phone);
          contact = r.res; baseUsed = baseUsed || r.usedBase;
        }

        // 2) Crear contacto si no existe
        if (!contact) {
          const r = await createContact({ name, email, phone, source, tags });
          contact = r.data; baseUsed = baseUsed || r.usedBase;
        }

        // 3) Crear deal (si falla por stage, lo registramos y seguimos)
        let deal = null;
        try {
          const r = await createDeal({
            name: `Lead de ${name}`,
            contactId: contact.id,
            stage: 1 // Ajusta al ID válido de tu pipeline si hace falta
          });
          deal = r.data;
          baseUsed = baseUsed || r.usedBase;
        } catch (e) {
          console.warn("⚠️ Fallo creando deal:", e.message);
        }

        // 4) Nota opcional
        if (summary) {
          try {
            const r = await addNote({ contactId: contact.id, content: summary });
            baseUsed = baseUsed || r.usedBase;
          } catch (e) {
            console.warn("⚠️ Fallo creando nota:", e.message);
          }
        }

        console.log("OK Clientify @", baseUsed, { contactId: contact.id, dealId: deal?.id || null });
        return res.status(200).json({ ok: true, contactId: contact.id, dealId: deal?.id || null, base: baseUsed });
      }

      default:
        return res.status(200).json({ ok: true, message: `Intent '${intent}' no implementado (ignorado)` });
    }
  } catch (err) {
    console.error(
      "ERROR:",
      err.response?.status,
      err.response?.config?.baseURL,
      err.response?.config?.url,
      err.response?.data || err.message
    );
    return res.status(500).json({
      error: "Clientify integration failed",
      status: err.response?.status,
      base: err.response?.config?.baseURL,
      url: err.response?.config?.url,
      details: err.response?.data || err.message
    });
  }
}
