// api/elevenlabs-webhook.js
// ──────────────────────────────────────────────────────────────
// Webhook ElevenLabs → Clientify (todo en un solo archivo)
//
// ✅ Acepta dos formatos de entrada:
//    1) Con sobre completo:
//       { type:"intent_detected", intent:"create_lead", payload:{ name, email, ... } }
//    2) Plano (lo que ElevenLabs puede enviar):
//       { name, email, phone, summary, ... }
//
// ✅ DRY-RUN: desactivado por defecto si no tienes DRY_RUN=true ni ?dryRun=1 ni x-dry-run:true
// 🔐 Secret opcional en header: x-elevenlabs-secret
//
// ⚠️ Token:
//    - Usamos process.env.CLIENTIFY_TOKEN
//    - Fallback SOLO PARA PRUEBAS con tu token pegado. ELIMÍNALO LUEGO.
//
// ──────────────────────────────────────────────────────────────

import axios from "axios";

// =============== Utilidades generales =========================
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

// =============== Config Clientify ==============================
const CLIENTIFY_BASE = "https://api.clientify.com/api/v1";

// ⚠️ Fallback con tu token SOLO para pruebas locales.
//    Si la env var existe, se usa la env var.
//    Elimina el fallback antes de dejarlo definitivo.
const RAW_TOKEN = (process.env.CLIENTIFY_TOKEN ?? "62c037ea6bef52b2297bf655ab7fdf72ee528e4a");

// Saneo: quita comillas, CR/LF y espacios
const CLEAN_TOKEN = String(RAW_TOKEN)
  .replace(/^['"]|['"]$/g, "")
  .replace(/[\r\n]/g, "")
  .trim();

const AUTH_HEADER = `Token ${CLEAN_TOKEN}`;

const clientify = axios.create({
  baseURL: CLIENTIFY_BASE,
  headers: { Authorization: AUTH_HEADER },
  timeout: 15000
});

// Helpers de Clientify
async function findContactBy(field, value) {
  if (!value) return null;
  const res = await clientify.get("/contacts/", { params: { [field]: value } });
  return res.data.results?.[0] ?? null;
}

async function createContact({ name, email, phone, source, tags = [] }) {
  const payload = {
    name,
    email,
    phone,
    tags: ["AI_Agent", source].filter(Boolean).concat(tags || [])
  };
  const res = await clientify.post("/contacts/", payload);
  return res.data;
}

async function createDeal({ name, contactId, stage = 1 }) {
  const res = await clientify.post("/deals/", {
    name,
    contact: contactId,
    stage
  });
  return res.data;
}

async function addNote({ contactId, content }) {
  // Ajusta si tu instancia usa otro recurso para notas
  return clientify.post("/notes/", { content, contact: contactId });
}

// =============== Validaciones ================================
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

// =============== Handler principal ============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    // Secret opcional
    if (process.env.ELEVENLABS_SECRET) {
      const incoming = req.headers["x-elevenlabs-secret"];
      if (incoming !== process.env.ELEVENLABS_SECRET) {
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    // Body
    let body = req.body;
    console.log("Evento recibido (raw):", JSON.stringify(body));
    body = wrapIfFlat(body);

    // Dry-run temprano
    const dryRun = isDryRun(req);
    if (dryRun) {
      return res.status(200).json({
        ok: true,
        mode: "dry-run",
        intent: body.intent ?? "unknown",
        received: body.payload ?? body
      });
    }

    // Validaciones formales
    const envError = validateEnvelope(body);
    if (envError) return res.status(400).json({ error: envError });

    const { intent, payload } = body;

    if (!CLEAN_TOKEN) {
      return res.status(500).json({ error: "CLIENTIFY_TOKEN no está definido" });
    }

    switch (intent) {
      case "create_lead": {
        const pError = validateCreateLeadPayload(payload);
        if (pError) return res.status(400).json({ error: pError });

        const { name, email, phone, summary, source, tags } = payload;

        // 1) Buscar contacto
        let contact =
          (email && (await findContactBy("email", email))) ||
          (phone && (await findContactBy("phone", phone)));

        // 2) Crear si no existe
        if (!contact) {
          contact = await createContact({ name, email, phone, source, tags });
        }

        // 3) Crear deal (si falla por stage, no abortamos toda la operación)
        let deal = null;
        try {
          deal = await createDeal({
            name: `Lead de ${name}`,
            contactId: contact.id,
            stage: 1 // Ajusta al ID de stage válido en tu pipeline
          });
        } catch (e) {
          console.warn("⚠️ Fallo creando deal:", e.response?.status, e.response?.data || e.message);
        }

        // 4) Nota opcional
        if (summary) {
          try {
            await addNote({ contactId: contact.id, content: summary });
          } catch (e) {
            console.warn("⚠️ Fallo creando nota:", e.response?.status, e.response?.data || e.message);
          }
        }

        console.log("CREADO:", { contactId: contact.id, dealId: deal?.id || null });
        return res.status(200).json({
          ok: true,
          contactId: contact.id,
          dealId: deal?.id || null
        });
      }

      default:
        return res.status(200).json({
          ok: true,
          message: `Intent '${intent}' no implementado (ignorado)`
        });
    }
  } catch (err) {
    console.error(
      "ERROR:",
      err.response?.status,
      err.response?.config?.url,
      err.response?.data || err.message,
      err.stack
    );
    return res.status(500).json({
      error: "Clientify integration failed",
      status: err.response?.status,
      url: err.response?.config?.url,
      details: err.response?.data || err.message
    });
  }
}
