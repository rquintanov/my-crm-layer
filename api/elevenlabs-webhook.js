// api/elevenlabs-webhook.js
// ──────────────────────────────────────────────────────────────
// Webhook ElevenLabs → Clientify (todo en un solo archivo)
// Requiere (cuando NO estás en dry-run):
//   - CLIENTIFY_TOKEN  → Vercel > Settings > Environment Variables
// Opcional:
//   - ELEVENLABS_SECRET → para validar que el webhook viene de ElevenLabs
//   - DRY_RUN=true      → para no llamar a Clientify (eco de parámetros)
//
// Puedes activar el dry-run también con:
//   - Query param:  ?dryRun=1
//   - Header:       x-dry-run: true
// ──────────────────────────────────────────────────────────────

import axios from "axios";

// ---------- Utilidades ----------
function isDryRun(req) {
  return (
    process.env.DRY_RUN === "true" ||
    req.query?.dryRun === "1" ||
    req.headers["x-dry-run"] === "true"
  );
}

// ---------- Config Clientify ----------
const CLIENTIFY_BASE = "https://api.clientify.com/api/v1";
const CLIENTIFY_TOKEN = process.env.CLIENTIFY_TOKEN;

const clientify = axios.create({
  baseURL: CLIENTIFY_BASE,
  headers: { Authorization: `Token ${CLIENTIFY_TOKEN}` },
  timeout: 15000
});

// ---------- Helpers Clientify ----------
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

// ---------- Validaciones ----------
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
  if (!p.email && !p.phone)
    return "Debes enviar al menos 'email' o 'phone' en payload";
  return null;
}

// ---------- Handler principal ----------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const dryRun = isDryRun(req);

    // Validación de secret opcional
    if (process.env.ELEVENLABS_SECRET) {
      const incoming = req.headers["x-elevenlabs-secret"];
      if (incoming !== process.env.ELEVENLABS_SECRET) {
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    const body = req.body;
    console.log("Evento recibido:", JSON.stringify(body, null, 2));
    const envError = validateEnvelope(body);
    if (envError) return res.status(400).json({ error: envError });

    const { intent, payload } = body;

    // Si estamos en dry-run devolvemos eco y salimos
    if (dryRun) {
      return res.status(200).json({
        ok: true,
        mode: "dry-run",
        intent,
        received: payload
      });
    }

    // A partir de aquí, se llama a Clientify
    if (!CLIENTIFY_TOKEN) {
      return res
        .status(500)
        .json({ error: "CLIENTIFY_TOKEN no está definido" });
    }

    switch (intent) {
      case "create_lead": {
        const pError = validateCreateLeadPayload(payload);
        if (pError) return res.status(400).json({ error: pError });

        const { name, email, phone, summary, source, tags } = payload;

        // 1. Buscar contacto existente
        let contact =
          (email && (await findContactBy("email", email))) ||
          (phone && (await findContactBy("phone", phone)));

        // 2. Crear si no existe
        if (!contact) {
          contact = await createContact({ name, email, phone, source, tags });
        }

        // 3. Crear deal
        const deal = await createDeal({
          name: `Lead de ${name}`,
          contactId: contact.id,
          stage: 1
        });

        // 4. Nota opcional
        if (summary) {
          await addNote({ contactId: contact.id, content: summary });
        }

        return res.status(200).json({
          ok: true,
          contactId: contact.id,
          dealId: deal.id
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
