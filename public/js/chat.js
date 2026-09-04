/* =====================================================================
   chat.js — the AI bubble.
   Pod C owns this file.
   ---------------------------------------------------------------------
   Calls the Cloud Function when AI_ENDPOINT is set, and falls back to the
   local keyword responder otherwise — or when the call fails. The panel
   always answers, which is what makes the demo safe.
   ===================================================================== */

import { $, esc } from "./ui.js";
import { AI_ENDPOINT, isAiConfigured } from "./config.js";
import { answerLocally, DISCLAIMER } from "./ai-fallback.js";
import { showVets } from "./vets.js";

const OPENERS = [
  "My pet is not eating",
  "What if I missed a dose?",
  "Find a vet nearby",
  "What counts as an emergency?"
];

let busy = false;
let currentPet = null;   // whichever pet is open on the dashboard right now
let conversationHistory = []; // multi-turn conversation history for Gemini chatbot

/** app.js calls this on every pet switch, so a question asked as "my pet"
    always resolves to whichever pet is currently selected — never a pet
    left over from before the switch. */
export function setPetContext(pet) {
  if (currentPet?.id !== pet?.id) {
    conversationHistory = [];
  }
  currentPet = pet;
}

export function init() {
  $("#aiDisclaimer").textContent = DISCLAIMER;
  $("#aiSource").textContent = isAiConfigured()
    ? "Powered by Gemini 3.7 Flash · general care guidance"
    : "Rule-based responder · general care guidance";

  $("#aiFab").addEventListener("click", open);
  $("#aiClose").addEventListener("click", close);

  $("#aiForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#aiInput");
    const q = input.value.trim();
    if (!q || busy) return;
    input.value = "";
    ask(q);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#aiPanel").hidden) close();
  });

  greet();
}

export function open() {
  $("#aiPanel").hidden = false;
  $("#aiFab").classList.add("is-hidden");
  $("#aiFab").setAttribute("aria-expanded", "true");
  setTimeout(() => $("#aiInput").focus(), 60);
}

export function close() {
  $("#aiPanel").hidden = true;
  $("#aiFab").classList.remove("is-hidden");
  $("#aiFab").setAttribute("aria-expanded", "false");
}

/** Ask a question from outside the panel (e.g. a dashboard shortcut). */
export function askFromOutside(q) { open(); ask(q); }

function greet() {
  bubble("bot", "Hi! How can I help with your pet? I can answer general care questions and help you find veterinary care.");
  suggestions(OPENERS);
}

async function ask(question) {
  busy = true;
  bubble("user", question);
  suggestions([]);
  const typing = showTyping();

  let reply;
  try {
    if (isAiConfigured()) {
      reply = await callFunction(question);
    } else {
      try {
        reply = await callGeminiDirect(question);
      } catch (geminiErr) {
        console.info("[PetCare] Gemini Direct call fallback notice:", geminiErr.message);
        reply = answerLocally(question, currentPet);
      }
    }

    if (reply?.answer) {
      conversationHistory.push({ role: "user", text: question });
      conversationHistory.push({ role: "model", text: reply.answer });
      if (conversationHistory.length > 10) {
        conversationHistory = conversationHistory.slice(-10);
      }
    }
  } catch (err) {
    console.warn("[PetCare] AI call failed, using local responder.", err);
    reply = answerLocally(question, currentPet);
  }
  typing.remove();
  renderReply(reply);
  busy = false;
}

async function callFunction(question) {
  const res = await fetch(AI_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      petId: currentPet?.id || null,
      pet: petContextPayload(),
      history: conversationHistory
    }),
    signal: AbortSignal.timeout ? AbortSignal.timeout(30_000) : undefined
  });
  if (!res.ok) throw new Error(`AI endpoint returned ${res.status}`);
  return await res.json();
}

async function callGeminiDirect(question) {
  const key = firebaseConfig?.apiKey;
  if (!key || key.startsWith("PASTE_")) throw new Error("No API key configured");

  const systemPrompt = `You are PetCare AI, the assistant inside a pet-owner dashboard.
Give general pet-care information only. NEVER state, imply, or guess a diagnosis.
If symptoms could be serious (breathing, choking, seizures, collapse, bleeding, poison, bloat, severe pain), set urgency to "emergency".
Use urgency "soon" for symptoms needing a vet today; "routine" for general care. Keep answer under 90 words.
Active pet context: ${currentPet ? `Name: ${currentPet.name}, Species: ${currentPet.species}, Breed: ${currentPet.breed || "N/A"}, Age: ${currentPet.ageYears || "N/A"}` : "General pet"}`;

  const formattedHistory = (conversationHistory || [])
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
    systemInstruction: { parts: [{ text: systemPrompt }] },
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

  const candidateModels = ["gemini-3.6-flash", "gemini-flash-latest", "gemini-3.7-flash"];
  let res;
  let lastErr = "";

  for (const m of candidateModels) {
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout ? AbortSignal.timeout(30_000) : undefined
      });
      if (res.ok) break;
      const errText = await res.text();
      lastErr = `Gemini ${m} ${res.status}: ${errText.slice(0, 150)}`;
    } catch (err) {
      lastErr = err.message;
    }
  }

  if (!res || !res.ok) {
    throw new Error(`Gemini API failed across candidate models: ${lastErr}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No text returned from Gemini API");

  const parsed = JSON.parse(text);
  const local = answerLocally(question, currentPet);
  const rank = { routine: 0, soon: 1, emergency: 2 };
  const urgency = rank[local.urgency] > rank[parsed.urgency] ? local.urgency : parsed.urgency;

  return {
    answer: String(parsed.answer || "").slice(0, 1200),
    urgency,
    showVets: urgency !== "routine" ? true : Boolean(parsed.showVets),
    vetFilter: urgency === "emergency" ? "emergency" : (parsed.vetFilter && parsed.vetFilter !== "none" ? parsed.vetFilter : null),
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 4) : [],
    source: "gemini"
  };
}

/** Only the fields the system prompt actually needs — never the whole
    pet document (memberUids, joinCode, and so on have no business
    leaving the browser for this call). */
function petContextPayload() {
  if (!currentPet) return null;
  return {
    name: currentPet.name,
    species: currentPet.species,
    breed: currentPet.breed,
    ageYears: currentPet.ageYears,
    specialInstructions: currentPet.specialInstructions || {}
  };
}

function renderReply(reply) {
  const urgency = reply.urgency || "routine";
  bubble("bot", reply.answer, urgency);

  $("#aiSource").textContent = reply.source === "gemini"
    ? "Powered by Gemini · general care guidance"
    : "Rule-based responder · general care guidance";

  if (reply.showVets) {
    const note = urgency === "emergency"
      ? "This may be an emergency. Contact a veterinary hospital now."
      : "";
    /* emergencies open the list immediately — no extra click on stage */
    if (urgency === "emergency") {
      showVets("emergency", note, true);
    } else {
      actionRow([
        { label: "🏥 Find a vet", run: () => showVets(reply.vetFilter, "", false) }
      ]);
    }
  }
  suggestions(reply.suggestions?.length ? reply.suggestions : OPENERS);
}

/* ---------------- rendering helpers ---------------- */

function bubble(who, text, urgency) {
  const body = $("#aiBody");
  const div = document.createElement("div");
  div.className = `msg ${who}` + (urgency && urgency !== "routine" ? ` u-${urgency}` : "");
  const flag = urgency === "emergency" ? "Seek veterinary care now"
             : urgency === "soon"      ? "Contact a vet if this continues"
             : "";
  div.innerHTML = (flag ? `<span class="u-flag">${esc(flag)}</span>` : "") + esc(text);
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
  return div;
}

function showTyping() {
  const body = $("#aiBody");
  const el = document.createElement("div");
  el.className = "typing";
  el.innerHTML = "<i></i><i></i><i></i>";
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  return el;
}

function actionRow(actions) {
  const body = $("#aiBody");
  const row = document.createElement("div");
  row.className = "ai-suggest";
  row.style.padding = "0";
  for (const a of actions) {
    const b = document.createElement("button");
    b.textContent = a.label;
    b.addEventListener("click", a.run);
    row.appendChild(b);
  }
  body.appendChild(row);
  body.scrollTop = body.scrollHeight;
}

function suggestions(items) {
  const wrap = $("#aiSuggest");
  wrap.innerHTML = "";
  for (const s of items) {
    const b = document.createElement("button");
    b.textContent = s;
    b.addEventListener("click", () => {
      if (/24\/7|hospital/i.test(s)) { showVets("emergency", "", false); return; }
      if (/export/i.test(s)) { document.getElementById("btnExportCsv")?.click(); return; }
      if (!busy) ask(s);
    });
    wrap.appendChild(b);
  }
}

/* Warms the Cloud Function so the first question on stage is not the one
   that pays for the cold start. Called once at boot. */
export function prewarm() {
  if (!isAiConfigured()) return;
  fetch(AI_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "__warmup__" })
  }).catch(() => {});
}
