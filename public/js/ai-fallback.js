/* =====================================================================
   ai-fallback.js — the deterministic responder.
   Pod C owns this.
   ---------------------------------------------------------------------
   Build this BEFORE touching Gemini. It runs in two places:
     · inside the Cloud Function, when the model call fails
     · here in the browser, when there is no Cloud Function at all
   Either way the demo answers questions. Nothing here is a diagnosis and
   every serious path ends at a veterinarian.
   Keep this file and functions/fallback.js in sync.
   ===================================================================== */

const RULES = [
  {
    id: "emergency",
    urgency: "emergency",
    keywords: [
      "breathing", "breathe", "choking", "choke", "seizure", "fitting",
      "collapse", "collapsed", "unconscious", "blood", "bleeding",
      "poison", "poisoned", "chocolate", "bloat", "swollen stomach",
      "hit by", "accident", "not moving", "pale gums", "won't wake"
    ],
    answer:
      "That can be an emergency. Please contact an emergency veterinary hospital right now rather than waiting to see if it improves. " +
      "On the way, keep your pet calm, quiet and warm, and do not give food, water or any medication unless a vet tells you to. " +
      "If you know what was swallowed, take the packaging with you.",
    showVets: true,
    vetFilter: "emergency",
    suggestions: ["Show 24/7 hospitals", "What should I tell the vet?"]
  },
  {
    id: "vomiting",
    urgency: "soon",
    keywords: ["vomit", "vomiting", "throwing up", "threw up", "puking", "nausea"],
    answer:
      "Vomiting has many possible causes, from a quick dietary upset to something more serious. " +
      "Withhold food for a few hours, keep small amounts of water available, and watch closely. " +
      "Contact a veterinarian promptly if it repeats, or if you see blood, weakness, a swollen belly, " +
      "difficulty breathing or no improvement within a day. I am not able to diagnose the cause — a vet can.",
    showVets: true,
    vetFilter: null,
    suggestions: ["Find a vet nearby", "What should I tell the vet?", "My pet is not eating"]
  },
  {
    id: "not-eating",
    urgency: "soon",
    keywords: ["not eating", "won't eat", "refusing food", "no appetite", "off food", "isn't eating"],
    answer:
      "A skipped meal happens, but a pet that refuses food for more than about 24 hours should be seen by a vet — " +
      "and sooner for a puppy, a senior, or a pet on medication. " +
      "Check for other changes: energy, drinking, toilet habits, vomiting, or anything new they might have eaten. " +
      "Try their usual food warmed slightly rather than switching to something rich.",
    showVets: true,
    vetFilter: null,
    suggestions: ["Find a vet nearby", "How often should I feed my dog?"]
  },
  {
    id: "diarrhoea",
    urgency: "soon",
    keywords: ["diarrhea", "diarrhoea", "loose motion", "loose stool", "upset stomach"],
    answer:
      "Mild loose stools often settle within a day on a bland diet and plenty of water. " +
      "Contact a vet if you see blood, if it lasts more than 24–48 hours, or if your pet is also " +
      "vomiting, lethargic or refusing water — dehydration is the real risk here.",
    showVets: true,
    vetFilter: null,
    suggestions: ["Find a vet nearby", "My pet is vomiting"]
  },
  {
    id: "missed-dose",
    urgency: "soon",
    keywords: ["missed", "forgot", "skipped dose", "double dose", "late dose", "miss a medication", "missed medication"],
    answer:
      "Do not give two doses to catch up. For most daily medications you give the missed dose if you remember " +
      "reasonably soon, then return to the normal schedule — but the safe answer depends on the specific drug, " +
      "so call your vet or the pharmacy on the label before deciding. " +
      "Log what you actually gave in the app so whoever takes over next can see it.",
    showVets: true,
    vetFilter: null,
    suggestions: ["Find a vet nearby", "What should I tell the vet?"]
  },
  {
    id: "medication",
    urgency: "routine",
    keywords: ["medication", "medicine", "tablet", "dosage", "dose", "antibiotic", "pill"],
    answer:
      "Give medication exactly as the label says — the timing and the full course both matter, especially for antibiotics. " +
      "{{medicationClause}}" +
      "If a dose causes vomiting, drooling or a rash, stop and call your vet. " +
      "The medication panel on the dashboard shows what is due and what is overdue.",
    showVets: false,
    vetFilter: null,
    suggestions: ["What if I missed a dose?", "Find a vet nearby"]
  },
  {
    id: "walk",
    urgency: "routine",
    keywords: ["walk", "walking", "exercise", "how often", "run", "activity"],
    answer:
      "{{speciesLine}} " +
      "Split activity into shorter sessions in hot weather, go early or late to avoid the midday heat, " +
      "and check the ground before setting out. " +
      "Adjust down for the very young, seniors, or any pet recovering from illness.",
    showVets: false,
    vetFilter: null,
    suggestions: ["How often should I feed my dog?", "Find a vet nearby"]
  },
  {
    id: "feeding",
    urgency: "routine",
    keywords: ["feed", "feeding", "food", "diet", "meal", "how much", "treats"],
    answer:
      "Most pets do well on measured meals at consistent times, with fresh water always available. " +
      "{{allergyClause}}" +
      "Change foods gradually over about a week to avoid an upset stomach, and keep treats to a small share " +
      "of daily calories.",
    showVets: false,
    vetFilter: null,
    suggestions: ["My pet is not eating", "How often should I walk my dog?"]
  },
  {
    id: "tell-the-vet",
    urgency: "routine",
    keywords: ["tell the vet", "what to tell", "information", "prepare", "vet visit", "appointment"],
    answer:
      "Bring: when the symptoms started and how they have changed, what your pet ate in the last day or two, " +
      "every medication and supplement with its dose, any known allergies, and a photo or video of the symptom " +
      "if it comes and goes. Your exported care log covers most of this — it shows exactly what was given and when, " +
      "and who did it.",
    showVets: false,
    vetFilter: null,
    suggestions: ["Export the care log", "Find a vet nearby"]
  },
  {
    id: "find-vet",
    urgency: "routine",
    keywords: ["vet", "veterinarian", "hospital", "clinic", "nearby", "near me", "doctor", "recommend"],
    answer:
      "Here are the veterinary options saved for {{petName}}. For anything urgent, choose one of the 24/7 hospitals " +
      "and call ahead so they are expecting you.",
    showVets: true,
    vetFilter: null,
    suggestions: ["Show 24/7 hospitals", "What should I tell the vet?"]
  },
  {
    id: "urgent-signs",
    urgency: "routine",
    keywords: ["urgent", "warning signs", "when to worry", "serious", "emergency signs"],
    answer:
      "Seek veterinary care immediately for: difficulty breathing, repeated vomiting or retching without producing " +
      "anything, a swollen or hard belly, seizures, collapse or unsteadiness, pale or blue gums, bleeding that will " +
      "not stop, suspected poisoning, straining to urinate, or sudden severe pain. " +
      "When you are unsure, phone a vet — that call is free and they will tell you whether to come in.",
    showVets: true,
    vetFilter: "emergency",
    suggestions: ["Show 24/7 hospitals", "What should I tell the vet?"]
  }
];

const DEFAULT_REPLY = {
  urgency: "routine",
  answer:
    "I can help with general pet care questions — feeding, walks, medication routines, what to watch for, " +
    "and finding veterinary care. I cannot diagnose an illness, so anything worrying should go to a vet. " +
    "What would you like to know?",
  showVets: false,
  vetFilter: null,
  suggestions: [
    "My pet is not eating",
    "What if I missed a dose?",
    "Find a vet nearby",
    "What counts as an emergency?"
  ]
};

/**
 * Matches a question against the keyword table. Emergency rules win.
 * `pet` is whichever pet is currently selected on the dashboard — every
 * templated clause below is filled in from THIS pet only, so switching
 * pets never leaves a stale name, allergy or medication note behind.
 */
export function answerLocally(question = "", pet = null) {
  const q = String(question).toLowerCase();

  for (const rule of RULES) {
    if (rule.keywords.some((k) => q.includes(k))) {
      return {
        answer:      personalize(rule.answer, pet),
        urgency:     rule.urgency,
        showVets:    rule.showVets,
        vetFilter:   rule.vetFilter,
        suggestions: rule.suggestions,
        source:      "fallback",
        matched:     rule.id
      };
    }
  }
  return { ...DEFAULT_REPLY, source: "fallback", matched: "none" };
}

/** Fills the {{...}} placeholders in a rule's answer with this pet's own
    details, never another pet's — falling back to generic phrasing when
    a pet (or a specific field on it) isn't known. */
function personalize(template, pet) {
  const petName = pet?.name || "your pet";
  const allergy = pet?.specialInstructions?.allergy;
  const medication = pet?.specialInstructions?.medication;

  return template
    .replace(/\{\{petName\}\}/g, petName)
    .replace(/\{\{allergyClause\}\}/g, allergy
      ? `${petName}'s profile lists this allergy or sensitivity: ${allergy}. `
      : "")
    .replace(/\{\{medicationClause\}\}/g, medication
      ? `${petName}'s instructions say: ${medication} `
      : "")
    .replace(/\{\{speciesLine\}\}/g, speciesActivityLine(pet));
}

function speciesActivityLine(pet) {
  const species = pet?.species || "";
  const breed = pet?.breed || "";
  if (species === "dog") {
    return `A healthy adult ${breed || "dog"} generally does well with two walks a day totalling about an hour, plus some play or training.`;
  }
  if (species === "cat") {
    return "Cats generally exercise through play rather than walks — a few short, active play sessions a day keeps them fit.";
  }
  if (species === "rabbit" || species === "hamster") {
    return "Small mammals like this need daily supervised time out of the enclosure to move around, plus safe things to chew and explore.";
  }
  if (species === "bird") {
    return "Birds need daily time out of the cage to fly or move around in a safe, supervised space.";
  }
  if (species === "fish") {
    return "Fish don't need walks — their \"exercise\" is really about tank size, water quality and swimming space, which a species-specific care guide can help with.";
  }
  return "Exercise needs vary a lot by species — a vet or species care guide is the best source for how much activity is right.";
}

export const DISCLAIMER =
  "General care information only — not a diagnosis. For anything urgent, contact a veterinarian.";
