const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const chrono = require('chrono-node');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
app.use(express.urlencoded({ extended: false }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const ADMIN_PHONE = process.env.ADMIN_PHONE;

// Public URL of Flow's photo, sent during onboarding so the user can save it as
// the contact picture. Set this in your environment (see the setup guide).
const FLOW_PHOTO_URL = process.env.FLOW_PHOTO_URL;

// Public base URL of THIS server on Render, e.g. https://siteflow.onrender.com
// Used to build OAuth redirect URIs and the connect links Flow texts.
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');

// Xero OAuth2 app credentials (create the app at https://developer.xero.com).
// Register the redirect URI exactly as APP_BASE_URL + '/callback/xero'.
const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const XERO_REDIRECT_URI = APP_BASE_URL + '/callback/xero';
// Read-only scopes + offline_access so we get a refresh token.
const XERO_SCOPES = 'openid profile email offline_access accounting.transactions.read accounting.reports.read accounting.contacts.read';

// Keyword list that replaces the old "do I need to search?" LLM call.
// Defined once at module level so it isn't rebuilt on every request.
const SEARCH_KEYWORDS = [
  'price', 'cost', 'how much', 'weather', 'rain', 'forecast', 'temperature',
  'supplier', 'available', 'stock', 'buy', 'where can i', 'best place',
  'compare', 'difference between', 'versus', 'review', 'recommend',
  'today', 'this week', 'current', 'latest', 'news'
];

// Explicit self-harm / crisis phrases. Deliberately narrow to keep false
// positives low - see looksLikeCrisis().
const CRISIS_PATTERNS = [
  /\bkill myself\b/, /\bkilling myself\b/, /\bend my life\b/, /\bending my life\b/,
  /\btake my (own )?life\b/, /\bwant to die\b/, /\bwanna die\b/,
  /\bdon'?t want to (be here|live|wake up)\b/, /\bsuicid/, /\bself.?harm/,
  /\bharm myself\b/, /\bhurt myself\b/, /\bbetter off (without me|dead)\b/,
  /\bno reason to (live|go on)\b/, /\bcan'?t go on\b/, /\bend it all\b/
];

// Business details are now collected on the website during signup, NOT over SMS.
// The website attaches them to the access code (see provisionFromProfile), so the
// only SMS onboarding step left is "save me as a contact + photo".

// Copy a website-supplied profile onto the user doc. `profile` is whatever the
// website wrote to the access_codes doc under the `profile` field.
function provisionFromProfile(user, profile) {
  const p = profile || {};
  user.name          = p.name || '';
  user.trade         = p.trade || '';
  user.state         = p.state || '';
  user.workAreas     = p.workAreas || '';
  user.workHours     = p.workHours || '';
  user.finishTime    = p.workHours ? extractWorkHours(p.workHours) : '';
  user.suppliers     = p.suppliers || '';
  user.adminHeadache = p.adminHeadache || '';
  user.businessContext = buildBusinessContext(user);
}

function newUser() {
  return {
    name: '', trade: '', state: '', workAreas: '', workHours: '', finishTime: '',
    suppliers: '', adminHeadache: '',
    businessContext: '', onboarded: false,
    step: 'waitingCode',
    pendingReminders: [], history: [],
    teamMembers: [],
    // Feature toggles the builder can flip by texting Flow in plain English.
    preferences: {
      weeklySpecials: true,
      proactiveCheckins: true,
      tenderAlerts: false,
      employeeSearch: true
    },
    // The "apprentice model": what Flow has learned about this business.
    knowledge: {
      team:      [],
      suppliers: [],
      clients:   [],
      notes:     [],
      leads:     []   // possible jobs/work mentioned in conversation, to chase up
    },
    // Timestamps used by the proactive + specials schedulers.
    lastMessageAt: null,
    lastProactiveAt: null,
    lastSpecialsAt: null,
    // First-week "getting to know you" flow.
    signupAt: null,          // set when onboarding completes
    firstWeekAsked: [],      // keys of questions already asked in week one
    // Connected third-party accounts (OAuth). null until the builder connects.
    integrations: {
      xero: null,   // { tenantId, tenantName, accessToken, refreshToken, expiresAt, connectedAt }
      gmail: null   // reserved for the Gmail integration (pending Google verification)
    }
  };
}

function buildBusinessContext(user) {
  return user.name + " is a " + user.trade + " based in " + user.state +
    ", mainly working in " + user.workAreas + ". Work hours: " + user.workHours +
    ". Finish time: " + user.finishTime + ". Regular suppliers: " + user.suppliers +
    ". Biggest admin headache: " + user.adminHeadache + ".";
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Normalise however the admin types an Australian number into E.164 (+61...),
// which is the format Twilio reports as the sender - so the access code is always
// filed under the number the client will actually text from. Handles spaces,
// dashes, brackets, a leading 0, and numbers already in +61 form.
function normalizeAuPhone(raw) {
  let p = (raw || '').replace(/[^\d+]/g, ''); // strip spaces, dashes, brackets
  if (p.startsWith('+')) return p;            // already international
  if (p.startsWith('0')) return '+61' + p.slice(1);
  if (p.startsWith('61')) return '+' + p;
  if (p.length === 9 && p.startsWith('4')) return '+61' + p;
  return '+61' + p;
}

// ---- Reminder times are parsed in the USER's timezone (derived from their state)
// so "5pm" means 5pm where they are, not 5pm on the server (UTC). ----

function tzForState(state) {
  const s = (state || '').toLowerCase();
  if (/(qld|queensland)/.test(s)) return 'Australia/Brisbane';
  if (/(south australia|\bsa\b)/.test(s)) return 'Australia/Adelaide';
  if (/(northern territory|\bnt\b)/.test(s)) return 'Australia/Darwin';
  if (/(western australia|\bwa\b)/.test(s)) return 'Australia/Perth';
  if (/(tasmania|\btas\b)/.test(s)) return 'Australia/Hobart';
  return 'Australia/Sydney'; // NSW / VIC / ACT and anything unrecognised
}

function tzOffsetMinutes(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = dtf.formatToParts(date).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

// Local weekday ("Mon") and hour (0-23) in a given timezone, right now.
function localWeekdayHour(tz) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false
  }).formatToParts(new Date()).reduce(function (a, x) { a[x.type] = x.value; return a; }, {});
  let hour = parseInt(parts.hour, 10);
  if (isNaN(hour) || hour === 24) hour = 0;
  return { weekday: parts.weekday, hour: hour };
}

// Local calendar date ("YYYY-MM-DD") in a timezone, for "is this today?" checks.
function localDateKey(tz, date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date || new Date());
}

function parseAuTime(text, tz) {
  const now = new Date();
  return chrono.parseDate(
    text,
    { instant: now, timezone: tzOffsetMinutes(tz, now) },
    { forwardDate: true }
  );
}

function extractWorkHours(workHours) {
  const match = workHours.match(/to\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
  if (match) return match[1].trim();
  const parts = workHours.split(/\s*(?:to|[-\u2013])\s*/i); // word "to" or a dash, not the letters t/o
  if (parts.length >= 2) return parts[parts.length - 1].trim();
  return workHours.trim();
}

function isVagueTime(message) {
  const vagueTerms = ['in the morning', 'this morning', 'after work', 'end of day', 'when i finish', 'when i get home', 'at night', 'tonight', 'this evening', 'evening', 'at lunch', 'lunchtime', 'lunch time', 'first thing', 'start of day', 'later today', 'sometime today'];
  return vagueTerms.some(function(t) { return message.toLowerCase().includes(t); });
}

function isProfileUpdate(message) {
  const phrases = ['update my', 'change my', 'my trade is now', 'i moved to', 'i now work in', 'my hours are now', 'my suppliers are', 'update profile', 'change profile', 'edit my'];
  return phrases.some(function(p) { return message.toLowerCase().includes(p); });
}

// Does this short message look like a request to turn a feature on or off?
// Requires BOTH an on/off intent AND a feature word, matched on word boundaries,
// and only on short imperative messages - this keeps false positives low
// (e.g. "stop by Bunnings and grab a lead" no longer trips it).
function isPreferenceUpdate(message) {
  const lower = (message || '').toLowerCase();
  if (lower.trim().split(/\s+/).length > 14) return false;
  const intent = /\b(start|turn on|enable|send me|stop|turn off|disable|no thanks)\b/.test(lower)
    || /don'?t send|do not send/.test(lower);
  const feature = /\b(specials?|check[- ]?ins?|proactive|tenders?|alerts?|employees?|weather|forecast)\b/.test(lower);
  return intent && feature;
}

function looksLikeCrisis(message) {
  const lower = (message || '').toLowerCase();
  return CRISIS_PATTERNS.some(function(re) { return re.test(lower); });
}

function searchWeb(query) {
  return new Promise(function(resolve) {
    const encodedQuery = encodeURIComponent(query);
    const options = {
      hostname: 'api.search.brave.com',
      path: '/res/v1/web/search?q=' + encodedQuery + '&count=5',
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY }
    };

    const req = https.request(options, function(res) {
      let chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        try {
          const buffer = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];

          function processData(data) {
            try {
              const parsed = JSON.parse(data.toString());
              const results = parsed.web && parsed.web.results ? parsed.web.results : [];
              if (results.length === 0) { resolve('No search results found.'); return; }
              resolve(results.slice(0, 4).map(function(r) { return r.title + ': ' + (r.description || ''); }).join('\n'));
            } catch (e) { resolve('Could not parse search results.'); }
          }

          if (encoding === 'gzip') {
            zlib.gunzip(buffer, function(err, decoded) { if (err) { resolve('Could not decode.'); } else { processData(decoded); } });
          } else if (encoding === 'deflate') {
            zlib.inflate(buffer, function(err, decoded) { if (err) { resolve('Could not decode.'); } else { processData(decoded); } });
          } else { processData(buffer); }
        } catch (e) { resolve('Search unavailable.'); }
      });
    });

    req.on('error', function() { resolve('Search unavailable.'); });
    req.end();
  });
}

// Like searchWeb, but returns structured results WITH urls so Flow can send links.
function searchWebLinks(query) {
  return new Promise(function(resolve) {
    const encodedQuery = encodeURIComponent(query);
    const options = {
      hostname: 'api.search.brave.com',
      path: '/res/v1/web/search?q=' + encodedQuery + '&count=8',
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY }
    };
    const req = https.request(options, function(res) {
      let chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        try {
          const buffer = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];
          function processData(data) {
            try {
              const parsed = JSON.parse(data.toString());
              const results = (parsed.web && parsed.web.results) ? parsed.web.results : [];
              resolve(results.slice(0, 6).map(function(r) {
                return { title: r.title || '', url: r.url || '', description: r.description || '' };
              }).filter(function(r) { return r.url; }));
            } catch (e) { resolve([]); }
          }
          if (encoding === 'gzip') {
            zlib.gunzip(buffer, function(err, decoded) { if (!err) processData(decoded); else resolve([]); });
          } else if (encoding === 'deflate') {
            zlib.inflate(buffer, function(err, decoded) { if (!err) processData(decoded); else resolve([]); });
          } else { processData(buffer); }
        } catch (e) { resolve([]); }
      });
    });
    req.on('error', function() { resolve([]); });
    req.end();
  });
}

// Pull an MMS image down from Twilio (the media URL needs Basic auth) and hand
// back base64 + content type for the vision model. Requires Node 18+ (global fetch).
async function fetchTwilioMedia(url) {
  const auth = Buffer.from(
    process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN
  ).toString('base64');
  const resp = await fetch(url, { headers: { Authorization: 'Basic ' + auth } });
  if (!resp.ok) throw new Error('Media fetch failed: ' + resp.status);
  const contentType = resp.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await resp.arrayBuffer());
  return { base64: buf.toString('base64'), contentType: contentType };
}

async function getUser(phone) {
  const doc = await db.collection('users').doc(phone).get();
  if (doc.exists) return doc.data();
  return newUser();
}

// Fill in any fields added after a user first onboarded, so the rest of the code
// can assume they exist.
function backfillUser(user) {
  if (!user.preferences) {
    user.preferences = { weeklySpecials: true, proactiveCheckins: true, tenderAlerts: false, employeeSearch: true };
  }
  if (!user.knowledge) {
    user.knowledge = { team: [], suppliers: [], clients: [], notes: [], leads: [] };
  }
  if (user.knowledge && !Array.isArray(user.knowledge.leads)) user.knowledge.leads = [];
  if (typeof user.lastMessageAt === 'undefined') user.lastMessageAt = null;
  if (typeof user.lastProactiveAt === 'undefined') user.lastProactiveAt = null;
  if (typeof user.lastSpecialsAt === 'undefined') user.lastSpecialsAt = null;
  if (typeof user.signupAt === 'undefined') user.signupAt = null;
  if (!Array.isArray(user.firstWeekAsked)) user.firstWeekAsked = [];
  if (!user.integrations) user.integrations = { xero: null, gmail: null };
  if (!Array.isArray(user.pendingReminders)) {
    user.pendingReminders = (user.pendingReminderTask && user.pendingReminderTask !== '')
      ? [user.pendingReminderTask] : [];
  }
  delete user.pendingReminderTask;
}

async function saveUser(phone, user) {
  await db.collection('users').doc(phone).set(user);
}

async function saveReminder(reminder) {
  await db.collection('reminders').add({
    phone: reminder.phone, name: reminder.name, task: reminder.task,
    time: admin.firestore.Timestamp.fromDate(reminder.time), sent: false
  });
}

async function getPendingReminders() {
  const snapshot = await db.collection('reminders').where('sent', '==', false).get();
  const reminders = [];
  snapshot.forEach(function(doc) {
    const data = doc.data();
    reminders.push({ id: doc.id, phone: data.phone, name: data.name, task: data.task, time: data.time.toDate() });
  });
  return reminders;
}

async function markReminderSent(id) {
  await db.collection('reminders').doc(id).update({ sent: true });
}

// All not-yet-sent reminders for one phone, soonest first.
// Single-field query => no Firestore composite index needed.
async function getUpcomingReminders(phone) {
  const snapshot = await db.collection('reminders').where('phone', '==', phone).get();
  const out = [];
  snapshot.forEach(function(doc) {
    const d = doc.data();
    if (d.sent !== true) out.push({ id: doc.id, task: d.task, time: d.time.toDate() });
  });
  out.sort(function(a, b) { return a.time - b.time; });
  return out;
}

async function deleteReminder(id) {
  await db.collection('reminders').doc(id).delete();
}

function wantsReminderList(message) {
  const lower = (message || '').toLowerCase();
  return /\b(show|list|see|view|what(?:'?s| are)|whats)\b[^\n]*\breminders?\b/.test(lower)
    || /^(my )?reminders\??$/.test(lower.trim());
}

function wantsCancelReminder(message) {
  const lower = (message || '').toLowerCase();
  return /\b(cancel|delete|remove|clear|scrap|drop)\b[^\n]*\breminders?\b/.test(lower)
    || /\bforget (the |my )?reminder/.test(lower);
}

// "morning briefing", "brief me", "what have I got on today", "rundown"...
function wantsBriefing(message) {
  const lower = (message || '').toLowerCase();
  return /\bbriefing\b/.test(lower)
    || /\b(morning|daily) brief\b/.test(lower)
    || /\bbrief me\b/.test(lower)
    || /\brun ?down\b/.test(lower)
    || /\bsitrep\b/.test(lower)
    || /\bwhat(?:'?s| have i got| do i have)\b[^\n]*\btoday\b/.test(lower)
    || /^(my day|the plan|today)\??$/.test(lower.trim());
}

// "plan for today: ...", "today's plan ...", "my plan today ..."
function parseTodaysPlan(message) {
  const m = (message || '').match(/^(?:my )?(?:plan\s+(?:for\s+)?today|today'?s\s+plan|todays\s+plan|plan\s+today)\b[:\-\s]*(.*)/i);
  if (m && m[1] && m[1].trim().length > 1) return m[1].trim();
  return null;
}

// "cheapest 90/45 near me", "best price on villaboard", "where can I buy..."
function wantsPriceCheck(message) {
  const lower = (message || '').toLowerCase();
  return /\bcheapest\b/.test(lower)
    || /\bbest (price|deal|deals)\b/.test(lower)
    || /\bprices? (of|on|for|near)\b/.test(lower)
    || /\bhow much (is|are|does|do)\b/.test(lower)
    || /\bwhere (can i (buy|get)|to buy|to get)\b/.test(lower);
}

// Strip the shopping intent words to leave the product itself.
function extractProductQuery(message) {
  return (message || '')
    .replace(/\b(cheapest|best price|best deal|best deals|prices?|price of|how much (is|are|does|do)|where (can i (buy|get)|to buy|to get)|near me|around me|close to me|for me|please|find me|the|a|an|some)\b/gi, ' ')
    .replace(/\?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ----- Quick takeoffs: turn dimensions into a material quantity -----
function toNum(x) { const n = parseFloat(x); return isFinite(n) ? n : null; }
function round1(n) { return Math.round(n * 10) / 10; }

function wantsTakeoff(message) {
  const lower = (message || '').toLowerCase();
  const material = /\b(concrete|cement|tiles?|tiling|paint|painting|render|decking|deck|gravel|topsoil|soil|mulch|screed|pavers?)\b/.test(lower);
  const ask = /\bhow (much|many)\b/.test(lower) || /\b(take[- ]?off|work out|calculate|how much do i need|how many do i need|quantity)\b/.test(lower);
  const dims = /\d\s*(?:mm|cm|m)?\s*(?:x|×|by|\*)\s*\d/.test(lower) || /\d+\s*(?:m2|sqm|square ?met)/.test(lower);
  return material && (ask || dims);
}

// Deterministic maths (the LLM only parses the request into numbers; code does the sums).
function computeTakeoff(s) {
  const m = (s.material || '').toLowerCase();
  const L = toNum(s.length), W = toNum(s.width), D = toNum(s.depth), H = toNum(s.height);

  if (m === 'concrete') {
    if (!L || !W || !D) return null;
    const vol = L * W * D;
    return "Concrete for " + L + "m x " + W + "m x " + Math.round(D * 1000) + "mm:\n" +
      "~" + round1(vol) + "m3 (order ~" + round1(vol * 1.1) + "m3 to allow 10% for waste and spillage).\n" +
      "Worth confirming with your batching plant before the pour.";
  }
  if (m === 'tiles') {
    if (!L || !W) return null;
    const area = L * W;
    if (!s.tile_w_mm || !s.tile_h_mm) {
      return "Tiling area is ~" + round1(area) + "m2 (about " + round1(area * 1.1) + "m2 with 10% for cuts). Tell me the tile size (e.g. 300x300) and I'll give you a tile count.";
    }
    const perTile = (s.tile_w_mm / 1000) * (s.tile_h_mm / 1000);
    const tiles = Math.ceil((area / perTile) * 1.1);
    return "Tiles for " + L + "m x " + W + "m (" + round1(area) + "m2) at " + s.tile_w_mm + "x" + s.tile_h_mm + ":\n" +
      "~" + tiles + " tiles incl. 10% for cuts and waste. Round up to full boxes.";
  }
  if (m === 'paint') {
    let area = null;
    if (L && H) area = L * H;
    else if (L && W) area = L * W;
    if (!area) return null;
    const coats = toNum(s.coats) || 2;
    const cover = toNum(s.coverage_m2_per_l) || 10;
    const litres = (area * coats) / cover;
    return "Paint for ~" + round1(area) + "m2, " + coats + " coat(s) (approx " + cover + "m2/L):\n" +
      "~" + round1(litres) + "L. Grab the next tin size up so you're not caught short.";
  }
  if (m === 'decking') {
    if (!L || !W) return null;
    const area = L * W;
    const bw = toNum(s.board_w_mm) || 90;
    const gap = toNum(s.gap_mm) || 4;
    const lineal = area * (1 / ((bw + gap) / 1000)) * 1.1;
    return "Decking for " + L + "m x " + W + "m (" + round1(area) + "m2), " + bw + "mm boards + " + gap + "mm gap:\n" +
      "~" + Math.ceil(lineal) + " lineal metres incl. 10% waste. That's boards only - tell me the joist spacing if you want framing too.";
  }
  if (m === 'area') {
    if (!L || !W) return null;
    return "That's ~" + round1(L * W) + "m2. Tell me the material (concrete, tiles, paint, decking) and I'll turn it into a quantity.";
  }
  return null;
}

// ----- Vehicle logbook: log km against jobs, tally for the financial year -----
function ausFYStartKey(tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(new Date()).split('-');
  let year = parseInt(p[0], 10);
  if (parseInt(p[1], 10) < 7) year -= 1; // Australian financial year starts 1 July
  return year + '-07-01';
}
function startOfMonthKey(tz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(new Date()).split('-');
  return p[0] + '-' + p[1] + '-01';
}
function sumLogbookSince(log, sinceKey) {
  return log.reduce(function (t, e) { return (e && e.date && e.date >= sinceKey) ? t + (toNum(e.km) || 0) : t; }, 0);
}
function sumLogbookFY(log, tz) { return sumLogbookSince(log, ausFYStartKey(tz)); }

function parseLogbookEntry(message) {
  const lower = (message || '').toLowerCase();
  if (/\bremind|reminder|don'?t let me forget|make sure i\b/.test(lower)) return null; // that's a reminder, not a trip
  const km = lower.match(/(\d+(?:\.\d+)?)\s*(km\b|kms\b|k's\b|ks\b|kays\b|kilometres?\b|kilometers?\b)/);
  if (!km) return null;
  const tripContext = /\bto\b/.test(lower) || /\b(log|logged|drove|drive|driving|trip|travel(?:led)?|clocked|ran)\b/.test(lower);
  if (!tripContext) return null;
  const distance = parseFloat(km[1]);
  if (!isFinite(distance) || distance <= 0) return null;
  let dest = '';
  const toMatch = (message || '').match(/\bto\s+(?:the\s+)?(.+?)(?:\s+job\b|[.!?]|$)/i);
  if (toMatch && toMatch[1]) dest = toMatch[1].trim().replace(/\s+/g, ' ');
  return { km: distance, dest: dest };
}

function wantsLogbookSummary(message) {
  const lower = (message || '').toLowerCase();
  return /\b(log ?book|km log|kms? log)\b/.test(lower)
    || (/\b(total|how many|how much|sum|tally)\b/.test(lower) && /\b(km|kms|kilometres?|kilometers?|mileage|travel)\b/.test(lower))
    || /\b(km|kms) (this|for) (week|month|year|fortnight|quarter)\b/.test(lower);
}

// Log anything Flow can't do yet so the team can see what people are asking for.
async function logFeatureRequest(phone, trade, request) {
  await db.collection('feature_requests').add({
    phone: phone,
    trade: trade || 'unknown',
    request: request,
    createdAt: admin.firestore.Timestamp.now()
  });
}

// ============================ INTEGRATIONS: XERO (read-only) ============================
// Flow texts the builder a one-time connect link. They authorise in the browser,
// Xero redirects back to /callback/xero, and we store their tokens + tenant id on
// the user doc. After that, money questions over SMS hit the Xero API live.

// Create a short-lived, single-use token that ties a connect link back to a phone.
async function createConnectToken(phone, provider) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.collection('connect_tokens').doc(token).set({
    phone: phone,
    provider: provider,
    used: false,
    createdAt: admin.firestore.Timestamp.now()
  });
  return token;
}

function xeroConfigured() {
  return Boolean(XERO_CLIENT_ID && XERO_CLIENT_SECRET && APP_BASE_URL);
}

function xeroBasicAuth() {
  return Buffer.from(XERO_CLIENT_ID + ':' + XERO_CLIENT_SECRET).toString('base64');
}

// Exchange an authorisation code (or refresh token) for a token set.
async function xeroTokenRequest(params) {
  const resp = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + xeroBasicAuth(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params).toString()
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('Xero token request failed: ' + resp.status + ' ' + text);
  }
  return resp.json();
}

// Ensure the stored access token is valid, refreshing it (and persisting the new
// rotated refresh token) if it has expired. Returns the live access token.
async function xeroEnsureToken(phone, user) {
  const x = user.integrations && user.integrations.xero;
  if (!x) throw new Error('Xero not connected');
  const now = Date.now();
  if (x.expiresAt && now < (x.expiresAt - 60000)) return x.accessToken; // still valid

  const tok = await xeroTokenRequest({
    grant_type: 'refresh_token',
    refresh_token: x.refreshToken
  });
  x.accessToken = tok.access_token;
  x.refreshToken = tok.refresh_token || x.refreshToken; // Xero rotates the refresh token
  x.expiresAt = Date.now() + (tok.expires_in || 1800) * 1000;
  user.integrations.xero = x;
  await saveUser(phone, user);
  return x.accessToken;
}

async function xeroGet(phone, user, apiPath) {
  const accessToken = await xeroEnsureToken(phone, user);
  const resp = await fetch('https://api.xero.com/api.xro/2.0/' + apiPath, {
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Xero-tenant-id': user.integrations.xero.tenantId,
      'Accept': 'application/json'
    }
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('Xero API ' + apiPath + ' failed: ' + resp.status + ' ' + text);
  }
  return resp.json();
}

// Xero returns Microsoft JSON dates like "/Date(1719795600000+0000)/".
function parseXeroDate(s) {
  if (!s) return null;
  const m = String(s).match(/\/Date\((\d+)/);
  return m ? new Date(parseInt(m[1], 10)) : null;
}

function fmtAud(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Build a short, SMS-friendly money summary from outstanding sales invoices.
async function getXeroMoneySummary(phone, user) {
  // ACCREC = money owed TO the builder. AUTHORISED = approved and awaiting payment.
  const data = await xeroGet(phone, user, 'Invoices?where=' +
    encodeURIComponent('Type=="ACCREC" AND Status=="AUTHORISED"'));
  const invoices = (data && data.Invoices) ? data.Invoices : [];

  let owed = 0, overdueTotal = 0, overdueCount = 0;
  let oldest = null;
  const now = new Date();

  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i];
    const due = Number(inv.AmountDue) || 0;
    if (due <= 0) continue;
    owed += due;
    const dueDate = parseXeroDate(inv.DueDateString || inv.DueDate);
    if (dueDate && dueDate < now) {
      overdueTotal += due;
      overdueCount += 1;
      if (!oldest || dueDate < oldest.date) {
        oldest = { date: dueDate, name: (inv.Contact && inv.Contact.Name) || 'a client', amount: due };
      }
    }
  }

  if (owed === 0) {
    return "Your Xero's looking clean - no outstanding invoices owed to you right now.";
  }

  let msg = "You're owed " + fmtAud(owed) + " across outstanding invoices.";
  if (overdueCount > 0) {
    const days = oldest ? Math.floor((now - oldest.date) / 86400000) : 0;
    msg += " " + overdueCount + (overdueCount === 1 ? " is overdue" : " are overdue") +
      " (" + fmtAud(overdueTotal) + ")";
    if (oldest) msg += ", oldest is " + oldest.name + " at " + days + " days";
    msg += ".";
  }
  msg += " (Live from Xero just now.)";
  return msg;
}

// Does this look like a "how's the money / invoices" question?
function isMoneyQuery(message) {
  const lower = (message || '').toLowerCase();
  return /\b(cash ?flow|how'?s the money|how is the money|money looking|who owes|owe me|outstanding invoice|unpaid invoice|overdue|invoices? owed|get paid)\b/.test(lower);
}

function wantsXeroConnect(message) {
  const lower = (message || '').toLowerCase();
  return /\b(connect|link|hook up|set up|setup)\b/.test(lower) && /\bxero\b/.test(lower);
}

// "Any work going / find me leads / tenders near me"
function wantsLeadSearch(message) {
  const lower = (message || '').toLowerCase();
  return /\b(work going|work available|any (new )?work|find (me )?(work|leads?|tenders?|new jobs?)|any (new )?leads?|tenders?|new jobs near|jobs going|whats around|what'?s around)\b/.test(lower);
}

// "Find me a labourer / help me hire / write a job ad"
function wantsHiringHelp(message) {
  const lower = (message || '').toLowerCase();
  const role = /\b(labou?rer|apprentice|chippy|chippie|sparky|tradie|subbie|sub-?contractor|carpenter|plumber|worker|staff|employee|offsider)\b/.test(lower);
  const hire = /\b(hire|hiring|find (me )?(a|an|some)|put on|take on|need (a|an|some|another)|looking for (a|an|some)|job ad|advertise (a|an|the))\b/.test(lower);
  return (hire && role) || /\bjob ad\b/.test(lower);
}

// First-week "getting to know you" questions. Returns the next one not yet asked,
// skipping anything Flow already knows (e.g. the name if it came from signup).
function nextFirstWeekQuestion(user) {
  const asked = Array.isArray(user.firstWeekAsked) ? user.firstWeekAsked : [];
  const k = user.knowledge || {};
  const candidates = [];
  if (!user.name) {
    candidates.push({ key: 'name', text: "I didn't catch your name - what should I call you?" });
  }
  if (!k.team || k.team.length === 0) {
    candidates.push({ key: 'team', text: "Who's on your crew? Give me their names and what they do and I'll keep track of who's on what job." });
  }
  candidates.push({ key: 'currentwork', text: "What are you working on at the moment? I'll keep tabs on it and chase up anything that needs following." });
  if (!k.clients || k.clients.length === 0) {
    candidates.push({ key: 'clients', text: "Who are the main clients or builders you work for? Helps me keep your jobs straight." });
  }
  candidates.push({ key: 'rapport', text: "How long have you been running the show? Good to know who I'm working for." });

  for (let i = 0; i < candidates.length; i++) {
    if (asked.indexOf(candidates[i].key) === -1) return candidates[i];
  }
  return null;
}

// ============================ WEATHER ============================
// Free, key-less forecasts via Open-Meteo (geocoding + daily forecast). The
// geocode result is cached on the user doc (weatherGeo) so we only look it up once.

async function getJson(url) {
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) { return null; }
}

// Turn the user's work area (or state) into lat/long. Biases to Australian hits.
async function geocodeForUser(user) {
  if (user.weatherGeo && typeof user.weatherGeo.lat === 'number') return user.weatherGeo;
  const raw = (user.workAreas || user.state || '').split(/[,/&]|\band\b/i)[0].trim();
  if (!raw) return null;
  const data = await getJson('https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=' + encodeURIComponent(raw));
  if (!data || !data.results || !data.results.length) return null;
  const au = data.results.filter(function (r) { return r.country_code === 'AU'; });
  const r = au[0] || data.results[0];
  return { lat: r.latitude, lon: r.longitude, label: r.name + (r.admin1 ? (', ' + r.admin1) : '') };
}

function wmoText(code) {
  const m = { 0:'clear skies', 1:'mostly sunny', 2:'partly cloudy', 3:'overcast', 45:'foggy', 48:'foggy',
    51:'light drizzle', 53:'drizzle', 55:'heavy drizzle', 56:'freezing drizzle', 57:'freezing drizzle',
    61:'light rain', 63:'steady rain', 65:'heavy rain', 66:'freezing rain', 67:'freezing rain',
    71:'light snow', 73:'snow', 75:'heavy snow', 77:'snow grains',
    80:'passing showers', 81:'showers', 82:'heavy showers', 85:'snow showers', 86:'snow showers',
    95:'thunderstorms', 96:'storms with hail', 99:'severe storms with hail' };
  return m[code] || 'mixed conditions';
}

async function fetchForecast(geo) {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + geo.lat + '&longitude=' + geo.lon +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max' +
    '&timezone=auto&forecast_days=2';
  const data = await getJson(url);
  if (!data || !data.daily || !data.daily.time) return null;
  const d = data.daily;
  function day(i) {
    if (i >= d.time.length) return null;
    return {
      code: d.weather_code[i],
      tmax: d.temperature_2m_max[i], tmin: d.temperature_2m_min[i],
      rain: d.precipitation_sum[i],
      rainProb: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
      wind: d.wind_speed_10m_max[i], gust: d.wind_gusts_10m_max[i],
      uv: d.uv_index_max ? d.uv_index_max[i] : null
    };
  }
  return { today: day(0), tomorrow: day(1) };
}

// "Bad weather" worth a heads-up, per the owner's definition: extreme heat
// (38 degrees or hotter) or extreme rain (a heavy 25mm+ day).
function extremeReasons(day) {
  if (!day) return [];
  const r = [];
  if (day.tmax >= 38) r.push('extreme heat around ' + Math.round(day.tmax) + ' degrees');
  if (day.rain >= 25) r.push('extreme rain, around ' + Math.round(day.rain) + 'mm');
  return r;
}

function describeDay(label, place, day) {
  let s = label + (place ? (' in ' + place) : '') + ': ' + wmoText(day.code) + ', ' +
    Math.round(day.tmin) + ' to ' + Math.round(day.tmax) + ' degrees';
  if (day.rainProb != null) s += ', ' + day.rainProb + '% chance of rain';
  if (day.rain) s += ' (' + Math.round(day.rain) + 'mm)';
  s += ', wind to ' + Math.round(day.wind) + ' km/h, gusts ' + Math.round(day.gust);
  if (day.uv != null) s += ', UV max ' + Math.round(day.uv);
  return s + '.';
}

// Build the funny morning weather report. A next-day heads-up is folded into the
// same message when tomorrow looks extreme. Returns { body, geo } or null.
async function buildWeatherMessage(user) {
  const geo = await geocodeForUser(user);
  if (!geo) return null;
  const fc = await fetchForecast(geo);
  if (!fc || !fc.today) return null;

  const todayLine = describeDay('TODAY', geo.label, fc.today);
  const reasons = extremeReasons(fc.tomorrow);
  const extremeLine = reasons.length ? ('TOMORROW is shaping up extreme: ' + reasons.join('; ') + '.') : '';

  const sys = "You are Flow, an Australian tradie's text-message assistant delivering a VERY SHORT, funny morning weather report - like a larger-than-life weather presenter who also works in construction. " +
    "Keep it to 2 short sentences, about 35 words max: one painting today's weather with a touch of Aussie humour, one practical line for working outdoors (good day for a pour/paint/roof, or a washout; quick sunsmart nudge only if the UV is high). " +
    "Greet them by name once. Use the figures provided and DO NOT invent any numbers. Australian spelling, degrees C. No hashtags, no emojis. " +
    (extremeLine ? "Then add ONE short line warning about TOMORROW's extreme weather (make clear it is tomorrow). " : "") +
    "Do not add any labels, tags, or sign-off.";
  const userContent = 'Name: ' + (user.name || 'mate') + '\n' + todayLine + (extremeLine ? ('\n' + extremeLine) : '');

  let body;
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 130,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }]
    });
    body = (resp.choices[0].message.content || '').trim();
  } catch (e) { console.error('Weather LLM failed:', e); return null; }
  if (!body) return null;
  return { body: body, geo: geo };
}

// Short evening heads-up (around 8pm) sent the night before extreme weather.
// Returns { body, geo }, or null when tomorrow is nothing to worry about.
async function buildEveningAlert(user) {
  const geo = await geocodeForUser(user);
  if (!geo) return null;
  const fc = await fetchForecast(geo);
  if (!fc || !fc.tomorrow) return null;
  const reasons = extremeReasons(fc.tomorrow);
  if (!reasons.length) return null;

  const sys = "You are Flow, an Australian tradie's text-message assistant sending a VERY SHORT evening heads-up the night before rough weather. " +
    "Keep it to 1-2 sentences, about 30 words max: what tomorrow is bringing plus one quick practical tip (start early and hydrate in the heat, or plan indoor work if it will bucket down). " +
    "Greet them by name once. Use the figures provided and DO NOT invent numbers. Australian spelling, degrees C. No hashtags, no emojis. Make clear this is about TOMORROW. Do not add any labels, tags, or sign-off.";
  const userContent = 'Name: ' + (user.name || 'mate') + '\nTOMORROW: ' + reasons.join('; ') + '. ' + describeDay('Tomorrow', geo.label, fc.tomorrow);

  let body;
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 80,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }]
    });
    body = (resp.choices[0].message.content || '').trim();
  } catch (e) { console.error('Evening alert LLM failed:', e); return null; }
  if (!body) return null;
  return { body: body, geo: geo };
}

// Assemble an on-demand morning briefing from what Flow already tracks for this
// user: today's reminders, open quotes/jobs, a plan they've texted in, and the
// day's weather. Returns a short message, or null if there is genuinely nothing.
async function buildBriefing(user, phone, tz) {
  const todayKey = localDateKey(tz);

  let reminderLines = [];
  try {
    const ups = await getUpcomingReminders(phone);
    reminderLines = ups
      .filter(function (r) { return localDateKey(tz, r.time) === todayKey; })
      .map(function (r) {
        return r.task + ' at ' + r.time.toLocaleString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: tz });
      });
  } catch (e) { /* skip reminders on error */ }

  let leadLines = [];
  if (user.knowledge && Array.isArray(user.knowledge.leads)) {
    leadLines = user.knowledge.leads
      .filter(function (l) { return l && l.status !== 'closed' && l.label; })
      .slice(0, 5)
      .map(function (l) { return l.label; });
  }

  let plan = '';
  if (user.todaysPlan && user.todaysPlan.date === todayKey && user.todaysPlan.text) plan = user.todaysPlan.text;

  let weatherLine = '';
  try {
    const geo = await geocodeForUser(user);
    if (geo) {
      const fc = await fetchForecast(geo);
      if (fc && fc.today) {
        const t = fc.today;
        weatherLine = wmoText(t.code) + ', ' + Math.round(t.tmin) + ' to ' + Math.round(t.tmax) + ' degrees' +
          (t.rainProb != null ? (', ' + t.rainProb + '% chance of rain') : '');
      }
    }
  } catch (e) { /* skip weather on error */ }

  if (!reminderLines.length && !leadLines.length && !plan && !weatherLine) return null;

  const data =
    "Plan for today: " + (plan || 'not given') + "\n" +
    "Reminders today: " + (reminderLines.length ? reminderLines.join('; ') : 'none') + "\n" +
    "Open quotes/jobs to chase: " + (leadLines.length ? leadLines.join('; ') : 'none') + "\n" +
    "Weather today: " + (weatherLine || 'unavailable');

  const sys = "You are Flow, an Australian tradie's assistant giving a SHORT on-demand morning briefing by text. " +
    "Greet them by name once, then a tight, scannable rundown using ONLY the data below - never invent anything. " +
    "Give a short line each for their plan, reminders, quotes/jobs to chase, and a few words on the weather. SKIP anything marked none / not given / unavailable instead of mentioning it. " +
    "Warm, natural, Australian. No hashtags, no emojis. Finish with a brief offer such as 'Want me to add anything?'. Do not add any labels, tags, or sign-off.";
  const userContent = "Name: " + (user.name || 'mate') + "\n" + data;

  let body;
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 170,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: userContent }]
    });
    body = (resp.choices[0].message.content || '').trim();
  } catch (e) { console.error('Briefing LLM failed:', e); return null; }
  return body || null;
}

// ============================ SCHEDULERS ============================
// NOTE: these rely on the process staying awake. On a Render instance that
// spins down when idle they will NOT run reliably - use an always-on instance
// or an external scheduler (e.g. Render Cron Jobs) hitting an endpoint.

// 1) Reminder poller - fires due reminders every minute.
setInterval(async function() {
  try {
    const now = new Date();
    const reminders = await getPendingReminders();
    for (let i = 0; i < reminders.length; i++) {
      const reminder = reminders[i];
      if (now >= reminder.time) {
        try {
          await twilioClient.messages.create({
            body: "Hey " + reminder.name + " - don't forget: " + reminder.task,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: reminder.phone
          });
          await markReminderSent(reminder.id);
          console.log("Reminder sent: " + reminder.task);
        } catch (err) { console.error('Reminder failed:', err); }
      }
    }
  } catch (err) { console.error('Reminder check failed:', err); }
}, 60000);

// 2) Proactive check-ins - hourly. In a user's FIRST WEEK, Flow asks getting-to-
// know-you questions on any day (great for re-engaging quiet new signups). After
// that, it settles into 3 friendly check-ins a week (Mon/Wed/Fri). One per day,
// daytime only, opt-in, and never on top of an active conversation.
setInterval(async function() {
  try {
    const CHECKIN_DAYS = ['Mon', 'Wed', 'Fri']; // 3 times a week, steady state

    const snapshot = await db.collection('users')
      .where('onboarded', '==', true)
      .get();

    for (const doc of snapshot.docs) {
      const user = doc.data();
      const phone = doc.id;

      if (user.preferences && user.preferences.proactiveCheckins === false) continue;

      const wh = localWeekdayHour(tzForState(user.state));
      if (wh.hour < 7 || wh.hour >= 18) continue; // daytime only

      // At most one outreach per ~day (the hourly run would otherwise repeat).
      if (user.lastProactiveAt && (Date.now() - new Date(user.lastProactiveAt).getTime()) < 20 * 60 * 60 * 1000) continue;
      // Don't talk over an active conversation.
      if (user.lastMessageAt && (Date.now() - new Date(user.lastMessageAt).getTime()) < 3 * 60 * 60 * 1000) continue;

      let body = null;
      const upd = { lastProactiveAt: new Date().toISOString() };

      // ---- First week: getting-to-know-you question (any day) ----
      const inFirstWeek = user.signupAt &&
        (Date.now() - new Date(user.signupAt).getTime()) < 7 * 24 * 60 * 60 * 1000;
      if (inFirstWeek) {
        const q = nextFirstWeekQuestion(user);
        if (q) {
          body = (user.name ? ("Hey " + user.name + " - ") : "Hey - ") + q.text;
          const asked = Array.isArray(user.firstWeekAsked) ? user.firstWeekAsked.slice() : [];
          asked.push(q.key);
          upd.firstWeekAsked = asked;
        }
      }

      // ---- Steady state (or first week with nothing left to ask): Mon/Wed/Fri ----
      if (!body) {
        if (CHECKIN_DAYS.indexOf(wh.weekday) === -1) continue;

        let reason = '';
        let leadToChase = null;
        if (user.knowledge && Array.isArray(user.knowledge.leads)) {
          const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
          leadToChase = user.knowledge.leads.find(function(l) {
            return l && l.status !== 'closed' && (!l.lastAskedAt || new Date(l.lastAskedAt).getTime() < tenDaysAgo);
          });
        }

        if (leadToChase) {
          reason = "You mentioned " + leadToChase.label + " a while back - did that go anywhere? Happy to set a follow-up or close it off.";
          leadToChase.lastAskedAt = new Date().toISOString();
          upd.knowledge = user.knowledge; // persist the lead's lastAskedAt
        } else if (!user.knowledge || !user.knowledge.suppliers || user.knowledge.suppliers.length === 0) {
          reason = "Do you have any go-to suppliers I should know about? It helps me keep an eye on prices and remind you about orders.";
        } else if (!user.knowledge || !user.knowledge.team || user.knowledge.team.length === 0) {
          reason = "Is there anyone on your crew I should know about? I can keep track of who's doing what on each job.";
        } else {
          const nudges = [
            "Anything on the go I should know about? Happy to take notes, set reminders, or chase something up.",
            "How's the week shaping up? Sing out if there's a quote to follow, an order to place, or a reminder to set.",
            "Need me to lock in any reminders or keep tabs on a job today? Just flick me a message."
          ];
          reason = nudges[Math.floor(Math.random() * nudges.length)];
        }
        body = "Hey " + user.name + " - " + reason;
      }

      try {
        await twilioClient.messages.create({
          body: body,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone
        });
        await db.collection('users').doc(phone).update(upd);
        console.log("Proactive sent to: " + phone);
      } catch (err) { console.error("Proactive failed:", err); }
    }
  } catch (err) { console.error("Proactive scheduler error:", err); }
}, 60 * 60 * 1000);

// 3) Weekly power-tool specials - hourly check, fires Monday 7-10am local time,
// opt-in only, max once every 6 days, and ONLY when there's a real special to send.
setInterval(async function() {
  try {
    const snapshot = await db.collection('users')
      .where('onboarded', '==', true)
      .get();

    for (const doc of snapshot.docs) {
      const user = doc.data();
      const phone = doc.id;

      if (user.preferences && user.preferences.weeklySpecials === false) continue;

      const wh = localWeekdayHour(tzForState(user.state));
      if (wh.weekday !== 'Mon') continue;
      if (wh.hour < 7 || wh.hour >= 10) continue;
      if (user.lastSpecialsAt && (Date.now() - new Date(user.lastSpecialsAt).getTime()) < 6 * 24 * 60 * 60 * 1000) continue;

      const trade = user.trade || 'tradie';
      const region = user.state || 'Australia';
      const query = 'power tool specials sale this week ' + region + ' Australia Bunnings Total Tools Sydney Tools ' + trade;
      const results = await searchWeb(query);
      if (!results || /unavailable|no search results|could not (parse|decode)/i.test(results)) continue;

      // Flow decides whether anything is genuinely worth sending. He must not
      // invent prices, and replies NONE if there's no clear special - then we
      // stay silent (per the "never a generic ping" rule).
      let pick;
      try {
        const evalResp = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 160,
          messages: [
            { role: 'system', content:
              "You are Flow, an assistant for an Australian " + trade + ". From the web results below, find genuine current specials or sales on power tools that would matter to this trade. Pick the best one or two. Write a short SMS: name the retailer, the tool, the price ONLY if it is clearly stated in the results, and one line on why it's worth it. Australian spelling and dollars. Never invent, estimate, or round a price - only use figures clearly present in the results. Maximum three short sentences. If there is no clear, specific power-tool special in the results, reply with exactly NONE and nothing else." },
            { role: 'user', content: results }
          ]
        });
        pick = (evalResp.choices[0].message.content || '').trim();
      } catch (e) { console.error('Specials eval failed:', e); continue; }

      if (!pick || /^none\b/i.test(pick)) continue; // nothing worth saying -> stay silent

      const body = pick + "\n\n(Reply \"stop specials\" to switch these off.)";
      try {
        await twilioClient.messages.create({ body: body, from: process.env.TWILIO_PHONE_NUMBER, to: phone });
        await db.collection('users').doc(phone).update({ lastSpecialsAt: new Date().toISOString() });
        console.log("Specials sent to: " + phone);
      } catch (err) { console.error('Specials send failed:', err); }
    }
  } catch (err) { console.error('Specials scheduler error:', err); }
}, 60 * 60 * 1000);

// 4) Morning weather report - hourly check, fires in the 5-8am local window, once
// per day, opt-out via "stop weather". Funny weather-reporter style, with a next-day
// heads-up folded into the same message when tomorrow looks extreme.
setInterval(async function() {
  try {
    const snapshot = await db.collection('users')
      .where('onboarded', '==', true)
      .get();

    for (const doc of snapshot.docs) {
      const user = doc.data();
      const phone = doc.id;

      if (user.preferences && user.preferences.weatherReports === false) continue;

      const wh = localWeekdayHour(tzForState(user.state));
      if (wh.hour !== 4) continue; // 4am local, every day
      if (user.lastWeatherAt && (Date.now() - new Date(user.lastWeatherAt).getTime()) < 20 * 60 * 60 * 1000) continue;

      let result;
      try { result = await buildWeatherMessage(user); }
      catch (e) { console.error('Weather build failed:', e); continue; }
      if (!result || !result.body) continue;

      let body = result.body;
      if (!user.weatherIntroSent) {
        body += "\n\n(I'll send this each morning - reply \"stop weather\" to switch it off.)";
      }

      try {
        await twilioClient.messages.create({ body: body, from: process.env.TWILIO_PHONE_NUMBER, to: phone });
        const upd = { lastWeatherAt: new Date().toISOString(), weatherIntroSent: true };
        if (result.geo) upd.weatherGeo = result.geo; // cache the geocode lookup
        await db.collection('users').doc(phone).update(upd);
        console.log("Weather sent to: " + phone);
      } catch (err) { console.error('Weather send failed:', err); }
    }
  } catch (err) { console.error('Weather scheduler error:', err); }
}, 60 * 60 * 1000);

// 5) Evening extreme-weather heads-up - hourly check, fires ~8pm local, once a
// day, and ONLY when tomorrow is extreme (38C+ heat or 25mm+ rain). Shares the
// "stop weather" opt-out with the morning report.
setInterval(async function() {
  try {
    const snapshot = await db.collection('users')
      .where('onboarded', '==', true)
      .get();

    for (const doc of snapshot.docs) {
      const user = doc.data();
      const phone = doc.id;

      if (user.preferences && user.preferences.weatherReports === false) continue;

      const wh = localWeekdayHour(tzForState(user.state));
      if (wh.hour !== 20) continue; // 8pm local
      if (user.lastWeatherEveningAt && (Date.now() - new Date(user.lastWeatherEveningAt).getTime()) < 20 * 60 * 60 * 1000) continue;

      let result;
      try { result = await buildEveningAlert(user); }
      catch (e) { console.error('Evening alert build failed:', e); continue; }
      if (!result || !result.body) continue; // tomorrow's fine -> stay quiet

      try {
        await twilioClient.messages.create({ body: result.body, from: process.env.TWILIO_PHONE_NUMBER, to: phone });
        const upd = { lastWeatherEveningAt: new Date().toISOString() };
        if (result.geo) upd.weatherGeo = result.geo; // cache the geocode lookup
        await db.collection('users').doc(phone).update(upd);
        console.log("Evening weather alert sent to: " + phone);
      } catch (err) { console.error('Evening alert send failed:', err); }
    }
  } catch (err) { console.error('Evening alert scheduler error:', err); }
}, 60 * 60 * 1000);

// ============================ SMS WEBHOOK ============================

app.post('/sms', async function(req, res) {
  const twiml = new twilio.twiml.MessagingResponse();

  function reply() {
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }

  try {
    const userMessage = ((req.body && req.body.Body) || '').trim();
    const userPhone = (req.body && req.body.From) || '';

    console.log("Incoming from: " + userPhone + " message: " + userMessage);

    if (!userPhone) {
      twiml.message("Missing sender.");
      return reply();
    }

    // CRISIS SAFETY NET - runs before anything else. If the message contains
    // explicit self-harm language, skip normal processing and reply with support.
    // Logs the event WITHOUT the message content.
    if (looksLikeCrisis(userMessage)) {
      let nm = '';
      try { const u = await getUser(userPhone); nm = (u && u.name) ? ' ' + u.name : ''; } catch (e) {}
      twiml.message("I'm really glad you reached out" + nm + ". I'm only an assistant, so I can't give you the support you deserve right now - but people who can are there 24/7. Call Lifeline on 13 11 14, or 000 if you're in immediate danger. You can also reach Beyond Blue on 1300 22 4636. You don't have to carry this on your own.");
      try { await db.collection('crisis_events').add({ phone: userPhone, createdAt: admin.firestore.Timestamp.now() }); }
      catch (e) { console.error('Crisis log failed:', e); }
      return reply();
    }

    if (userMessage === '86753099') {
      await saveUser(userPhone, newUser());
      twiml.message("Profile reset. Text your access code to continue.");
      return reply();
    }

    if (userMessage.toUpperCase().startsWith('FLOWADMIN')) {
      if (userPhone !== ADMIN_PHONE) {
        twiml.message("Not authorised.");
        return reply();
      }
      const code = generateCode();
      await db.collection('access_codes').doc(code).set({
        code: code, used: false, createdAt: admin.firestore.Timestamp.now()
      });
      twiml.message("New access code: " + code + " - give this to your customer. It works once, from any phone.");
      return reply();
    }

    let user = await getUser(userPhone);
    backfillUser(user); // ensure preferences/knowledge/timestamps exist for older users

    // Record activity on every inbound message (feeds the proactive scheduler).
    user.lastMessageAt = new Date().toISOString();

    if (user.step === 'waitingCode' || user.step === 'welcome') {
      const entered = userMessage.trim();
      const codeDoc = await db.collection('access_codes').doc(entered).get();
      console.log("Code check - entered: " + entered + " exists: " + codeDoc.exists);

      if (codeDoc.exists && codeDoc.data().used !== true) {
        await db.collection('access_codes').doc(entered).update({
          used: true, usedBy: userPhone, usedAt: admin.firestore.Timestamp.now()
        });

        // Pull the builder's details that the website attached to this code.
        provisionFromProfile(user, codeDoc.data().profile);
        user.step = 'save_contact';
        await saveUser(userPhone, user);

        // One combined welcome + save-contact message, with Flow's photo attached.
        const contactMsg = twiml.message();
        contactMsg.body("You're in - I'm Flow, your SiteFlow assistant. I've already got your business details from signup. One last thing though: save this number as 'SiteFlow Assistant' and add my photo so I'm easy to find. Press the photo I've sent, hold it down and save it, then set it as my profile picture. Give me a shout when you're done.");
        if (FLOW_PHOTO_URL) { contactMsg.media(FLOW_PHOTO_URL); }
      } else if (codeDoc.exists) {
        twiml.message("That code's already been used. Reach out at siteflowassistant.com for a fresh one.");
      } else {
        twiml.message("To get started with Flow, text the access code you were given. If you don't have one yet, grab it from siteflowassistant.com.");
      }

      return reply();
    }

    // The only SMS onboarding step left: the builder replies after saving the
    // contact, and Flow finishes up. Their profile already came from the website.
    if (!user.onboarded) {
      user.onboarded = true;
      user.step = 'done';
      user.signupAt = new Date().toISOString(); // starts the first-week getting-to-know-you clock
      await saveUser(userPhone, user);
      const hi = user.name ? ("Thanks " + user.name + " - ") : "Thanks - ";
      twiml.message(hi + "that's everything sorted. I've got your back from here. Whenever something needs doing, just tell me and I'll keep you on track.");
      return reply();
    }

    // ===================== ONBOARDED USER =====================

    // Incoming photo (MMS)? Read it with vision and short-circuit here.
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    if (numMedia > 0) {
      const images = [];
      for (let i = 0; i < numMedia && images.length < 3; i++) {
        const ct   = req.body['MediaContentType' + i] || '';
        const murl = req.body['MediaUrl' + i];
        if (ct.startsWith('image/') && murl) images.push({ url: murl, contentType: ct });
      }

      if (images.length === 0) {
        twiml.message("I can read photos - quotes, dockets, invoices, defects, plans. That file type I can't open yet.");
        return reply();
      }

      try {
        const fetched = [];
        for (const img of images) fetched.push(await fetchTwilioMedia(img.url));

        const caption = userMessage || '';
        const visionSystem =
          "You are Flow, an AI assistant for Australian construction business owners. " +
          "The user has sent a photo. Identify what it is (quote, invoice, docket, " +
          "defect, plan) then pull out the key details: amounts in AUD, dates, " +
          "supplier or client names, job or PO numbers, line items, and anything due " +
          "or actionable. Be accurate - never invent figures you can't clearly read. " +
          "Keep it short and scannable for SMS. Australian spelling and dollars. " +
          "If the user's caption asks for a reminder with a time, add: " +
          "REMINDER: [task] | [time]";

        const content = [{ type: 'text', text: caption || "What is this and what are the key details?" }];
        for (const f of fetched) {
          content.push({ type: 'image_url', image_url: { url: 'data:' + f.contentType + ';base64,' + f.base64 } });
        }

        const visionResp = await openai.chat.completions.create({
          model: 'gpt-4o-mini', max_tokens: 350,
          messages: [{ role: 'system', content: visionSystem }, { role: 'user', content: content }]
        });

        let flowReply = (visionResp.choices[0].message.content || '').trim();

        const photoReminderRe = /REMINDER:\s*(.+?)\s*\|\s*(.+)/gi;
        let rm;
        while ((rm = photoReminderRe.exec(flowReply)) !== null) {
          const parsedTime = parseAuTime(rm[2].trim(), tzForState(user.state));
          if (parsedTime) await saveReminder({ phone: userPhone, name: user.name, task: rm[1].trim(), time: parsedTime });
        }
        flowReply = flowReply.replace(/^\s*REMINDER:.*$/gim, '').replace(/\n{2,}/g, '\n').trim();

        if (!flowReply) flowReply = "Got the photo but couldn't make it out - try a clearer shot.";

        if (!user.history) user.history = [];
        user.history.push({ role: 'user', content: '[Photo]' + (caption ? ': ' + caption : '') });
        user.history.push({ role: 'assistant', content: flowReply });
        if (user.history.length > 20) user.history = user.history.slice(-20);
        await saveUser(userPhone, user);

        twiml.message(flowReply);
      } catch (err) {
        console.error('Image handling failed:', err);
        twiml.message("Couldn't open that photo just now - give it another go in a sec.");
      }
      return reply();
    }

    // Timezone used for this user's reminder parsing and display.
    const userTz = tzForState(user.state);

    if (Array.isArray(user.pendingReminders) && user.pendingReminders.length > 0) {
      // let them bail out of the whole queue
      if (/^(cancel|stop|nevermind|never mind|forget it)\.?$/i.test(userMessage.trim())) {
        user.pendingReminders = [];
        await saveUser(userPhone, user);
        twiml.message("No worries - cleared that. What else can I do for you?");
        return reply();
      }

      const task = user.pendingReminders[0];
      const parsedTime = parseAuTime(userMessage, userTz);

      if (parsedTime) {
        await saveReminder({ phone: userPhone, name: user.name, task: task, time: parsedTime });
        user.pendingReminders = user.pendingReminders.slice(1); // pop the one we just set
        let msg = "Locked in. I'll remind you to " + task + " at " +
          parsedTime.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: userTz }) + ".";
        if (user.pendingReminders.length > 0) {
          msg += " And what time for \"" + user.pendingReminders[0] + "\"?";
        }
        await saveUser(userPhone, user);
        twiml.message(msg);
      } else {
        twiml.message("I didn't catch that time. What time exactly for \"" + task + "\"?");
      }

      return reply();
    }

    if (isProfileUpdate(userMessage)) {
      const lower = userMessage.toLowerCase();
      let updated = false;
      let updatedField = '';

      if (lower.includes('trade') || lower.includes('job')) {
        const match = userMessage.match(/(?:trade|job)\s+(?:is now|is|to|=)\s+(.+)/i);
        if (match) { user.trade = match[1].trim(); updated = true; updatedField = 'trade'; }
      }
      if (lower.includes('state')) {
        const match = userMessage.match(/state\s+(?:is now|is|to|=)\s+(.+)/i);
        if (match) { user.state = match[1].trim(); updated = true; updatedField = 'state'; }
      }
      if (lower.includes('area') || lower.includes('suburb') || lower.includes('location')) {
        const match = userMessage.match(/(?:area|suburb|location|work in)\s+(?:is now|is|to|are now|are|=|:)?\s*(.+)/i);
        if (match) { user.workAreas = match[1].trim(); updated = true; updatedField = 'work areas'; }
      }
      if (lower.includes('hours') || lower.includes('finish')) {
        const match = userMessage.match(/(?:hours|finish time|finish at|finish)\s+(?:is now|is|to|are now|are|=|:)?\s*(.+)/i);
        if (match) { user.workHours = match[1].trim(); user.finishTime = extractWorkHours(match[1].trim()); updated = true; updatedField = 'work hours'; }
      }
      if (lower.includes('supplier')) {
        const match = userMessage.match(/suppliers?\s+(?:is now|is|are now|are|to|=|:)?\s*(.+)/i);
        if (match) { user.suppliers = match[1].trim(); updated = true; updatedField = 'suppliers'; }
      }

      if (updated) {
        user.businessContext = buildBusinessContext(user);
        await saveUser(userPhone, user);
        twiml.message("Updated your " + updatedField + ".");
      } else {
        twiml.message("What would you like to update? You can change your trade, state, work areas, work hours, or suppliers.");
      }

      return reply();
    }

    // Feature on/off requests in plain language.
    if (isPreferenceUpdate(userMessage)) {
      const lower = userMessage.toLowerCase();
      const turnOff = /\b(stop|turn off|disable|no thanks)\b/.test(lower) || /don'?t send|do not send/.test(lower);

      let changed = '';
      if (/\bspecials?\b/.test(lower))                  { user.preferences.weeklySpecials   = !turnOff; changed = 'weekly specials'; }
      if (/\b(check[- ]?ins?|proactive)\b/.test(lower)) { user.preferences.proactiveCheckins = !turnOff; changed = 'check-ins'; }
      if (/\b(tenders?|alerts?)\b/.test(lower))         { user.preferences.tenderAlerts      = !turnOff; changed = 'tender alerts'; }
      if (/\bemployees?\b/.test(lower))                 { user.preferences.employeeSearch    = !turnOff; changed = 'employee search'; }
      if (/\b(weather|forecast)\b/.test(lower))         { user.preferences.weatherReports    = !turnOff; changed = 'morning weather reports'; }

      if (changed) {
        await saveUser(userPhone, user);
        twiml.message(turnOff
          ? "Done - I'll leave off the " + changed + " from now."
          : "Got it - I'll start sending you " + changed + ".");
        return reply();
      }
    }

    // "Connect my Xero" -> text back a one-time connect link.
    if (wantsXeroConnect(userMessage)) {
      if (!xeroConfigured()) {
        twiml.message("Xero isn't switched on yet at our end - hang tight, it's coming.");
        return reply();
      }
      const t = await createConnectToken(userPhone, 'xero');
      twiml.message("Connect your Xero here (takes about a minute): " + APP_BASE_URL + "/connect/xero?t=" + t + " - once it's done, just ask me how the money's looking.");
      return reply();
    }

    // Live money / invoice questions, answered from Xero.
    if (isMoneyQuery(userMessage)) {
      if (!user.integrations || !user.integrations.xero) {
        if (xeroConfigured()) {
          const t = await createConnectToken(userPhone, 'xero');
          twiml.message("I can pull that straight from your Xero once it's connected: " + APP_BASE_URL + "/connect/xero?t=" + t);
        } else {
          twiml.message("I can't see your books yet - Xero isn't connected.");
        }
        return reply();
      }
      try {
        const summary = await getXeroMoneySummary(userPhone, user);
        twiml.message(summary);
      } catch (err) {
        console.error('Xero money query failed:', err);
        twiml.message("Couldn't reach Xero just now - give it another go in a moment. If it keeps happening you may need to reconnect: text \"connect Xero\".");
      }
      return reply();
    }

    // "Any work going? / find me tenders" - public work + tender search.
    if (wantsLeadSearch(userMessage)) {
      try {
        const region = user.state || 'Australia';
        const trade = user.trade || 'construction';
        const area = user.workAreas ? (user.workAreas + ' ') : '';
        const q = trade + ' tenders contracts work available ' + area + region + ' Australia AusTender Tenderlink construction';
        const results = await searchWeb(q);
        if (!results || /unavailable|no search results|could not (parse|decode)/i.test(results)) {
          twiml.message("Couldn't turn up any open work right now - I'll keep an eye out. Want me to set a reminder to check again next week?");
          return reply();
        }
        const resp = await openai.chat.completions.create({
          model: 'gpt-4o-mini', max_tokens: 200,
          messages: [
            { role: 'system', content: "You are Flow, helping an Australian " + trade + " in " + region + " find work. From the web results, pull the most relevant open tenders or available jobs for this trade and area. List the best one or two: what it is, where, and the closing date if shown. Australian spelling. Max three short sentences. Be honest - if nothing in the results clearly fits, say you didn't find a solid match this time. Never invent listings or dates." },
            { role: 'user', content: results }
          ]
        });
        let pick = (resp.choices[0].message.content || '').trim();
        if (!pick) pick = "Nothing solid came up this time - I'll keep looking.";
        twiml.message(pick);
      } catch (err) {
        console.error('Lead search failed:', err);
        twiml.message("Couldn't run that search just now - give it another go in a sec.");
      }
      return reply();
    }

    // "Find me a labourer / write a job ad" - hiring helper (opt-in feature).
    if (wantsHiringHelp(userMessage) && !(user.preferences && user.preferences.employeeSearch === false)) {
      try {
        const region = user.state || 'Australia';
        const area = user.workAreas || region;
        const resp = await openai.chat.completions.create({
          model: 'gpt-4o-mini', max_tokens: 260,
          messages: [
            { role: 'system', content: "You are Flow, helping an Australian " + (user.trade || 'construction') + " business owner hire. From their message, work out the role they want. Write a short, ready-to-post job ad (4-6 lines: role, location " + area + ", what's involved, and 'text/call to apply'). Then on a new line add: 'Best spots to post: Seek, Gumtree, and your local trade Facebook groups.' Australian spelling and dollars. Keep it tight and practical. Don't invent a wage unless they gave one." },
            { role: 'user', content: userMessage }
          ]
        });
        let ad = (resp.choices[0].message.content || '').trim();
        if (!ad) ad = "Tell me the role and I'll draft you a job ad you can post.";
        twiml.message(ad);
      } catch (err) {
        console.error('Hiring helper failed:', err);
        twiml.message("Couldn't draft that just now - try me again in a moment.");
      }
      return reply();
    }

    // Vehicle logbook: "logbook"/"total km" summarises; "40km to the Geelong job" logs a trip.
    if (wantsLogbookSummary(userMessage)) {
      const log = Array.isArray(user.logbook) ? user.logbook : [];
      if (!log.length) {
        twiml.message("No trips logged yet. Just text me like \"40km to the Geelong job\" and I'll keep your logbook ticking over for tax time.");
        return reply();
      }
      const fy = sumLogbookFY(log, userTz);
      const month = sumLogbookSince(log, startOfMonthKey(userTz));
      twiml.message("Logbook so far:\n- This month: " + round1(month) + "km\n- This financial year: " + round1(fy) + "km\nAcross " + log.length + " trip(s) - handy come EOFY.");
      return reply();
    }

    const trip = parseLogbookEntry(userMessage);
    if (trip) {
      if (!Array.isArray(user.logbook)) user.logbook = [];
      user.logbook.push({ km: trip.km, dest: trip.dest || '', date: localDateKey(userTz), at: new Date().toISOString() });
      if (user.logbook.length > 2000) user.logbook = user.logbook.slice(-2000);
      await saveUser(userPhone, user);
      const fy = sumLogbookFY(user.logbook, userTz);
      twiml.message("Logged " + trip.km + "km" + (trip.dest ? (" to " + trip.dest) : "") + ". You're at " + round1(fy) + "km for the financial year so far.");
      return reply();
    }

    // "How much concrete for that slab?" - parse dimensions, do the takeoff.
    if (wantsTakeoff(userMessage)) {
      try {
        const parseResp = await openai.chat.completions.create({
          model: 'gpt-4o-mini', max_tokens: 200,
          messages: [
            { role: 'system', content: "Extract a building-materials takeoff request into JSON ONLY - no prose, no backticks. Convert every length to METRES (100mm thick => 0.1, 450mm => 0.45, 6 => 6). If a number has no unit, assume metres. Schema: {\"material\":\"concrete|tiles|paint|decking|area|unknown\",\"length\":number|null,\"width\":number|null,\"depth\":number|null,\"height\":number|null,\"tile_w_mm\":number|null,\"tile_h_mm\":number|null,\"coats\":number|null,\"board_w_mm\":number|null,\"gap_mm\":number|null,\"coverage_m2_per_l\":number|null}. A 'slab' is concrete with depth = its thickness. Painting a wall uses height for wall height. Use null for anything not stated. If you can't tell the material, set material to \"unknown\"." },
            { role: 'user', content: userMessage }
          ]
        });
        let spec = null;
        try { spec = JSON.parse((parseResp.choices[0].message.content || '').replace(/```json|```/g, '').trim()); } catch (e) { spec = null; }
        const out = spec ? computeTakeoff(spec) : null;
        if (!out) {
          twiml.message("Give me the shape and I'll size it up - e.g. \"concrete for a 6x4 slab, 100mm thick\", \"tiles for a 4x3 room, 300x300\", or \"paint for a 5m x 2.4m wall, 2 coats\".");
          return reply();
        }
        twiml.message(out);
      } catch (err) {
        console.error('Takeoff failed:', err);
        twiml.message("Couldn't work that one out just now - give it another go with the dimensions (length, width, and thickness).");
      }
      return reply();
    }

    // "Cheapest 90/45 near me" - search the web and send a few buying links.
    if (wantsPriceCheck(userMessage)) {
      try {
        const product = extractProductQuery(userMessage) || userMessage;
        const area = user.workAreas || user.state || 'Australia';
        const links = await searchWebLinks(product + ' price buy ' + area + ' Australia');
        if (!links || !links.length) {
          twiml.message("Couldn't pull up prices for that just now - give it another go in a sec, or tell me a bit more (size, material, your suburb).");
          return reply();
        }
        const resultsText = links.map(function (r, i) {
          return (i + 1) + '. ' + r.title + ' | ' + r.url + (r.description ? (' | ' + r.description) : '');
        }).join('\n');
        const resp = await openai.chat.completions.create({
          model: 'gpt-4o-mini', max_tokens: 280,
          messages: [
            { role: 'system', content: "You are Flow, helping an Australian tradie find the cheapest place to buy a building material or product near " + area + ". From the web results below (each line is: number. title | url | description), pick the 2-3 best BUYING options - favour retailers/suppliers that actually sell the item. For each, write ONE line: retailer or product name, the price ONLY if it is clearly stated in the result, then the link on the same line. Put the cheapest first when prices are shown. Australian spelling and dollars. NEVER invent, estimate, or round a price - only use figures clearly present in the results; if a result has no price, just give the name and link. Keep it short and texty. If none look like genuine buying options, say you couldn't find solid pricing and ask them to add detail (size, material, suburb). Do not add labels, tags, or a sign-off." },
            { role: 'user', content: 'They asked: ' + userMessage + '\nProduct: ' + product + '\n\nResults:\n' + resultsText }
          ]
        });
        let pick = (resp.choices[0].message.content || '').trim();
        if (!pick) pick = "Couldn't find solid pricing on that one - give me a touch more detail (size, material, your suburb) and I'll have another crack.";
        twiml.message(pick);
      } catch (err) {
        console.error('Price check failed:', err);
        twiml.message("Couldn't run that price search just now - give it another go in a moment.");
      }
      return reply();
    }

    // Capture a plan for today ("plan for today: ...")
    const todaysPlanText = parseTodaysPlan(userMessage);
    if (todaysPlanText) {
      user.todaysPlan = { text: todaysPlanText, date: localDateKey(userTz) };
      await saveUser(userPhone, user);
      twiml.message("Got your plan for today locked in. Ask me for a briefing anytime and I'll run it back with your reminders and anything on the go.");
      return reply();
    }

    // Morning briefing on demand
    if (wantsBriefing(userMessage)) {
      const brief = await buildBriefing(user, userPhone, userTz);
      twiml.message(brief || ("All clear " + (user.name || 'mate') + " - nothing on my radar today. Tell me what's on and I'll keep you on track."));
      return reply();
    }

    // "Show my reminders"
    if (wantsReminderList(userMessage)) {
      const ups = await getUpcomingReminders(userPhone);
      if (ups.length === 0) {
        twiml.message("You've got no reminders set right now. Just tell me what to remember and when.");
        return reply();
      }
      const lines = ups.slice(0, 8).map(function(r, i) {
        return (i + 1) + ". " + r.task + " - " +
          r.time.toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: userTz });
      });
      let msg = "Your reminders:\n" + lines.join('\n');
      if (ups.length > 8) msg += "\n(+" + (ups.length - 8) + " more)";
      msg += "\nSay e.g. \"cancel the " + ups[0].task + "\" to clear one.";
      twiml.message(msg);
      return reply();
    }

    // "Cancel a reminder"
    if (wantsCancelReminder(userMessage)) {
      const ups = await getUpcomingReminders(userPhone);
      if (ups.length === 0) { twiml.message("You've got no reminders to cancel."); return reply(); }

      const lowerC = userMessage.toLowerCase();
      if (/\b(all|everything)\b/.test(lowerC)) {
        for (const r of ups) await deleteReminder(r.id);
        twiml.message("Cleared all " + ups.length + " reminders.");
        return reply();
      }

      // match the leftover words against the reminder text
      const q = lowerC
        .replace(/\b(cancel|delete|remove|clear|scrap|drop|the|my|reminder|reminders|to|forget|about|for)\b/g, ' ')
        .replace(/\s+/g, ' ').trim();
      const target = q ? ups.find(function(r) { return r.task.toLowerCase().includes(q); }) : null;

      if (!target) {
        const lines = ups.slice(0, 8).map(function(r) { return "- " + r.task; });
        twiml.message("Which one? You've got:\n" + lines.join('\n') + "\nTell me a few words from the one to cancel.");
        return reply();
      }
      await deleteReminder(target.id);
      twiml.message("Done - cancelled the reminder to " + target.task + ".");
      return reply();
    }

    const reminderKeywords = ['remind me', 'reminder', "don't let me forget", 'make sure i'];
    const hasReminder = reminderKeywords.some(function(k) { return userMessage.toLowerCase().includes(k); });

    if (hasReminder && isVagueTime(userMessage)) {
      const taskMatch = userMessage.match(/remind(?:er)?\s+(?:me\s+)?(?:to\s+)?(.+?)(?:\s+in the morning|\s+after work|\s+at night|\s+tonight|\s+this evening|\s+at lunch|\s+lunchtime|\s+first thing|\s+later|\s+sometime)/i);
      const task = taskMatch ? taskMatch[1].trim() : userMessage;
      if (!Array.isArray(user.pendingReminders)) user.pendingReminders = [];
      user.pendingReminders.push(task);
      await saveUser(userPhone, user);
      twiml.message("What time exactly for \"" + task + "\"?");
      return reply();
    }

    if (!user.history) user.history = [];
    user.history.push({ role: 'user', content: userMessage });
    if (user.history.length > 20) { user.history = user.history.slice(-20); }

    // Keyword match instead of an OpenAI classifier call (halves per-message cost).
    const shouldSearch = SEARCH_KEYWORDS.some(function(k) {
      return userMessage.toLowerCase().includes(k);
    });

    let searchContext = '';

    if (shouldSearch) {
      const weatherKeywords = ['weather', 'rain', 'temperature', 'forecast', 'hot', 'cold', 'wind'];
      const isWeather = weatherKeywords.some(function(w) { return userMessage.toLowerCase().includes(w); });
      const searchQuery = isWeather ? 'weather forecast ' + user.workAreas + ' ' + user.state + ' Australia today' : userMessage + ' Australia';
      console.log('Searching: ' + searchQuery);
      const searchResults = await searchWeb(searchQuery);
      searchContext = '\n\nSEARCH RESULTS - you must use these to answer:\n' + searchResults;
    }

    const teamContext = user.teamMembers && user.teamMembers.length > 0 ? '\nTeam members: ' + JSON.stringify(user.teamMembers) : '';

    // Feed everything Flow has learned back into his context.
    const knowledgeContext = user.knowledge ?
      "\nKnown team: " + JSON.stringify(user.knowledge.team) +
      "\nKnown suppliers: " + JSON.stringify(user.knowledge.suppliers) +
      "\nKnown clients: " + JSON.stringify(user.knowledge.clients) +
      "\nBusiness notes: " + JSON.stringify(user.knowledge.notes) +
      "\nOpen leads/jobs to chase: " + JSON.stringify(user.knowledge.leads || []) : '';

    const xeroConnected = !!(user.integrations && user.integrations.xero);
    const integrationsContext = xeroConnected
      ? "\nThis user has connected Xero. You CAN see their invoices and money owed - if they ask about cash, invoices, or who owes them, that is handled live elsewhere, so just answer naturally and never say you can't access their accounts."
      : "\nThis user has NOT connected Xero yet. If they ask about invoices or money owed, tell them you can pull it from Xero once it's connected and that they can text 'connect Xero' to set it up.";

    const systemPrompt = "You are Flow, an AI assistant built specifically for Australian construction business owners.\n\nVOICE:\n- Talk like a real person - warm, easy and natural, the way a sharp offsider would text. Professional, but never robotic, formal, or full of corporate fluff.\n- Vary how you reply. Never lean on the same stock phrase, and always put things in your own words. Acknowledge what they actually said.\n- Keep replies short and texty by default - a sentence or two. Use a little more room only when you genuinely need to ask something or explain.\n- Never mention ChatGPT or OpenAI. Always refer to yourself as Flow.\n- Never say you cannot access the internet.\n- Australian spelling and dollars.\n- Always use the user's work areas and state for location based questions.\n- You know their regular suppliers and their biggest admin headache. Reference suppliers by name when ordering or prices come up, and look for natural chances to ease that admin pain.\n\nGETTING TASKS RIGHT (this is critical - getting it exactly right matters far more than being quick):\n- Before you act on ANY task, make sure you have every detail you'd need to do it exactly the way they want. If there's any meaningful uncertainty, anything missing, or anything that could be done more than one way, ASK before you do it. When in doubt, ask - it is always better to ask one more question than to get it wrong or only half right.\n- Don't assume, and don't fill gaps with your best guess. The only things you can take as given are details they've already told you or that are in their profile.\n- Ask EVERY question you need to nail the task - but group them all into ONE message so they can answer in one go. Never drip-feed questions one at a time across several texts.\n- For example: a reminder needs the exact time, the date if it isn't today, and who it involves; chasing a quote needs which job, who the client is, the amount, and the tone or wording they want; a job ad needs the role, area, pay, hours, start date, and how to apply; placing or chasing an order needs the item, quantity, supplier, and when it's needed by.\n- After they answer, read the key details back in plain English and only then do the task - so they get the chance to correct you before it's done.\n- ALWAYS reply with a real, human sentence. Never reply with only hidden tags - even when you're just noting something down, say something natural back.\n\nWhen search results are provided you MUST use them.\n\nFor each reminder with a clear time, confirm briefly then add it on its OWN new line: REMINDER: [task] | [time]. If they ask for several reminders in one message, output a separate REMINDER: line for every one.\n\nIf the user asks for something you genuinely cannot do, respond warmly in one or two sentences, tell them it is not a current feature, then add on its OWN new line exactly:\nFEATURE_REQUEST: [what they asked for]\n\nAs you chat, quietly learn about the business. When you learn something genuinely new (not already listed below), add it on its OWN new line at the very end of your reply using these tags - do not repeat a tag for something already known:\nLEARN_TEAM: [name] | [role]\nLEARN_SUPPLIER: [name] | [category]\nLEARN_CLIENT: [name] | [notes]\nLEARN_NOTE: [fact]\nLEARN_LEAD: [job or client] | [detail]\nUse LEARN_LEAD when they mention a possible job, enquiry, or quote that hasn't been won yet (e.g. someone asked them to price a job). Also: when they tell you their name or what to call them, add on its own line LEARN_NAME: [name]. These tags are stripped before the user sees the message, so keep them off the lines the user reads.\n\nWhen the user mentions a person's name you don't recognise from the team list, after completing their request ask: 'Is [name] part of your team? I can keep track of them for you.'\n\nUser profile: " + user.businessContext + teamContext + knowledgeContext + integrationsContext + "\nName: " + user.name + "\nState: " + user.state + "\nWork areas: " + user.workAreas + "\nWork hours: " + user.workHours + "\nFinish time: " + user.finishTime + "\nRegular suppliers: " + user.suppliers + "\nBiggest admin headache: " + user.adminHeadache + "\nLocal time: " + new Date().toLocaleString('en-AU', { timeZone: userTz }) + searchContext;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }].concat(user.history),
      max_tokens: 250
    });

    let flowReply = (response.choices[0].message.content || '').trim();

    // --- REMINDER side-effects: save EVERY reminder Flow emitted (tag lines are
    // stripped in the line pass below). Global regex => multiple reminders in one
    // message all get created, not just the first. ---
    const reminderRe = /REMINDER:\s*(.+?)\s*\|\s*(.+)/gi;
    let reminderMatch;
    while ((reminderMatch = reminderRe.exec(flowReply)) !== null) {
      const task = reminderMatch[1].trim();
      const timeText = reminderMatch[2].trim();
      const parsedTime = parseAuTime(timeText, userTz);
      if (parsedTime) {
        await saveReminder({ phone: userPhone, name: user.name, task: task, time: parsedTime });
        console.log("Reminder saved: " + task + " for " + parsedTime);
      }
    }

    // --- FEATURE_REQUEST side-effect ---
    const featureMatch = flowReply.match(/FEATURE_REQUEST:\s*(.+)/);
    if (featureMatch) {
      try { await logFeatureRequest(userPhone, user.trade, featureMatch[1].trim()); }
      catch (e) { console.error('Feature request log failed:', e); }
    }

    // --- Apply LEARN_ tags AND strip every control tag, in one line-based pass.
    // Line-based (not a global-regex while-loop) so multiple tags and any stray
    // REMINDER/FEATURE_REQUEST lines are handled without skipping.
    const keptLines = [];
    const replyLines = flowReply.split('\n');
    for (let li = 0; li < replyLines.length; li++) {
      const line = replyLines[li];
      const t = line.trim();
      let m;
      if (/^REMINDER:/i.test(t) || /^FEATURE_REQUEST:/i.test(t)) {
        continue; // already handled above
      } else if ((m = t.match(/^LEARN_TEAM:\s*(.+)/i))) {
        const parts = m[1].split('|').map(function(s) { return s.trim(); });
        const name = parts[0], role = parts[1];
        if (name && !user.knowledge.team.find(function(x) { return x.name === name; })) {
          user.knowledge.team.push({ name: name, role: role || '', addedAt: new Date().toISOString() });
        }
      } else if ((m = t.match(/^LEARN_SUPPLIER:\s*(.+)/i))) {
        const parts = m[1].split('|').map(function(s) { return s.trim(); });
        const name = parts[0], category = parts[1];
        if (name && !user.knowledge.suppliers.find(function(x) { return x.name === name; })) {
          user.knowledge.suppliers.push({ name: name, category: category || '', addedAt: new Date().toISOString() });
        }
      } else if ((m = t.match(/^LEARN_CLIENT:\s*(.+)/i))) {
        const parts = m[1].split('|').map(function(s) { return s.trim(); });
        const name = parts[0], notes = parts[1];
        if (name && !user.knowledge.clients.find(function(x) { return x.name === name; })) {
          user.knowledge.clients.push({ name: name, notes: notes || '', addedAt: new Date().toISOString() });
        }
      } else if ((m = t.match(/^LEARN_NOTE:\s*(.+)/i))) {
        const fact = m[1].trim();
        if (fact && user.knowledge.notes.indexOf(fact) === -1) {
          user.knowledge.notes.push(fact);
        }
      } else if ((m = t.match(/^LEARN_NAME:\s*(.+)/i))) {
        const nm = m[1].trim().replace(/[.!,]+$/, '');
        if (nm && nm.length <= 40) {
          user.name = nm;
          user.businessContext = buildBusinessContext(user);
        }
      } else if ((m = t.match(/^LEARN_LEAD:\s*(.+)/i))) {
        const parts = m[1].split('|').map(function(s) { return s.trim(); });
        const label = parts[0], detail = parts[1];
        if (!Array.isArray(user.knowledge.leads)) user.knowledge.leads = [];
        if (label && !user.knowledge.leads.find(function(x) { return x.label === label; })) {
          user.knowledge.leads.push({ label: label, detail: detail || '', status: 'open', addedAt: new Date().toISOString(), lastAskedAt: null });
        }
      } else {
        keptLines.push(line);
      }
    }
    flowReply = keptLines.join('\n').trim();

    if (!flowReply) {
      const acks = ["Got it.", "No worries, sorted.", "Onto it.", "Righto, done.", "All good - got that.", "Easy, locked in."];
      flowReply = acks[Math.floor(Math.random() * acks.length)];
    }

    user.history.push({ role: 'assistant', content: flowReply });
    await saveUser(userPhone, user);
    twiml.message(flowReply);

    return reply();

  } catch (err) {
    console.error('Unhandled /sms error:', err);
    if (!res.headersSent) {
      const t = new twilio.twiml.MessagingResponse();
      t.message("Flow hit a snag - send that last message again in a moment.");
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(t.toString());
    }
  }
});

// ---- Xero OAuth: connect + callback ----------------------------------------

// Step 1: the builder taps the link Flow texted (carries a one-time token `t`).
// We validate it, remember which phone it belongs to, and bounce them to Xero.
app.get('/connect/xero', async function(req, res) {
  try {
    if (!xeroConfigured()) { res.status(500).send('Xero is not configured on the server yet.'); return; }
    const t = (req.query.t || '').toString();
    const tokenDoc = t ? await db.collection('connect_tokens').doc(t).get() : null;
    if (!tokenDoc || !tokenDoc.exists || tokenDoc.data().used === true || tokenDoc.data().provider !== 'xero') {
      res.status(400).send('This connect link is invalid or has expired. Text Flow "connect Xero" for a fresh one.');
      return;
    }
    const authUrl = 'https://login.xero.com/identity/connect/authorize'
      + '?response_type=code'
      + '&client_id=' + encodeURIComponent(XERO_CLIENT_ID)
      + '&redirect_uri=' + encodeURIComponent(XERO_REDIRECT_URI)
      + '&scope=' + encodeURIComponent(XERO_SCOPES)
      + '&state=' + encodeURIComponent(t);
    res.redirect(authUrl);
  } catch (err) {
    console.error('connect/xero error:', err);
    res.status(500).send('Something went wrong starting the Xero connection.');
  }
});

// Step 2: Xero redirects back with a code. Exchange it, grab the tenant, store
// the tokens on the user, and show a simple done page.
app.get('/callback/xero', async function(req, res) {
  try {
    const code = (req.query.code || '').toString();
    const state = (req.query.state || '').toString();
    if (!code || !state) { res.status(400).send('Missing authorisation details from Xero.'); return; }

    const tokenDoc = await db.collection('connect_tokens').doc(state).get();
    if (!tokenDoc.exists || tokenDoc.data().used === true) {
      res.status(400).send('This connection link has already been used. Text Flow "connect Xero" to try again.');
      return;
    }
    const phone = tokenDoc.data().phone;

    // Exchange the code for tokens.
    const tok = await xeroTokenRequest({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: XERO_REDIRECT_URI
    });

    // Find which Xero organisation (tenant) was authorised.
    const connResp = await fetch('https://api.xero.com/connections', {
      headers: { 'Authorization': 'Bearer ' + tok.access_token, 'Accept': 'application/json' }
    });
    const connections = await connResp.json();
    const first = Array.isArray(connections) && connections.length > 0 ? connections[0] : null;
    if (!first) { res.status(400).send('No Xero organisation came back from the connection. Please try again.'); return; }

    const user = await getUser(phone);
    backfillUser(user);
    user.integrations.xero = {
      tenantId: first.tenantId,
      tenantName: first.tenantName || '',
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: Date.now() + (tok.expires_in || 1800) * 1000,
      connectedAt: new Date().toISOString()
    };
    await saveUser(phone, user);
    await db.collection('connect_tokens').doc(state).update({ used: true, usedAt: admin.firestore.Timestamp.now() });

    // Let the builder know over SMS too.
    try {
      await twilioClient.messages.create({
        body: "Xero's connected" + (user.name ? ", " + user.name : "") + ". Ask me anything like \"how's the money looking?\" and I'll pull it live.",
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone
      });
    } catch (e) { console.error('Xero connect SMS failed:', e); }

    res.set('Content-Type', 'text/html');
    res.send('<html><body style="font-family:system-ui;text-align:center;padding:48px">' +
      '<h2>Xero connected \u2714</h2><p>You can close this and head back to your texts with Flow.</p></body></html>');
  } catch (err) {
    console.error('callback/xero error:', err);
    res.status(500).send('Could not finish connecting Xero. Please try the link again.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Flow is live on port " + PORT);
});
