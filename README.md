# 🐾 PetCare Cloud

Daily pet care log, medication reminders, caretaker handoff and an AI assistant —
now with a Home dashboard, undo-able logging, an over-feeding warning, a
soft-delete Bin for history, and a Pet Memories gallery, on top of first-time
onboarding and full multi-pet support. Built for the Cognizant × GCP
hackathon, Use Case 12.

**Stack:** vanilla HTML/CSS/JS · Firebase Hosting · Cloud Firestore · Firebase Auth
(email + password) · one Cloud Function · Gemini API · Chart.js

---

## Run it right now — no setup, no account

```bash
npm run dev            # serves ./public at http://localhost:5173
```

The app boots in **demo mode**: accounts and data live in this browser, seeded
from `public/data/seed.json`. Every feature works — signup, login, logging,
timeline, medication status, the care team, health tracking, the AI assistant,
vets, export, KPIs. The only difference is that nothing syncs between browsers.

Sign in with either demo account, or use the one-click buttons on the login page:

| Account | Password | Can do |
|---|---|---|
| `owner@petcare.demo` | `petcare123` | Everything, including managing the care team |
| `arun@petcare.demo` | `petcare123` | Log care and record weight; cannot manage the team |

Care code for joining as a new caretaker: **`BUDDY-4821`**

This is also the Spark-plan escape hatch. If you cannot enable Blaze billing,
this mode still demos the entire product.

> **Don't double-click `index.html` or `login.html`.** This app is built from
> ES modules, and every browser blocks module scripts on a `file://` URL —
> no server, no error, just a spinner that never finishes. Always go through
> `npm run dev` (or any static server) and open `http://localhost:5173`. If
> you do open a file directly, the page now tells you this instead of hanging.

---

## Go live on Firebase

### 1. Create the project and deploy something immediately

```bash
npm install -g firebase-tools
firebase login
firebase use --add                 # pick your project, alias it "default"

firebase deploy --only hosting     # do this FIRST, with the app as-is
```

You now have a real HTTPS URL. Everything after this is incremental.

### 2. Turn on the services

In the Firebase console:

- **Build → Firestore Database → Create database** (production mode, region `asia-south1`)
- **Build → Authentication → Get started → Sign-in method → Email/Password → Enable**
- For Cloud Functions only: **upgrade the project to the Blaze plan**
  (required — Functions cannot be deployed on Spark)

### 3. Rules before data

```bash
firebase deploy --only firestore:rules
```

### 4. Seed

Firebase console → ⚙️ **Project settings → Service accounts → Generate new
private key**. Save it as `serviceAccount.json` in the project root — it is
already gitignored.

```bash
npm install                # firebase-admin, for the seed script only
npm run seed               # or: npm run seed:reset  to wipe careLogs first
```

The seed script also creates the two demo Firebase Auth accounts above, links
them to Buddy, and prints the care code.

### 5. Point the app at your project

Firebase console → ⚙️ **Project settings → Your apps → Web app → Config**.
Paste the values into `public/js/config.js`:

```js
export const firebaseConfig = {
  apiKey: "AIza…",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "…",
  appId: "…"
};
```

```bash
firebase deploy --only hosting
```

The badge in the top bar should now read **Live · Firestore**.

### 6. The AI function (optional — needs Blaze)

Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey), then:

```bash
cd functions && npm install && cd ..
firebase functions:secrets:set GEMINI_API_KEY
firebase deploy --only functions
```

Copy the printed URL into `AI_ENDPOINT` in `public/js/config.js` and redeploy
hosting. Leave `AI_ENDPOINT` empty and the assistant runs the rule-based
responder in the browser instead — it always answers either way.

If the deploy fails with a model error, set a different model:

```bash
firebase functions:config:unset   # not needed, just for reference
# edit MODEL in functions/index.js, or set GEMINI_MODEL in the function env
```

---

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Local static server, demo mode |
| `npm run emulate` | Full Firebase emulator suite |
| `npm run seed` | Write demo data to Firestore |
| `npm run seed:reset` | Clear `careLogs`, then reseed |
| `npm run deploy` | Deploy hosting (~40 seconds) |
| `npm run deploy:rules` | Deploy security rules |
| `npm run deploy:functions` | Deploy the AI function |
| `npm run sync-fallback` | Regenerate `functions/fallback.js` from the browser copy |
| `npm run test:onboarding` | Playwright: signup → multi-pet onboarding → isolation → AI context |
| `npm run test:regression` | Playwright: single-pet demo, skip-onboarding empty state, archive |
| `npm run test:features` | Playwright: breed cascade, feeding schedule + calendar, medication CRUD + stop/resume, caretaker permissions |
| `npm run test:home` | Playwright: Home welcome banner, overview cards, pet gallery, cross-pet alerts, over-feeding warning |
| `npm run test:bin` | Playwright: move a timeline entry to the Bin → restore → delete permanently |
| `npm run test:memories` | Playwright: add/view/edit/delete a memory, owner and caretaker |

Deploy hosting after every meaningful merge, not at milestones. Forty seconds
each time means a broken deploy is always traceable to one small change.

The `test:*` scripts drive real Chromium against demo mode with
Playwright — no Firebase project needed. First time only:

```bash
npm install
npx playwright install chromium
```

---

## Demo controls

**Double-click the 🐾 logo** to open the demo panel.

Four buttons jump the app clock to a *state* rather than a fixed offset, so
each one lands correctly whether you rehearse at 10am or demo at 9pm:

| Button | What it shows |
|---|---|
| **Real time** | Back to the actual clock |
| **Due now** | Five minutes past the next pending dose |
| **Overdue** | Past the 60-minute grace window — alert strip turns red |
| **Next day** | Half an hour past IST midnight: the checklist resets, the history stays |

**Reseed demo data** gives you a one-click reset between rehearsals (demo mode
only; in live mode run `npm run seed:reset`).

Reseed before every run, including the real one.

---

## Accounts and access

Three ways in:

| Path | What happens |
|---|---|
| **Log in** | Email and password. The session survives a refresh. |
| **Sign up → I'm the owner** | Creates the account, then walks straight into onboarding to add the first pet, then lands on Home. |
| **Sign up → I'm a caretaker** | Takes a care code, links the account to that pet as a caretaker, then opens Home directly — no onboarding needed, they already have a pet. |

**Login → Home → Pet Gallery → Pet Details.** `home.html` is the landing page
for anyone with at least one pet — a welcome banner, today's overview across
every pet, and a gallery of flash cards; clicking a card opens that pet's
existing dashboard (`index.html`, unchanged and still reachable directly).
Both pages are guarded: no session and you land on `login.html`. A session
with zero pets does **not** redirect in a loop — Home shows its own empty
state, with its own "add your first pet" entry point. Whether someone needs
onboarding is never a stored flag; it is derived from `myPets().length === 0`
at the moment they log in, so it can never go stale (e.g. after archiving
their only pet).

**Access is data, not a UI flag.** Each pet document carries `ownerUid` and a
`memberUids` array, and every Firestore rule checks against that array. Hiding
the "Add caretaker" button is a courtesy; the rules are what actually stop a
caretaker from writing to the roster.

The login page's left panel is a deliberately minimal pitch — brand, one
short line, four value points, no gradients or imagery — so the sign-in form
on the right stays the visual focus on desktop, tablet and mobile alike (it
drops below the form on narrow screens). The login email field's placeholder
is the generic `Enter your username or email`, and sign-up asks for **First
name** (required), **Middle name** (optional) and **Last name** (required) as
three separate, clearly labeled fields — never a single free-text "full name"
field, and never a real person's name baked in as an example. The three parts
are joined into the one `name` field the rest of the app already reads
(`composeName()` in `public/js/auth.js`), so nothing downstream — timeline
attribution, the AI's context, the "Added by" line on a memory — needed to
change for the split.

## Onboarding and multi-pet

A brand-new owner account sees a three-screen flow — **Welcome → Add pet →
(add another?) → Finish** — before landing on the dashboard. Skipping it is a
real option: `login.js` and `app.js` never force it, they just fall back to
the empty state.

- **Adding a pet** asks for a name and a pet type (Dog, Cat, Bird, Fish,
  Rabbit, Hamster, Reptile or Other — required), then a two-step cascade:
  picking a type populates a curated breed/species `<select>` for exactly that
  type (`SPECIES` in `public/js/auth.js`), always ending in "Other", which
  reveals a free-text field rather than forcing an unlisted breed into the
  wrong bucket. Both `species` and `breed` are stored on the pet document —
  `{ species: "dog", breed: "Golden Retriever" }` — never collapsed into one
  field. Age, gender, weight, a photo, a **customizable feeding schedule**
  and free-text special instructions are all optional.
- **Feeding is never a hard-coded "3 times a day".** Each pet gets its own
  `feedingSchedule: { times: string[], notes }`, edited as an add/remove/edit
  list of clock times (`wireFeedingScheduleEditor` in `public/js/pets-ui.js`,
  shared by onboarding and the edit-pet form) — the count of feeding times
  *is* the schedule, so there is no separate "times per day" field that could
  drift out of sync. `pet.dailyTargets.feeding` is kept as a mirror of
  `times.length` purely so the existing ring/KPI/streak math in `data.js`
  never had to change. A pet saved before this feature existed has no
  `feedingSchedule` at all; `feedingTimes()` in `data.js` falls back to
  `dailyTargets.feeding` (which every pet has always had) plus a set of sane
  default clock times — no migration, nothing overwritten.
- **The Feeding schedule card** on the dashboard mirrors the Medication
  schedule card exactly (same status pills, same "Mark as given" pattern),
  and its own **Calendar** button opens month and week views
  (`public/js/calendar.js`) showing completed / partial / missed / upcoming
  per day, scoped to whichever pet is open. A feeding logged before per-slot
  tracking existed (or via the one-click "Log Feeding" action, which still
  just logs an unslotted feeding) is matched to the earliest still-open
  scheduled time in chronological order (`matchFeedingSlots()` in
  `data.js`) — so existing feeding history is never miscounted as missed.
  The calendar reads history with a one-off `store.getLogsInRange()` query
  rather than widening the always-on 8-day `careLogs` listener, and needs no
  new Firestore index: the range query and the existing listener both filter
  and sort on the single field `dayKey`.
- **A photo is never a blocker.** It is downscaled and re-encoded as a small
  JPEG data URL entirely in the browser (see `wirePhotoPicker` in
  `public/js/pets-ui.js`) and stored directly on the pet document — no
  Firebase Storage bucket required. That also keeps it comfortably inside
  Firestore's 1 MiB document limit regardless of how large the source photo
  was.
- **The pet switcher** lives in the top bar once an account has at least one
  pet. Switching disposes the open store and opens a new one scoped to the
  chosen `petId` — nothing is shared between pets, because `store-firebase.js`
  already isolates every subcollection (`medications`, `caretakers`,
  `vaccinations`, `weights`, `careLogs`) under `pets/{petId}`. The choice is
  persisted to `users/{uid}.lastSelectedPetId`, so it follows you across
  devices, not just across a refresh.
- **Role is per pet, never global.** The same account can own one pet and be
  a caretaker on another — `auth.myPets()` returns each pet's `role`
  (`owner` | `caretaker`) computed from that pet's own `ownerUid`, and
  `app.js` synthesizes a role-annotated "view session" fresh on every switch.
  `caretakers.js` and `health.js` needed zero code changes for this — they
  already only ever looked at whatever session-like object they were handed.
- **Editing a pet** (✎ next to the pet's name) is open to the owner *and*
  any caretaker on that pet — name, breed, feeding schedule, notes, all of
  it. **Removing a pet is owner-only.** The Archive/Remove button is hidden
  for a caretaker in the same modal, and — because a hidden button is not
  security — the Firestore rule (`memberDetailUpdate()` in
  `firestore.rules`) independently blocks any non-owner write that touches
  `ownerUid`, `memberUids`, `status` or `joinCode`, so a caretaker cannot
  delete, reassign or take over a pet even by calling the API directly.
  Removing is a soft delete — `pets/{petId}.status` flips to `"archived"`
  and it drops out of the switcher and `myPets()` — every log, medication
  and caretaker record is kept. If that was the account's only pet, the
  dashboard returns to the empty state, not an error.
- **The AI assistant follows whichever pet is open.** `chat.setPetContext()`
  is called on every pet switch with that pet's real name, species, breed and
  special instructions; `ai-fallback.js`'s answers and the Cloud Function's
  system prompt (`functions/fallback.js#buildSystemPrompt`) are built fresh
  from that context every time — never a hardcoded pet, never a stale one
  left over from before a switch.

No Firestore schema change was needed for any of this: `pets/{petId}` was
already a top-level collection with its own subcollections, and the existing
`memberUids`-based rules already support `pets where memberUids array-contains
uid` — the exact query `myPets()` runs — with no new composite index.

## Home dashboard

`home.html` is what a signed-in person actually lands on: a welcome banner
(`Good morning, {first name}` — always the real account name, never a
hardcoded placeholder), five overview cards summarizing **today** across
*every* pet on the account (Pets · Today's Feeding · Upcoming Medication ·
Missed Tasks · Completed Tasks), a **Needs attention** list surfacing any
pet with an overdue task or an over-feeding warning, and a gallery of
flash cards — one per pet, each showing its photo, species/breed/age, its
own feeding status and next scheduled feeding, and its medication status if
it has any. Clicking a card (or a "Needs attention" row) opens that pet's
existing dashboard.

Nothing here is a separate data model. `home.js` opens the exact same
`createStore()` + `buildDashboard()` pipeline `index.html` uses, once per
pet — subscribe, take the first snapshot, dispose — so a multi-pet account
never leaves more than one Firestore listener open from this page, and
every number on it is computed by the same code the dashboard already
trusts. Clicking into a pet persists the choice through the existing
`auth.setSelectedPetId()`, so `index.html`'s own boot sequence picks it
straight back up.

## Undo a mistouch

Every one-click log (Feed, Walk, a medication dose) shows a "*{Task}
recorded • Undo (8s)*" toast (`showActionToast()` in `public/js/ui.js`) —
tap Undo within the window and the entry is actually removed, not just
hidden; let it expire and it's permanent, the same as before this feature
existed. Two things keep this both safe and honest:

- **Rapid double-clicks never create two records.** `app.js` tracks
  in-flight log requests by `type:medicationId:slot` and ignores a second
  click for the same action while the first is still saving.
- **`careLogs` stays append-only for everyone except the log's own
  creator, and only for a few seconds.** `firestore.rules`' `selfUndo()`
  is a narrow, time-boxed exception (`request.time < resource.data.at +
  duration.value(12, 's')`, and only the creator's own `performedByUid`)
  layered onto the existing `allow update, delete: if false` — every
  other actor, and every other moment, is exactly as immutable as it
  always was. `UNDO_WINDOW_SECONDS` in `config.js` is the one number that
  drives both the client's countdown and the (slightly larger, to absorb
  network latency) server-side window, so they can never drift apart.

## Over-feeding warning

A "⚠️ Feeding Warning — exceeded today's planned feeding schedule" banner
appears on both the Pet Details dashboard and that pet's Home flash card
the moment today's logged feedings run past **that pet's own configured
schedule** — never a hard-coded "3 meals a day". `buildDashboard()` in
`data.js` computes `overFeeding`/`overFeedingBy` as `counts.feeding >
targets.feeding`, where `targets.feeding` already reflects whatever the
owner configured in the feeding schedule (or the pre-existing
`dailyTargets.feeding` default for a pet saved before that feature
existed). Nothing is persisted — the warning is recomputed from today's
logs on every render, so it disappears on its own at the next local day
with no cleanup job required.

## The Bin — soft-deleted history

Deleting a timeline entry (hover a row, click 🗑) never actually deletes
it. It moves to a new `pets/{petId}/trash/{trashId}` subcollection — a
full snapshot of the record plus who deleted it and when — and every
app-facing view (`buildDashboard()` in `data.js`, and the calendar's
`getLogsInRange()`) filters out any log with a live trash marker. The
underlying `careLogs` document is never touched, so the append-only audit
trail described above stays completely intact.

Open the **Bin** (next to "Today's timeline") to see everything currently
deleted, who deleted it and when, and either:

- **Restore** — deletes the trash marker, and the entry reappears
  everywhere it used to, counts and calendar included.
- **Delete permanently** (two-click confirm, same pattern as deleting a
  medication) — flips the marker's own `permanent` flag so the Bin stops
  listing it. The underlying `careLog` is still never actually erased —
  "permanent" is a statement about what the app shows you, not a promise
  that the audit record is gone, which is deliberate: this is the same
  "nothing is ever truly deleted, only reset visually" philosophy the rest
  of this app is built around.

Any member (owner or caretaker) can move an entry to the bin, restore one,
or delete one permanently — matching how logging care itself has always
worked. Nothing about this weakens `careLogs`' own rules: `trash` is a
separate collection with its own rules, and `firestore.rules`' comments on
both explain exactly why.

## Pet Memories

Each pet's dashboard has a Memories gallery — photos and milestones (first
day home, a birthday, a first walk, training, growth) with a title, an
optional caption, and a date. Any member can add one; editing or deleting
one is scoped to whoever created it, or the pet's owner (`firestore.rules`'
`/memories/{memoryId}` block — the same creator-or-owner split weights
already use), so a caretaker cannot silently rewrite someone else's
memory. Deleting is a real delete here, with a two-click confirm — a
memory isn't part of the audit-log architecture the Bin protects.

Photos reuse the exact same downscaled-data-URL technique
`wirePhotoPicker()` already uses for a pet's profile photo
(`public/js/pets-ui.js`) — this project has no Firebase Storage bucket
configured, and adding Memories didn't require one. A memory with no
photo is still valid: a title and a date are enough to record a
milestone.

## Managing the care team

The owner can:

- **Add** a caretaker by name, with an optional email and note
- **Pause** one — they stay on the roster but the entry is greyed out
- **Remove** one — this deletes the roster entry *and* pulls their uid out of
  `memberUids`, so their access genuinely ends. Everything they already logged
  stays on the timeline and in the export: the record of who did what is never
  rewritten.
- **Share the care code** so a caretaker can link their own account

A caretaker sees the same roster read-only.

## Managing medications

**Manage** on the Medication schedule card opens the full list of a pet's
medications — name, dosage, **type** (Tablet / Capsule / Syrup / Liquid /
Injection / Drops / Cream-Ointment / Powder / Other), **feeding relation**
(Before food / After food / With food / Any time), **frequency** (Once
daily / Twice daily / Three times daily / Custom schedule, with a free-text
field for the custom case), every scheduled dose time, an optional
start/end date, and instructions — with **Add**, **Edit**, **Stop/Resume**
and **Delete** (`public/js/medications.js`). Nothing about medications is
hardcoded: a pet can have zero, one, or many medications, each tracked
completely independently, each with its own times and schedule. This is
add/edit/delete of the medication *documents themselves*; the dashboard's
per-slot "Mark as given" list (`dash.medications` in `data.js`) is a
different, flattened view of the same data used for logging a dose, and is
unaffected by this modal.

**Stop/Resume** (⏸/▶, mirroring the same icon-button pattern as pausing a
caretaker) toggles the medication's existing `active` flag — a stopped
medication drops out of today's checklist and stops generating reminders,
but every dose already logged for it stays in the timeline, the calendar and
every export forever. This is deliberately different from **Delete**, which
removes the medication document itself (after a two-click confirm) but,
same as before, never touches past `careLogs` records either way.

Owner-only, matching the existing `allow write: if isOwner()` rule on
`/pets/{petId}/medications/{medId}` — nothing in `firestore.rules` changed
for this feature. A caretaker still sees the schedule and can log a dose from
the dashboard; the **Manage** list itself opens read-only for them, with the
Add button and every item's Edit/Stop/Delete controls hidden.

Deleting asks for confirmation in place — click **Delete** once to arm it,
click the now-relabelled **Confirm?** to actually remove it, or wait three
seconds and it disarms — rather than a native `confirm()` dialog or a second
full-screen modal.

`startDate`/`endDate` are optional; a medication saved before this feature
existed has neither and is treated as always-active, exactly as it always
behaved. Set both to give a course a natural end (e.g. "Complete the full
7-day course") and it stops appearing on the dashboard and in reminders once
`endDate` passes, with nothing left to manually clean up.

`type` and `feedingRelation` are new, optional fields — a medication saved
before they existed simply has `""` for both and displays exactly as it
always did. `frequency` moved from free text to a fixed dropdown, but a
pre-existing value that doesn't match one of the four options (the seeded
Amoxicillin's `"daily"`, for instance) is never silently rewritten: opening
it for edit falls back to "Custom schedule" with the original text preserved
in the free-text field, the same "known option, else free text" pattern the
breed `<select>` already uses for an unlisted breed.

**Medication calendar.** The same Calendar button that opens the feeding
month/week view now has a **Feeding / Medication** toggle at the top
(`public/js/calendar.js`). Switching to Medication reuses the identical grid
and week-card rendering, just fed `buildDayMedicationRows()` /
`summarizeMedicationDay()` (`public/js/data.js`) instead of the feeding
equivalents — one row per medication per scheduled time that was active that
day (respecting each medication's own start/end date window), matched to
that day's logs by the log's own `medicationId` + `slot` rather than
feeding's proximity matching, since a medication log always carries both
explicitly. A day with no medication scheduled at all reads as "no
medication scheduled", never "missed" — there was nothing to miss.

## Live "Last done" indicators

Every one-click action button (Log Feeding / Log Walk / Log Medication) now
shows a small "Last done: …" line directly beneath it — "3 hours ago", "25
minutes ago", or "Yesterday at 7:30 PM" once the last one wasn't today
(`fmtLastDone()` in `public/js/time.js`, IST-anchored like every other date
decision in this app). It updates immediately when an action completes (the
same store-subscribe callback that already repaints the rest of the
dashboard) and also just from time passing, via the existing 30-second
`setInterval(repaint, 30_000)` in `app.js` — nobody has to refresh the page
to watch "3 minutes ago" become "4 minutes ago". The underlying `lastDone`
value in `buildDashboard()` (`data.js`) now looks across the pet's full log
history, not just today's — otherwise the indicator would wrongly reset to
"not yet" the instant the calendar day rolled over, even though something
was clearly done the evening before. The existing sidebar "Last completed
activity" card uses the same helper, so both places phrase it identically.

## Special instructions & veterinarian contact

The **Edit pet** form now has real inputs for fields the data model already
supported but had no UI for: a **food allergy / medical warning** field, and
a **veterinarian contact** block (clinic/vet name, phone, optional emergency
phone). Both show on the dashboard's Special Instructions card, which
already existed and already read these exact fields — closing a gap between
what the model could store and what the form could set.

The vet contact is the one part of pet editing that stays **owner-only**,
even though a caretaker can edit everything else about a pet (name, breed,
feeding schedule, allergy, notes). A caretaker sees the vet fields as
plain `readonly` inputs with a note explaining why, can still tap the phone
number to call from the dashboard, but the boundary isn't just the UI: the
demo store (`auth-mock.js`) strips a non-owner's `vet` patch unconditionally
before it's applied, and the Firestore rule's `memberDetailUpdate()` denies
any write that touches the `vet` key at all, the same mechanism that already
protected `ownerUid`/`memberUids`/`status`/`joinCode`. A pet saved before
`emergencyPhone` existed simply has `""` for it and the extra "Emergency
vet" line on the dashboard and in the printable handoff stays hidden rather
than showing an empty Call button.

## Health tracking

The daily half of this app is feeding, walks and medication. The slow half is
here — the numbers you only notice by keeping them.

- **Weight** — a reading logs in two taps, and the card shows the latest value,
  the change since the previous reading, and a hand-drawn sparkline of the whole
  history. A swing of 5% or more between readings raises a flag suggesting you
  mention it at the next vet visit.
- **Vaccinations** — status is computed exactly the way medication status is:
  from `nextDueOn` and today, never stored. Up to date / due soon (within 30
  days) / overdue. Recording one defaults the next due date to the same interval
  as last time.
- **Adherence streak** — consecutive days where every scheduled dose was logged,
  shown on the pet card. Today only breaks the streak once its own doses are
  actually overdue, so a morning check-in never wrongly reads "0 days".

Any member can record a weight. Only the owner can record a vaccination.

## Exporting care history

The Export card has three options (`public/js/export.js`), each aimed at a
different reader:

- **Export Log (text)** — a plain, readable `.txt` file: one line per care
  entry, grouped by date, showing time, action, medication name/dosage where
  relevant, who did it, and any notes, with a short header and a closing
  note that nothing is ever deleted at midnight. Built for pasting straight
  into a message to a vet or pet sitter — deliberately not a "reporting
  system", no tables or charts, just what happened and when.
- **Export care log (CSV)** — the full history as a spreadsheet, one row per
  entry, for anyone who wants to filter, sort or chart it themselves.
- **Export caretaker plan** — a printable, today-only care plan (opens a
  print-ready page you can Save as PDF), for handing off in person.

All three read from the same `state.logs`/`state.medications`, so they can
never drift out of sync with each other or with the dashboard.

## How it works

### Medication status is computed, never stored

There is no cron job, no scheduler and no background worker. `statusFor()` in
`public/js/data.js` is a pure function of `(scheduledTime, now, logsToday)`:

```
no log + now < scheduled       → UPCOMING
no log + within 60 min grace   → DUE NOW
no log + past the grace window → OVERDUE
log exists for that slot       → COMPLETED
```

A dose becomes overdue because time passed, not because something ran. This
also answers "what if the notification is missed?" — the dashboard shows the
overdue state whether or not any notification was ever delivered.

### `dayKey` solves the midnight reset and the timezone bug at once

Every care log carries `dayKey`, an IST-derived `"YYYY-MM-DD"` string. Today's
checklist is `where('dayKey','==',todayIST())`. Nothing is deleted at midnight —
the checklist resets, the record does not, and the history stays available for
export.

Cloud Functions run in UTC, the demo runs in IST. One helper (`dayKeyIST` in
`public/js/time.js`) is the only place that touches dates. Do not call
`new Date().getDate()` anywhere else.

This was always true in **live mode** — Firestore is the source of truth and
nothing there is ever deleted. It was not true of the **demo mode**
localStorage cache: `store-mock.js` used to discard the entire cached state
(every log, caretaker, vaccination and weight reading) whenever the cached
`dayKey` didn't match today's, on the theory that a stale cache should just
rebuild from seed. That reads fine for the seeded demo pet (its "history" is
synthetic and regenerates anyway) but silently deleted a real signup's entire
care history every midnight — exactly the data loss this app is designed not
to have. Fixed by dropping the dayKey gate entirely: the cache is now always
restored when present, and a deliberate full reset is still one click away
via the existing "Reseed demo data" control. The same fix also closed an
unrelated, previously-untested gap where `state.medications` was never
written to the cache at all, meaning any medication added in demo mode
vanished on the next page reload.

### Live sync is the demo moment

`onSnapshot` listeners in `store-firebase.js` mean the owner's write and the
caretaker's update are the same document, not two API calls. Open two browser
windows side by side and log a feeding in one.

### The AI always answers

`public/js/ai-fallback.js` is a keyword table that runs when there is no Cloud
Function, or when the Gemini call fails. `functions/index.js` also applies it on
top of the model's response as a safety net — that check can only *raise* the
urgency the model returned, never lower it.

If the demo ends up running on the fallback, say so out loud. It is the designed
behaviour, and it reads as engineering maturity.

---

## Project layout

```
petcare-cloud/
├── public/
│   ├── home.html                   landing page for a session with ≥1 pet: welcome, overview, pet gallery
│   ├── index.html                  a pet's dashboard (auth-guarded, pet switcher, empty state)
│   ├── login.html                  signup / login / join by code
│   ├── onboarding.html             Welcome → Add pet → (add another?) → Finish → Home
│   ├── serve.json                  local dev only — keeps `npm run dev` off "clean URLs"
│   │                                (so ?mode=… survives, matching Firebase Hosting's default)
│   ├── css/styles.css              Pod B
│   ├── js/
│   │   ├── config.js               Pod A — the only file you edit to go live
│   │   ├── time.js                 Pod A — every date decision
│   │   ├── data.js                 Pod A — model + store facade
│   │   ├── auth.js                 Pod A — auth facade + validation + per-type breed catalog
│   │   ├── auth-firebase.js        Pod A — Firebase Auth + multi-pet membership
│   │   ├── auth-mock.js            Pod A — demo accounts + multi-pet membership
│   │   ├── store-firebase.js       Pod A — live Firestore, scoped to one petId
│   │   ├── store-mock.js           Pod A — demo mode, scoped to one petId
│   │   ├── login.js                Pod A — the login page
│   │   ├── onboarding.js           Pod A — the onboarding flow
│   │   ├── home.js                 Home page: welcome, overview, alerts, pet gallery
│   │   ├── pets-ui.js              Pod A — species-grid, breed-select, feeding-time-list, photo-picker
│   │   ├── medications.js          Pod B — medication add/edit/delete (owner-only)
│   │   ├── calendar.js             Pod B — feeding + medication calendar, month + week views
│   │   ├── dashboard.js            Pod B
│   │   ├── timeline.js             Pod B — today's activity + "move to bin"
│   │   ├── bin.js                  the Bin: restore / delete-permanently for soft-deleted care logs
│   │   ├── memories.js             Pet Memories: photo/milestone gallery, add/edit/delete
│   │   ├── caretakers.js           Pod B — care team CRUD
│   │   ├── health.js               Pod B — weight + vaccinations
│   │   ├── export.js               Pod B — text log, CSV, printable handoff
│   │   ├── chat.js                 Pod C — follows the selected pet
│   │   ├── ai-fallback.js          Pod C — keyword table, personalized per pet
│   │   ├── vets.js                 Pod C
│   │   ├── kpi.js                  Pod A
│   │   ├── ui.js                   shared DOM helpers + showActionToast() (Undo)
│   │   └── app.js                  Pod D — wiring, pet switcher, edit/archive, undo, bin, memories
│   └── data/seed.json              single source of demo data
├── functions/
│   ├── index.js                    Pod C — the one Cloud Function
│   ├── fallback.js                 generated from ai-fallback.js, plus buildSystemPrompt(pet)
│   └── package.json
├── scripts/
│   ├── seed.js                     Pod A
│   ├── sync-fallback.js
│   ├── test-onboarding.js          Playwright: signup → multi-pet → isolation → AI context
│   ├── test-regression.js          Playwright: existing single-pet demo, skip/empty state, archive
│   ├── test-features.js            Playwright: breed cascade, feeding + calendar, medication CRUD, caretaker permissions
│   ├── test-home.js                Playwright: Home welcome/overview/gallery, cross-pet alerts, over-feeding
│   ├── test-bin.js                 Playwright: move to bin → restore → delete permanently
│   └── test-memories.js            Playwright: add/view/edit/delete a memory, owner + caretaker
├── firestore.rules                 Pod A
├── firebase.json
└── package.json
```

No two pods edit the same file. That prevents more pain than any git workflow.

---

## Security notes

- The Gemini key lives in Secret Manager and is only read inside the Cloud
  Function. It never reaches the browser.
- Passwords are handled by Firebase Authentication. The app never sees or
  stores one. (Demo mode is the exception and is not secure — it keeps accounts
  in `localStorage` as a stand-in for Firebase Auth. Say so if a judge asks.)
- Access is checked against the pet's `memberUids` array on every read and
  write. Nothing is world-readable, and removing a caretaker revokes them for
  real rather than just hiding buttons.
- A caretaker can update a pet's own details (`memberDetailUpdate()` in
  `firestore.rules`) but the rule explicitly denies any write that touches
  `ownerUid`, `ownerName`, `memberUids`, `status`, `joinCode` or `vet` — so
  deleting, reassigning or taking over a pet, or changing who the
  veterinarian is, is blocked at the data layer, not only by the UI hiding
  or locking the relevant controls.
- `careLogs` are **append-only** from the client — you can add a record and read
  history, but you cannot rewrite what somebody else logged. A log's
  `performedByUid` must match the signed-in user, so you cannot log care as
  somebody else either. The one deliberate, narrow exception is `selfUndo()`
  — the log's own creator can delete *that* log within a few seconds of
  creating it (the "Feeding recorded • Undo" toast), and nothing else about
  the collection's immutability changed.
- **The Bin never weakens `careLogs`.** Moving a record to the bin writes to
  a separate `pets/{petId}/trash/{trashId}` document instead — the original
  `careLog` is never updated or deleted by this feature. `trash` create
  requires `deletedByUid == request.auth.uid`; its only allowed update is
  the `permanent` flag (so "delete permanently" can't be repurposed to
  rewrite anything else); any member can read, create, or delete a trash
  marker (restore), matching how logging care itself has always worked.
- **Memories** follow the same member-create / creator-or-owner-manage split
  as weight readings: any member can add one (`createdByUid` must be them),
  but only the creator or the pet's owner can edit or delete it — so a
  caretaker cannot silently rewrite or remove someone else's memory.
- Weight readings are range-checked in the rules, not only in the form.
- `serviceAccount.json` and `functions/.env` are gitignored in the first commit.

---

## Not built, deliberately

Browser notifications, snooze, password reset, email verification, social
sign-in, maps and geolocation, Firebase Storage for photos (a downscaled data
URL does the job without it), per-caretaker pet assignment beyond "added to
this one pet's roster", SMS/WhatsApp, TypeScript and bundlers. All roadmap.

A small working product with a clear architecture and a rehearsed demo beats a
large unfinished one. When the two conflict, protect the demo.

---

## Roadmap

FCM push then SMS/WhatsApp · password reset, email verification and per-activity
caretaker permissions · Vertex AI with a grounded veterinary knowledge base ·
live clinic directory via Google Places · Cloud Scheduler for server-side
reminder dispatch · Firebase Storage for full-resolution pet photos · a
household view that groups pets rather than listing them flat · weight,
vaccination and vet-visit history with trend charts.
