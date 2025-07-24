import { VercelRequest, VercelResponse } from "@vercel/node";
import { findContactByEmail, createContact, createDeal, addNote } from "./clientify.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") return res.status(405).send("Only POST");

    // Verifica firma si ElevenLabs la envía
    // const signature = req.headers["x-elevenlabs-signature"]; // TODO: validar

    const event = req.body; // asegúrate de usar middleware json en Vercel (ya viene)
    // Estructura ejemplo:
    // { type: "intent_detected", intent: "create_lead", payload: { name, email, phone, summary } }

    if (event.type === "intent_detected" && event.intent === "create_lead") {
      const { name, email, phone, summary } = event.payload;

      let contact = await findContactByEmail(email);
      if (!contact) {
        contact = await createContact({ name, email, phone });
      }

      const deal = await createDeal({ name: `Lead de ${name}`, contactId: contact.id });

      if (summary) {
        await addNote({ contactId: contact.id, content: summary });
      }

      return res.status(200).json({
        ok: true,
        contactId: contact.id,
        dealId: deal.id
      });
    }

    res.status(200).json({ ok: true, message: "Evento ignorado" });
  } catch (err: any) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: "Clientify integration failed" });
  }
}
