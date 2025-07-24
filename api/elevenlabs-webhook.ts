// api/elevenlabs-webhook.js
import { findContactByEmail, createContact, createDeal, addNote } from "./clientify.js"; // ¡con extensión!

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    console.log("Body:", req.body);
    // ... tu lógica
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("ERR:", err?.response?.data || err);
    return res.status(500).json({ error: "boom" });
  }
}
