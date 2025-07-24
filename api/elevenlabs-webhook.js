// api/elevenlabs-webhook.js
// ──────────────────────────────────────────────────────────────
// Webhook ElevenLabs → Clientify (todo en un solo archivo)
// Requiere:
//   - CLIENTIFY_TOKEN  (obligatorio)  → Vercel > Settings > Env Vars
//   - ELEVENLABS_SECRET (opcional)    → para validar que el webhook viene de ElevenLabs
// ----------------------------------------------------------------

import axios from "axios";

// ---------- Configuración Clientify ----------
const CLIENTIFY_TOKEN = process.env.CLIENTIFY_TOKEN;
const clientify = axios.create({
  baseURL: "https://api.clientify.com/api/v1",
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
  const res = await clientify.post("/contacts/", {
    name,
    email,
    phone,
    tags: ["AI_Agent", source].filter(Boolean).concat(tags)
  });
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
  // Ajusta si tu instancia usa otro endpoint para notas
  return clientify.post("/notes/", { content, contact: contactId });
}

// ---------- Validaciones básicas ----------
function validateEnvelope(body) {
  if (!body || typeof body !== "object") return "Body vacío o no es JSON";
  const { type, intent, payload } = body;
  if (type !== "intent_detected") return "type debe ser 'intent_detected'";
  if (!intent) return "Falta 'intent'";
  if (!payload || typeof payload !== "object") return "Falta 'payload'";
  return null;
}

function validateCreateLeadPayload(p) {
  if (!p.name) return "Falta 'name'";
  if (!p.email && !p.phone) return "Debes enviar al menos 'email' o 'phone'";
  return null;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    // Método
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

    // Token obligatorio
    if (!CLIENTIFY_TOKEN) {
      return res.status(500).json({ error: "CLIENTIFY_TOKEN no está definido" });
    }

    const body = req.body;
    console.log("Evento recibido:", JSON.stringify(body));

    // Validación general
    const envError = validateEnvelope(body);
    if (envError) return res.status(400).json({ error: envError });

    const { intent, payload } = body;

    switch (intent) {
      case "create_lead": {
        const pError = validateCreateLeadPayload(payload);
        if (pError) return res.status(400).json({ error: pError });

        const { name, email, phone, summary, source, tags } = payload;

        // 1. Buscar contacto por email, si no, por phone
        let contact = (email && await findContactBy("email", email)) ||
                      (phone && await findContactBy("phone", phone));

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
    console.error("ERROR:", err.response?.status, err.response?.data || err.message, err.stack);
    return res.status(500).json({
      error: "Clientify integration failed",
      details: err.response?.data || err.message
    });
  }
}
