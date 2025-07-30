// api/elevenlabs-webhook.js
// ElevenLabs → Clientify (api.clientify.net/v1)

import axios from "axios";

// ── Utilidades ───────────────────────────────────────────────
function isDryRun(req) {
  return (
    process.env.DRY_RUN === "true" ||
    req.query?.dryRun === "1" ||
    req.headers["x-dry-run"] === "true"
  );
}

function wrapIfFlat(raw) {
  if (!raw || typeof raw !== "object") return raw;
  if (raw.payload && raw.type && raw.intent) return raw; // ya viene envuelto
  // Formato plano -> lo envolvemos
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

// ── Config Clientify ─────────────────────────────────────────
// Base oficial (puedes sobreescribir con env var)
const CLIENTIFY_BASE =
  (process.env.CLIENTIFY_BASE_URL?.trim()) || "https://api.clientify.net/v1";

// Sanea token (sin comillas/saltos)
const RAW_TOKEN = process.env.CLIENTIFY_TOKEN || "";
const CLEAN_TOKEN = String(RAW_TOKEN).replace(/^['"]|['"]$/g, "").replace(/[\r\n]/g, "").trim();

const clientify = axios.create({
  baseURL: CLIENTIFY_BASE,
  headers: { Authorization: `Token ${CLEAN_TOKEN}`, Accept: "application/json" },
  timeout: 15000,
  validateStatus: () => true // dejamos pasar para gestionar nosotros los códigos
});

// ── Helpers de Clientify ─────────────────────────────────────
// Split “Nombre Apellidos” en first/last_name
function splitName(full = "") {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length === 0) return { first_name: "", last_name: "" };
  if (parts.length === 1) return { first_name: parts[0], last_name: "" };
  return { first_name: parts[0], last_name: parts.slice(1).join(" ") };
}

// Normaliza comparación de email en resultados
function contactHasEmail(contact, email) {
  if (!email) return false;
  const target = String(email).toLowerCase();
  const list = contact?.emails;
  if (!list) return false;
  // A veces es array de strings, otras de objetos {email:""}
  if (Array.isArray(list)) {
    return list.some(e =>
      typeof e === "string"
        ? e.toLowerCase() === target
        : (e?.email || "").toLowerCase() === target
    );
  }
  return false;
}

async function searchByEmail(email) {
  // No hay param directo de email documentado; usamos `query=` y filtramos exacto.
  const res = await clientify.get("/contacts/", { params: { query: email } });
  if (res.status >= 200 && res.status < 300) {
    const match = (res.data?.results || []).find(c => contactHasEmail(c, email));
    return { contact: match || null, raw: res };
  }
  return { contact: null, raw: res };
}

async function searchByPhone(phone) {
  const res = await clientify.get("/contacts/", { params: { phone } });
  if (res.status >= 200 && res.status < 300) {
    // devolvemos el primero; afina si necesitas normalizar el número
    const match = (res.data?.results || [])[0] || null;
    return { contact: match, raw: res };
  }
  return { contact: null, raw: res };
}

async function createContact({ name, email, phone, source, tags = [], summary }) {
  const { first_name, last_name } = splitName(name);
  const body = {
    first_name,
    last_name,
    email,
    phone,
    contact_source: source || "AI Agent",
    tags: tags || [],
    summary: summary || ""
  };
  const res = await clientify.post("/contacts/", body);
  if (res.status >= 200 && res.status < 300) return res.data;
  throw new Error(`createContact -> ${res.status} ${JSON.stringify(res.data)}`);
}

async function addNote({ contactId, summary }) {
  if (!summary) return;
  // Ruta documentada: POST /contacts/:id/note/
  const body = { name: "Nota del agente", comment: summary };
  const res = await clientify.post(`/contacts/${contactId}/note/`, body);
  if (res.status >= 200 && res.status < 300) return res.data;
  // Si tu cuenta no tiene notas habilitadas, no rompemos el flujo:
  throw new Error(`addNote -> ${res.status} ${JSON.stringify(res.data)}`);
}

// ── Validaciones ─────────────────────────────────────────────
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

// ── Handler ──────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    if (!CLEAN_TOKEN) return res.status(500).json({ error: "CLIENTIFY_TOKEN no está definido" });

    // Secret opcional (si lo configuras en Vercel y en ElevenLabs)
    if (process.env.ELEVENLABS_SECRET) {
      const incoming = req.headers["x-elevenlabs-secret"];
      if (incoming !== process.env.ELEVENLABS_SECRET) {
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    let envelope = wrapIfFlat(req.body);
    const dryRun = isDryRun(req);

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        mode: "dry-run",
        intent: envelope.intent ?? "unknown",
        received: envelope.payload ?? envelope
      });
    }

    const err = validateEnvelope(envelope);
    if (err) return res.status(400).json({ error: err });

    const { intent, payload } = envelope;

    switch (intent) {
      case "create_lead": {
        const pErr = validateCreateLeadPayload(payload);
        if (pErr) return res.status(400).json({ error: pErr });

        const { name, email, phone, summary, source, tags } = payload;

        // 1) Buscar contacto por email exacto (via query) y si no, por teléfono
        let contact = null;
        if (email) {
          const r = await searchByEmail(email);
          if (r.raw.status === 404) {
            return res.status(500).json({
              error: "Clientify integration failed",
              details: `GET /contacts/?query=${email} devolvió 404 en ${CLIENTIFY_BASE}`
            });
          }
          contact = r.contact;
        }

        if (!contact && phone) {
          const r = await searchByPhone(phone);
          if (r.raw.status === 404) {
            return res.status(500).json({
              error: "Clientify integration failed",
              details: `GET /contacts/?phone=${phone} devolvió 404 en ${CLIENTIFY_BASE}`
            });
          }
          contact = r.contact;
        }

        // 2) Crear si no existe
        if (!contact) {
          contact = await createContact({ name, email, phone, source, tags, summary });
        }

        // 3) Nota (opcional)
        try { await addNote({ contactId: contact.id, summary }); } catch (e) { console.warn(e.message); }

        return res.status(200).json({
          ok: true,
          base: CLIENTIFY_BASE,
          contactId: contact.id
        });
      }

      default:
        return res.status(200).json({
          ok: true,
          message: `Intent '${intent}' no implementado`
        });
    }
  } catch (e) {
    console.error("ERROR", e.response?.status, e.response?.config?.url, e.response?.data || e.message);
    return res.status(500).json({
      error: "Clientify integration failed",
      status: e.response?.status,
      url: e.response?.config?.url,
      details: e.response?.data || e.message
    });
  }
}

