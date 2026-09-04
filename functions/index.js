/* =====================================================================
   functions/index.js — the ONE Cloud Function in this project.
   Pod C owns this file.
   ---------------------------------------------------------------------
   It exists for exactly one reason: to keep the Gemini API key off the
   client. Everything else in the app talks to Firestore directly.
   One function = one deploy target = one thing that can break.

   Deploy:
     firebase functions:secrets:set GEMINI_API_KEY
     firebase deploy --only functions
   ===================================================================== */

const { onRequest }     = require("firebase-functions/v2/https");
const { defineSecret }  = require("firebase-functions/params");
const { logger }        = require("firebase-functions");
const { answerLocally, buildSystemPrompt } = require("./fallback");

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

/* Override with `firebase functions:config` style env if a newer model ships. */
const API = "https://generativelanguage.googleapis.com/v1beta/models";
const CANDIDATE_MODELS = process.env.GEMINI_MODEL 
  ? [process.env.GEMINI_MODEL, "gemini-3.6-flash", "gemini-flash-latest"]
  : ["gemini-3.6-flash", "gemini-flash-latest", "gemini-3.7-flash"];

exports.askPetCareAI = onRequest(
  {
    region: "asia-south1",          // Mumbai — closest to the demo
    cors: true,                     // Firebase Hosting serves the client
    secrets: [GEMINI_API_KEY],
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 5
  },
  async (req, res) => {
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

    const question = String(req.body?.question || "").slice(0, 500).trim();

    /* the client pings this at boot to beat the cold start */
    if (question === "__warmup__") return res.json({ ok: true, warm: true });
    if (!question) return res.status(400).json({ error: "question is required" });

    /* Whichever pet is open on the dashboard right now — never trusted
       beyond a handful of display fields, and never merged with any
       other pet. See sanitizePet(). */
    const pet = sanitizePet(req.body?.pet);
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-10) : [];

    const key = GEMINI_API_KEY.value();

    /* No key configured → deterministic responder. The demo still works. */
    if (!key) {
      logger.warn("GEMINI_API_KEY not set — using the rule-based responder.");
      return res.json(answerLocally(question, pet));
    }

    try {
      const reply = await askGemini(question, history, key, pet);
      logger.info("gemini ok", { urgency: reply.urgency, chars: reply.answer.length, model: reply.modelUsed });
      return res.json({ ...reply, source: "gemini" });
    } catch (err) {
      logger.error("gemini failed, falling back", err);
      return res.json(answerLocally(question, pet));
    }
  }
);

/* Only the fields the prompt actually uses, clipped to a sane length —
   this is untrusted client input. */
function sanitizePet(p) {
  if (!p || typeof p !== "object") return null;
  const clip = (s, n) => String(s || "").slice(0, n);
  const name = clip(p.name, 60);
  if (!name) return null;
  return {
    name,
    species: clip(p.species, 30),
    breed: clip(p.breed, 60),
    ageYears: Number.isFinite(Number(p.ageYears)) ? Number(p.ageYears) : null,
    specialInstructions: {
      allergy:    clip(p.specialInstructions?.allergy, 300),
      medication: clip(p.specialInstructions?.medication, 300),
      notes:      clip(p.specialInstructions?.notes, 300)
    }
  };
}

/* ------------------------------------------------------------------ */
async function askGemini(question, history, key, pet) {
  const formattedHistory = (history || [])
    .filter((h) => h && h.role && h.text)
    .map((h) => ({
      role: h.role === "bot" || h.role === "model" ? "model" : "user",
      parts: [{ text: String(h.text).slice(0, 500) }]
    }));

  const contents = [
    ...formattedHistory,
    { role: "user", parts: [{ text: question }] }
  ];

  const body = {
    systemInstruction: { parts: [{ text: buildSystemPrompt(pet) }] },
    contents,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 1200,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          answer:      { type: "STRING" },
          urgency:     { type: "STRING", enum: ["routine", "soon", "emergency"] },
          showVets:    { type: "BOOLEAN" },
          vetFilter:   { type: "STRING", enum: ["emergency", "general", "none"] },
          suggestions: { type: "ARRAY", items: { type: "STRING" } }
        },
        required: ["answer", "urgency", "showVets", "suggestions"]
      }
    }
  };

  let r;
  let modelUsed = "";
  let lastErr = "";

  for (const m of CANDIDATE_MODELS) {
    try {
      r = await fetch(`${API}/${m}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (r.ok) {
        modelUsed = m;
        break;
      }
      const errTxt = await r.text();
      lastErr = `Gemini ${m} (${r.status}): ${errTxt.slice(0, 150)}`;
    } catch (err) {
      lastErr = err.message;
    }
  }

  if (!r || !r.ok) throw new Error(`Gemini API failed across candidate models: ${lastErr}`);

  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content");

  const parsed = JSON.parse(text);

  /* Safety net: whatever the model says, our own keyword check can only
     escalate urgency, never lower it. */
  const local = answerLocally(question, pet);
  const rank  = { routine: 0, soon: 1, emergency: 2 };
  const urgency = rank[local.urgency] > rank[parsed.urgency] ? local.urgency : parsed.urgency;

  return {
    answer:      String(parsed.answer || "").slice(0, 1200),
    urgency,
    showVets:    urgency !== "routine" ? true : Boolean(parsed.showVets),
    vetFilter:   urgency === "emergency" ? "emergency"
                 : (parsed.vetFilter && parsed.vetFilter !== "none" ? parsed.vetFilter : null),
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 4) : [],
    modelUsed
  };
}
