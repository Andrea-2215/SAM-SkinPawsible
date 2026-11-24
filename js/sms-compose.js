// sms-compose.js (v11)  ·  works on the free Firebase plan
// Put this in ../js/ next to sms-logs.js. Keep sms-logs.js as is.
//
// v6:  SMS goes through TextBee (your Android phone) instead of Semaphore.
//      The "Sender name" box is gone (the text comes from the phone's SIM number).
// v11: weather alert card always shows (even when no alert), safer weather numbers,
//      and a reminder to send the seasonal message.

import { auth, db } from "./firebase-config.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

import {
  collection, getDocs, setDoc, addDoc, doc, query, where, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

/* ============================================================
   SETTINGS (change these)
   ============================================================ */

// true  = test mode. The Send button works but NOTHING is sent or saved.
// false = really sends through your Worker.
const DEMO_MODE = false;

// The link of your Cloudflare Worker (you get it after you deploy worker.js)
const WORKER_URL = "https://skinpaws-sms.skinpawsible.workers.dev";

const USERS_COLLECTION = "users";
const LOGS_COLLECTION = "smsLogs";            // same one your sms-logs.js reads
const AWARENESS_COLLECTION = "smsAwareness";  // created automatically

// Match the fields of your users in Firestore
function mapUser(d) {
  const x = d.data();
  return {
    id: d.id,
    name: x.fullName || x.name || x.displayName || [x.firstName, x.lastName].filter(Boolean).join(" ") || "No name",
    mobile: normalizeNumber(x.mobile || x.phone || x.phoneNumber || x.contactNumber || ""),
    // the "accept SMS messages" toggle
    smsEnabled: [x.smsEnabled, x.smsAlertsEnabled, x.acceptSms].some((v) => v === true || v === "true"),
  };
}

// Quick message buttons (the 3 season messages are added after these automatically)
const TEMPLATES = [
  { label: "Follow-up", text: "Hello from SkinPawsible App! How is your pet doing after the visit? Message us if you have any concerns." },
];

// The 3 seasons (PAGASA default) + the SMS text from the scraper notebook (SEASON_SMS).
// "start" = month number where 0 = January. Change the months here if your area is different
// (eastern areas can have their heaviest rain at other months).
// Plain letters only (no emoji or fancy quotes) so each SMS stays cheap.
const SEASONS = [
  {
    key: "hot_dry", emoji: "☀️", range: "Mar–May", start: 2,
    title: "Hot dry season",
    message: "Hot season! Keep your dog cool, watch for itchy or smelly skin, check paws for ticks, and keep vaccines up to date. See the SkinPawsible app for tips.",
  },
  {
    key: "rainy", emoji: "🌧️", range: "Jun–Nov", start: 5,
    title: "Rainy season",
    message: "Rainy season! Keep your dog dry and out of floodwater. Watch for itchy skin or infections, and keep puppy vaccines updated. See the SkinPawsible app for tips.",
  },
  {
    key: "cool_dry", emoji: "🍃", range: "Dec–Feb", start: 11,
    title: "Cool dry season",
    message: "Cool, dry season! Watch for itchy skin and fleas, check ears and paws for ticks, and keep vaccines up to date. See the SkinPawsible app for tips.",
  },
];

// Live weather (from the notebook's Step 5). Paste the link of your weather Worker (worker-weather.js).
// Leave it empty and the page just shows the season without weather.
const WEATHER_URL = "https://skinpaws-weather.skinpawsible.workers.dev/";
const HUMIDITY_THRESHOLD = 75;       // %
const TEMP_THRESHOLD = 27;           // deg C
const HEAVY_RAIN_MM_PER_HOUR = 7.5;  // rain in the last hour
const RAIN_CONDITIONS = ["Rain", "Drizzle", "Thunderstorm"];
const WEATHER_SMS_LIMIT = 300;
const WEATHER_TIPS = {
  yeast: "Yeast: watch for itchy, greasy, smelly skin or ears.",
  pyoderma: "Hot spots: keep skin folds and paws dry.",
  ringworm: "Ringworm: look for round, bald, scaly patches.",
  lepto: "Leptospirosis: keep your dog out of floodwater.",
};

/* ============================================================
   SENDING
   ============================================================ */

async function sendSms({ numbers, message }) {
  if (DEMO_MODE) {
    await new Promise((r) => setTimeout(r, 800));
    return { demo: true, messages: numbers.map((n) => ({ recipient: n, status: "Pending" })) };
  }

  const token = await auth.currentUser.getIdToken();

  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ numbers, message }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// Save one log per message so the History tab and "Last message" update.
// Fields match what your sms-logs.js reads (userId, recipient, message, date, type, status).
async function saveLogs(messages, text, campaignId) {
  const when = new Date().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
  await Promise.all(
    messages.map((m) =>
      addDoc(collection(db, LOGS_COLLECTION), {
        userId: auth.currentUser.uid,
        recipient: m.recipient,
        message: text,
        date: when,                     // readable text (your logs page shows this)
        createdAt: serverTimestamp(),   // for sorting
        type: campaignId ? "Awareness" : "Manual",
        status: m.status || "Pending",
        campaignId: campaignId || null,
      })
    )
  );
}

/* ============================================================
   UI CODE 
   ============================================================ */

const $ = (id) => document.getElementById(id);
const NOW = new Date();
const YEAR = NOW.getFullYear();

// Hot dry starts in March, so Jan and Feb still belong to the cool dry season that began last December.
const CYCLE_YEAR = NOW.getMonth() < 2 ? YEAR - 1 : YEAR;

const listEl = $("recipientList");
const searchInput = $("recipientSearch");
const selectAll = $("selectAll");
const messageBox = $("smsMessage");
const sendBtn = $("sendBtn");

let users = [];
let lastSent = {};   // number -> ISO date text, or "unknown" if the log has no readable date
let awareness = {};  // "2026-rainy" -> { title, message, sentAt, sentCount } (only what was saved)
let campaign = null;
let filter = "on";
const selected = new Set();

/* ---------- helpers ---------- */

function esc(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

// 09171234567 format (the Worker turns it into +639171234567 for TextBee)
function normalizeNumber(value) {
  let n = String(value || "").replace(/\D/g, "");
  if (n.startsWith("63")) n = "0" + n.slice(2);
  if (n.length === 10 && n.startsWith("9")) n = "0" + n;
  return n;
}

function initials(name) {
  const p = (name || "?").trim().split(/\s+/);
  return ((p[0]?.[0] || "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}

function avClass(name) {
  let h = 0;
  for (const c of name || "") h = (h * 31 + c.charCodeAt(0)) % 4;
  return "av-" + h;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
}

// 160 characters = 1 SMS. Longer messages use 153 per part.
function countParts(len) {
  if (len === 0) return 0;
  return len <= 160 ? 1 : Math.ceil(len / 153);
}

// Timestamp, ISO text or readable text -> Date (or null)
function toDate(v) {
  if (!v) return null;
  const d = v.toDate ? v.toDate() : new Date(v);
  return isNaN(d) ? null : d;
}

/* ---------- seasons ---------- */

// Start and end date of a season in the current cycle
function seasonRange(i) {
  const start = new Date(CYCLE_YEAR, SEASONS[i].start, 1);
  const next = SEASONS[(i + 1) % SEASONS.length];
  const endYear = i === SEASONS.length - 1 ? CYCLE_YEAR + 1 : CYCLE_YEAR; // cool dry ends in March of next year
  const end = new Date(endYear, next.start, 1);
  return { start, end };
}

function isCurrentSeason(i) {
  const { start, end } = seasonRange(i);
  return NOW >= start && NOW < end;
}

// Saved version (if you edited it) or the scraper's default text
function seasonData(i) {
  const s = SEASONS[i];
  const id = `${CYCLE_YEAR}-${s.key}`;
  const saved = awareness[id] || {};
  return {
    id,
    key: s.key,
    title: saved.title || s.title,
    message: saved.message || s.message,
    sentAt: saved.sentAt || null,
    sentCount: saved.sentCount || 0,
  };
}

function seasonStatus(i, data) {
  if (data.sentAt) return { cls: "sent", text: `Sent ${formatDate(data.sentAt)}${data.sentCount ? " · " + data.sentCount + " people" : ""}` };
  const { start, end } = seasonRange(i);
  if (NOW >= end) return { cls: "missed", text: "Not sent" };
  if (NOW >= start) return { cls: "todo", text: "To send" };
  return { cls: "soon", text: "Starts " + start.toLocaleDateString("en-PH", { month: "short" }) };
}

/* ---------- load data ---------- */

async function loadUsers() {
  const snap = await getDocs(query(
    collection(db, USERS_COLLECTION),
    where("role", "in", [
      "owner",
      "user",
      "pet owner",
      "petOwner",
      "petowner",
      "pet_owner",
      "Pet Owner",
      "Pet owner"
    ])
  ));
  users = snap.docs.map(mapUser).filter((u) => u.mobile);
}

async function loadLastSent() {
  const snap = await getDocs(collection(db, LOGS_COLLECTION));
  lastSent = {};
  snap.docs.forEach((d) => {
    const x = d.data();
    const n = normalizeNumber(x.recipient || x.phoneNumber || x.mobile || "");
    if (!n) return;
    const when = toDate(x.createdAt) || toDate(x.sentAt) || toDate(x.date);
    const prev = lastSent[n];
    if (when) {
      if (!prev || prev === "unknown" || when > new Date(prev)) lastSent[n] = when.toISOString();
    } else if (!prev) {
      lastSent[n] = "unknown";
    }
  });
}

async function loadAwareness() {
  const snap = await getDocs(query(collection(db, AWARENESS_COLLECTION), where("year", "==", CYCLE_YEAR)));
  awareness = {};
  snap.docs.forEach((d) => {
    const x = d.data();
    if (!x.season) return; // old monthly records (no "season" field) are ignored
    awareness[d.id] = { ...x, sentAt: toDate(x.sentAt)?.toISOString() || null };
  });
}

/* ---------- stats + recipients ---------- */

function updateStats() {
  const on = users.filter((u) => u.smsEnabled).length;
  const never = users.filter((u) => !lastSent[u.mobile]).length;
  const aware = SEASONS.filter((_, i) => seasonData(i).sentAt).length;

  $("statOn").textContent = on;
  $("statNever").textContent = never;
  $("statAware").textContent = `${aware}/${SEASONS.length}`;

  const counts = { on, never, sent: users.length - never, all: users.length };
  document.querySelectorAll("[data-count]").forEach((el) => (el.textContent = `(${counts[el.dataset.count]})`));
}

function matchesFilter(u) {
  if (filter === "on") return u.smsEnabled;
  if (filter === "never") return !lastSent[u.mobile];
  if (filter === "sent") return !!lastSent[u.mobile];
  return true;
}

function visibleUsers() {
  const q = searchInput.value.trim().toLowerCase();
  return users.filter((u) => matchesFilter(u) && (!q || u.name.toLowerCase().includes(q) || u.mobile.includes(q)));
}

function renderRecipients() {
  const list = visibleUsers();

  if (list.length === 0) {
    listEl.innerHTML = '<div class="sms-empty">No users found.</div>';
    selectAll.checked = false;
    return;
  }

  listEl.innerHTML = list
    .map((u) => {
      const sent = lastSent[u.mobile];
      const isSel = selected.has(u.id);
      const sentText = sent === "unknown" ? "Sent" : sent ? formatDate(sent) : "";
      return `
        <label class="sms-row ${u.smsEnabled ? "" : "disabled"} ${isSel ? "selected" : ""}">
          <input class="form-check-input recipient-check" type="checkbox" data-id="${esc(u.id)}"
            ${isSel ? "checked" : ""} ${u.smsEnabled ? "" : "disabled"} aria-label="Select ${esc(u.name)}">
          <div class="sms-person">
            <div class="sms-avatar ${avClass(u.name)}">${esc(initials(u.name))}</div>
            <div style="min-width:0">
              <div class="sms-name">${esc(u.name)}</div>
              <div class="sms-number">${esc(u.mobile)}</div>
            </div>
          </div>
          <span><span class="sms-pill ${u.smsEnabled ? "on" : "off"}">${u.smsEnabled ? "On" : "Off"}</span></span>
          <span class="sms-last ${sent ? "done" : ""}">${sent ? '<i class="bi bi-check2"></i> ' + esc(sentText) : "Never"}</span>
        </label>`;
    })
    .join("");

  syncSelectAll();
}

function syncSelectAll() {
  const selectable = visibleUsers().filter((u) => u.smsEnabled);
  selectAll.checked = selectable.length > 0 && selectable.every((u) => selected.has(u.id));
}

/* ---------- compose ---------- */

function updateCompose() {
  const text = messageBox.value;
  const len = text.length;
  const parts = countParts(len);
  const people = selected.size;

  $("charCount").textContent = len;
  $("partCount").textContent = parts;
  $("meter").firstElementChild.style.width = Math.min(100, (len / 160) * 100) + "%";
  $("meter").classList.toggle("over", len > 160);

  $("toBox").classList.toggle("has", people > 0);
  $("toText").textContent = people === 0 ? "No recipients yet" : `${people} recipient${people > 1 ? "s" : ""} selected`;
  $("clearBtn").hidden = people === 0;

  const bubble = $("previewBubble");
  bubble.textContent = text.trim() ? text : "Your message will show here.";
  bubble.classList.toggle("placeholder", !text.trim());
  $("previewSender").textContent = "Clinic phone"; // TextBee sends from the phone's SIM

  $("creditEstimate").textContent =
    people && parts
      ? `${people} recipient(s) × ${parts} SMS = about ${parts * people} text(s) from the clinic phone's load.`
      : "Pick recipients and write a message to see how many texts will be sent.";

  sendBtn.disabled = !(people > 0 && text.trim().length > 0);
}

function showFeedback(type, text) {
  $("sendFeedback").innerHTML = text ? `<div class="alert alert-${type} py-2 mb-3">${esc(text)}</div>` : "";
}

function setCampaign(c) {
  campaign = c;
  $("campaignBanner").hidden = !c;
  if (c) $("campaignText").textContent = `Seasonal awareness · ${c.title}`;
}

/* ---------- season + weather now ---------- */

let weatherMessage = "";

async function loadWeather() {
  if (!WEATHER_URL) return null;
  const res = await fetch(WEATHER_URL);
  if (!res.ok) throw new Error(`Weather error ${res.status}`);
  return res.json();
}

// Same rule as the notebook: humidity alone says little in the PH, so it needs two things at once.
// Numbers are converted first, in case the Worker sends them as text.
function assessWeather(w) {
  const humidity = Number(w.humidity);
  const temp = Number(w.temp);
  const rain = Number(w.rain1h) || 0;

  const humid = humidity >= HUMIDITY_THRESHOLD;
  const hot = temp >= TEMP_THRESHOLD;
  const wet = RAIN_CONDITIONS.includes(w.condition);
  const heavy = rain >= HEAVY_RAIN_MM_PER_HOUR;

  const diseases = [];
  const phrases = [];
  // if it is raining, the wet rule comes first (a rainy day should not say "hot and humid")
  if (humid && wet) { diseases.push("ringworm", "pyoderma"); phrases.push("Wet and humid today!"); }
  else if (humid && hot) { diseases.push("yeast", "pyoderma"); phrases.push("Hot and humid today!"); }
  if (heavy) { diseases.unshift("lepto"); phrases.unshift("Heavy rain, flooding possible!"); }

  return { diseases: [...new Set(diseases)], phrase: phrases[0] || "" };
}

function buildWeatherSms(diseases, phrase) {
  const tips = diseases.slice(0, 2).map((k) => WEATHER_TIPS[k]);
  const suffix = "Check the SkinPawsible manual.";
  while (true) {
    const msg = [`SkinPawsible: ${phrase}`, ...tips, suffix].join(" ");
    if (msg.length <= WEATHER_SMS_LIMIT || !tips.length) return msg;
    tips.pop();
  }
}

function weatherEmoji(condition) {
  return { Thunderstorm: "⛈️", Rain: "🌧️", Drizzle: "🌦️", Clouds: "☁️", Clear: "☀️" }[condition] || "🌤️";
}

// The card shows the weather right now. The calendar season is only shown if the weather cannot be loaded.
function renderNow(w, failed) {
  const i = SEASONS.findIndex((_, idx) => isCurrentSeason(idx));
  const s = SEASONS[i];

  const alertBox = $("nowAlert");
  alertBox.hidden = true;
  weatherMessage = "";

  if (!WEATHER_URL || failed || !w) {
    $("nowEmoji").textContent = s ? s.emoji : "🐾";
    $("nowSeason").textContent = s ? `${s.title} (${s.range})` : "Season";
    $("nowWeather").textContent = !WEATHER_URL
      ? "Calendar season only (follows the date, not today's weather). Live weather is not connected yet."
      : "Calendar season only (follows the date, not today's weather). Could not load the weather right now.";
    return;
  }

  const tempNum = Number(w.temp);
  const temp = w.temp == null || isNaN(tempNum) ? "?" : Math.round(tempNum);
  $("nowEmoji").textContent = weatherEmoji(w.condition);
  $("nowSeason").textContent = `Right now in ${w.city || "Legazpi"}: ${temp}°C · ${w.humidity}% humidity · ${w.condition || "-"}`;
  $("nowWeather").textContent = ""; // weather only, no season line

  console.log("Weather data:", w); // check this in the browser console if the alert looks wrong
  const { diseases, phrase } = assessWeather(w);
  if (diseases.length) {
    weatherMessage = buildWeatherSms(diseases, phrase);
    $("nowAlertText").textContent = `Weather alert: ${phrase}`;
    alertBox.hidden = false; // no alert = nothing shown
  }
}

// Reminder: when to send the seasonal message
function renderReminder() {
  const el = $("nowReminder");
  const i = SEASONS.findIndex((_, idx) => isCurrentSeason(idx));
  if (i < 0) { el.hidden = true; return; }

  const data = seasonData(i);
  if (data.sentAt) { el.hidden = true; return; } // already sent, no reminder

  const { start } = seasonRange(i);
  const days = Math.floor((NOW - start) / 86400000);
  el.textContent = days <= 7
    ? `${data.title} just started. Send its message in the Seasonal awareness tab.`
    : `${data.title} message not sent yet. See the Seasonal awareness tab.`;
  el.hidden = false;
}

// fill the message box with everyone who has SMS on selected (you can still remove people), then open the Send tab
function openInSend(message) {
  messageBox.value = message;
  selected.clear();
  users.filter((u) => u.smsEnabled).forEach((u) => selected.add(u.id));
  renderRecipients();
  updateCompose();
  bootstrap.Tab.getOrCreateInstance(document.querySelector('[data-bs-target="#sendPane"]')).show();
}

$("nowAlertUse").addEventListener("click", () => {
  if (!weatherMessage) return;
  setCampaign(null); // a weather alert is a normal message, it does not mark a season as sent
  openInSend(weatherMessage);
});

/* ---------- quick messages (your own + the 3 seasons) ---------- */

function quickMessages() {
  const seasonal = SEASONS.map((s, i) => ({
    label: `${s.emoji} ${s.title}${isCurrentSeason(i) ? " · this season" : ""}`,
    text: seasonData(i).message, // uses your edited text if you changed it in the Seasonal tab
  }));
  return [...TEMPLATES, ...seasonal];
}

function renderTemplates() {
  $("templateChips").innerHTML = quickMessages()
    .map((t, i) => `<button type="button" class="sms-chip" data-i="${i}">${esc(t.label)}</button>`)
    .join("");
}

/* ---------- seasonal awareness ---------- */

function renderAwareness() {
  $("awarenessYear").textContent = CYCLE_YEAR;

  $("awarenessList").innerHTML = SEASONS.map((s, i) => {
    const data = seasonData(i);
    const st = seasonStatus(i, data);
    const now = isCurrentSeason(i);
    return `
      <div class="sms-month ${now ? "now" : ""}">
        <div class="sms-month-chip"><div><span class="sms-season-emoji">${s.emoji}</span><small>${s.range}</small></div></div>
        <div class="sms-month-title">
          ${esc(data.title)} ${now ? '<em class="sms-now">This season</em>' : ""}
          <span>${esc(data.message)}</span>
        </div>
        <div><span class="sms-pill ${st.cls}">${esc(st.text)}</span></div>
        <div class="sms-month-actions">
          <button type="button" class="btn btn-sm btn-outline-secondary" data-edit="${i}">Edit</button>
          <button type="button" class="btn btn-sm btn-primary" data-use="${i}">${data.sentAt ? "Send again" : "Send"}</button>
        </div>
      </div>`;
  }).join("");

  const done = SEASONS.filter((_, i) => seasonData(i).sentAt).length;
  $("awarenessSummary").textContent = `${done} of ${SEASONS.length} seasons sent. These seasons follow the calendar (PAGASA national default), not the weather today. Send each one when its season starts (Mar, Jun, Dec).`;
}

const modal = () => bootstrap.Modal.getOrCreateInstance($("awarenessModal"));
let editingIndex = null;

function updateAwCount() {
  const len = $("awMessage").value.length;
  $("awCount").textContent = len;
  $("awParts").textContent = countParts(len);
}

$("awarenessList").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit]");
  const useBtn = e.target.closest("[data-use]");

  if (editBtn) {
    editingIndex = Number(editBtn.dataset.edit);
    const data = seasonData(editingIndex);
    $("awarenessModalTitle").textContent = `${SEASONS[editingIndex].title} · ${SEASONS[editingIndex].range}`;
    $("awTitle").value = data.title;
    $("awMessage").value = data.message;
    updateAwCount();
    modal().show();
  }

  if (useBtn) {
    const i = Number(useBtn.dataset.use);
    const data = seasonData(i);

    if (data.sentAt && !await window.SkinPawsibleDialogs.confirm(
      `This was already sent on ${formatDate(data.sentAt)}. Send it again?`,
      { title: "Send again?", confirmText: "Send" }
    )) return;

    setCampaign({ id: data.id, key: data.key, title: data.title });
    messageBox.value = data.message;

    // select everyone with SMS on (you can still remove people)
    selected.clear();
    users.filter((u) => u.smsEnabled).forEach((u) => selected.add(u.id));
    renderRecipients();
    updateCompose();

    bootstrap.Tab.getOrCreateInstance(document.querySelector('[data-bs-target="#sendPane"]')).show();
  }
});

$("awMessage").addEventListener("input", updateAwCount);

// put the original text from the scraper back in the form (not saved until you press Save)
$("awReset").addEventListener("click", () => {
  const s = SEASONS[editingIndex];
  $("awTitle").value = s.title;
  $("awMessage").value = s.message;
  updateAwCount();
});

$("awSave").addEventListener("click", async () => {
  const title = $("awTitle").value.trim();
  const message = $("awMessage").value.trim();
  if (!title || !message) {
    alert("Please fill in the topic and the message.");
    return;
  }
  if (
    !/^[\x00-\x7F]*$/.test(message) &&
    !await window.SkinPawsibleDialogs.confirm(
      "This message has special characters (like emoji or curly quotes). They can make each SMS cost more. Save anyway?",
      { title: "Save message with special characters?" }
    )
  ) return;

  const s = SEASONS[editingIndex];
  const id = `${CYCLE_YEAR}-${s.key}`;

  try {
    await setDoc(doc(db, AWARENESS_COLLECTION, id), { year: CYCLE_YEAR, season: s.key, title, message }, { merge: true });
    awareness[id] = { ...awareness[id], year: CYCLE_YEAR, season: s.key, title, message };
    renderAwareness();
    renderTemplates();
    modal().hide();
  } catch (err) {
    console.error(err);
    alert("Could not save. Check your Firestore rules for smsAwareness.");
  }
});

/* ---------- events ---------- */

listEl.addEventListener("change", (e) => {
  if (!e.target.classList.contains("recipient-check")) return;
  const id = e.target.dataset.id;
  e.target.checked ? selected.add(id) : selected.delete(id);
  e.target.closest(".sms-row").classList.toggle("selected", e.target.checked);
  syncSelectAll();
  updateCompose();
});

selectAll.addEventListener("change", () => {
  visibleUsers()
    .filter((u) => u.smsEnabled)
    .forEach((u) => (selectAll.checked ? selected.add(u.id) : selected.delete(u.id)));
  renderRecipients();
  updateCompose();
});

$("filterChips").addEventListener("click", (e) => {
  const chip = e.target.closest(".sms-chip");
  if (!chip) return;
  filter = chip.dataset.filter;
  document.querySelectorAll("#filterChips .sms-chip").forEach((c) => c.classList.toggle("active", c === chip));
  renderRecipients();
});

$("clearBtn").addEventListener("click", () => {
  selected.clear();
  renderRecipients();
  updateCompose();
});

$("campaignRemove").addEventListener("click", () => setCampaign(null));

renderTemplates();

$("templateChips").addEventListener("click", (e) => {
  const chip = e.target.closest(".sms-chip");
  if (!chip) return;
  messageBox.value = quickMessages()[chip.dataset.i].text;
  setCampaign(null); // quick message = normal message, so it does not mark the season as sent
  updateCompose();
});

searchInput.addEventListener("input", renderRecipients);
messageBox.addEventListener("input", updateCompose);

sendBtn.addEventListener("click", async () => {
  const chosen = users.filter((u) => selected.has(u.id) && u.smsEnabled);
  const message = messageBox.value.trim();
  if (!chosen.length || !message) return;

  if (!await window.SkinPawsibleDialogs.confirm(
    `Send this message to ${chosen.length} recipient(s)?`,
    { title: "Send SMS?", confirmText: "Send" }
  )) return;

  sendBtn.disabled = true;
  sendBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Sending...';
  showFeedback("", "");

  try {
    const result = await sendSms({
      numbers: chosen.map((u) => u.mobile),
      message,
    });

    const nowIso = new Date().toISOString();
    chosen.forEach((u) => (lastSent[u.mobile] = nowIso));

    if (!result.demo) {
      // the SMS is already sent at this point, so a failed save should not look like a failed send
      try {
        await saveLogs(result.messages || [], message, campaign?.id);
        if (campaign) {
          await setDoc(
            doc(db, AWARENESS_COLLECTION, campaign.id),
            { year: CYCLE_YEAR, season: campaign.key, sentAt: serverTimestamp(), sentCount: chosen.length },
            { merge: true }
          );
        }
      } catch (err) {
        console.error("Sent, but could not save the log:", err);
      }
    }

    if (campaign) {
      awareness[campaign.id] = { ...awareness[campaign.id], sentAt: nowIso, sentCount: chosen.length };
      renderAwareness();
      renderReminder();
    }

    selected.clear();
    messageBox.value = "";
    setCampaign(null);
    showFeedback(
      "success",
      result.demo
        ? `Test mode: ${chosen.length} message(s) were NOT really sent. Set DEMO_MODE to false to send for real.`
        : `Message sent to ${chosen.length} recipient(s). Your clinic phone will send them now, so keep the TextBee app open.`
    );
    updateStats();
    renderRecipients();
  } catch (err) {
    console.error(err);
    showFeedback("danger", err.message || "Sending failed. Please try again.");
  } finally {
    sendBtn.innerHTML = '<i class="bi bi-send me-1"></i> Send SMS';
    updateCompose();
  }
});

/* ---------- start (after login is ready) ---------- */

let started = false;

async function init() {
  try {
    await Promise.all([
      loadUsers(),
      loadAwareness(),
      // if this fails, the page still works, just without "Last message"
      loadLastSent().catch((err) => console.warn("Could not load SMS logs:", err)),
    ]);
    updateStats();
    renderRecipients();
    renderAwareness();
    renderReminder();
    renderTemplates();
    renderNow(null, false);
    if (window.location.hash === "#awarenessPane") {
      const awarenessTab = document.querySelector('[data-bs-target="#awarenessPane"]');
      if (awarenessTab) bootstrap.Tab.getOrCreateInstance(awarenessTab).show();
    }
    // the weather loads on its own, so a weather problem never blocks the rest of the page
    loadWeather()
      .then((w) => renderNow(w, false))
      .catch((err) => { console.warn("Could not load weather:", err); renderNow(null, true); });
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<div class="sms-empty text-danger">Could not load data. Check the browser console.</div>';
    $("awarenessList").innerHTML = '<div class="sms-empty text-danger">Could not load data.</div>';
  }
  updateCompose();
}

onAuthStateChanged(auth, (user) => {
  if (user && !started) {
    started = true;
    init();
  }
});