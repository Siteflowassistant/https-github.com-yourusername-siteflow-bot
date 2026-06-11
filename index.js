const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const chrono = require('chrono-node');
const https = require('https');
const zlib = require('zlib');
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

// Onboarding questions, asked in order. Each answer is stored and fed into Flow's
// context so he can actually use it (that's what sets him apart from generic AI).
const QUESTIONS = [
  "What's your trade? Builder, carpenter, electrician, plumber, landscaper, roofer - whatever you're known for on site.",
  "Which state are you based in?",
  "Where do you mainly work - particular suburbs, the CBD, regional, a few towns?",
  "What are your usual work hours and days? Something like 'Mon to Fri, 7 to 5' is all I need.",
  "Who are your go-to suppliers? Your timber yard, electrical wholesaler, hire place - whoever you order from regularly.",
  "What's the bit of admin that bites you most - chasing invoices, ordering materials, following up quotes, or booking inspections?"
];

function newUser() {
  return {
    name: '', trade: '', state: '', workAreas: '', workHours: '', finishTime: '',
    suppliers: '', adminHeadache: '',
    businessContext: '', onboarded: false,
    step: 'waitingCode',
    pendingReminderTask: '', history: [],
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
      notes:     []
    },
    // Timestamps used by the proactive + specials schedulers.
    lastMessageAt: null,
    lastProactiveAt: null,
    lastSpecialsAt: null
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
  const feature = /\b(specials?|check[- ]?ins?|proactive|tenders?|alerts?|employees?)\b/.test(lower);
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
    user.knowledge = { team: [], suppliers: [], clients: [], notes: [] };
  }
  if (typeof user.lastMessageAt === 'undefined') user.lastMessageAt = null;
  if (typeof user.lastProactiveAt === 'undefined') user.lastProactiveAt = null;
  if (typeof user.lastSpecialsAt === 'undefined') user.lastSpecialsAt = null;
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

// Log anything Flow can't do yet so the team can see what people are asking for.
async function logFeatureRequest(phone, trade, request) {
  await db.collection('feature_requests').add({
    phone: phone,
    trade: trade || 'unknown',
    request: request,
    createdAt: admin.firestore.Timestamp.now()
  });
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

// 2) Proactive check-ins - hourly. Only reaches out when there's a genuine
// reason and only in daytime, max once per 5 days, and only if opted in.
setInterval(async function() {
  try {
    const now = new Date();
    const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000);
    const oneWeekAgo  = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const snapshot = await db.collection('users')
      .where('onboarded', '==', true)
      .get();

    for (const doc of snapshot.docs) {
      const user = doc.data();
      const phone = doc.id;

      if (!user.lastMessageAt) continue;
      if (new Date(user.lastMessageAt) > fiveDaysAgo) continue;
      if (user.lastProactiveAt && new Date(user.lastProactiveAt) > oneWeekAgo) continue;
      if (user.preferences && user.preferences.proactiveCheckins === false) continue;

      const wh = localWeekdayHour(tzForState(user.state));
      if (wh.hour < 7 || wh.hour >= 18) continue;

      // Reason to reach out, based on what Flow does / doesn't know yet.
      let reason = '';
      if (!user.knowledge || !user.knowledge.suppliers || user.knowledge.suppliers.length === 0) {
        reason = "Do you have any go-to suppliers I should know about? It helps me keep an eye on prices and remind you about orders.";
      } else if (!user.knowledge || !user.knowledge.team || user.knowledge.team.length === 0) {
        reason = "Is there anyone on your crew I should know about? I can keep track of who's doing what on each job.";
      } else {
        reason = "Anything on the go this week I should know about? Happy to take notes, set reminders, or just keep things moving.";
      }

      try {
        await twilioClient.messages.create({
          body: "Hey " + user.name + " - " + reason,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone
        });
        await db.collection('users').doc(phone).update({ lastProactiveAt: new Date().toISOString() });
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
        user.step = 'onboarding_1';
        await saveUser(userPhone, user);
        twiml.message("You're in. I'm Flow - your SiteFlow AI assistant built for construction. Think of me as the team member who remembers everything so you don't have to. A few quick questions so I get to know your business, then I'm ready to go. First up: what should I call you?");
      } else if (codeDoc.exists) {
        twiml.message("That code's already been used. Reach out at siteflowassistant.com for a fresh one.");
      } else {
        twiml.message("To get started with Flow, text the access code you were given. If you don't have one yet, grab it from siteflowassistant.com.");
      }

      return reply();
    }

    if (!user.onboarded) {
      const step = user.step;
      console.log("Onboarding step: " + step);

      if (step === 'onboarding_1') { user.name = userMessage; user.step = 'onboarding_2'; }
      else if (step === 'onboarding_2') { user.trade = userMessage; user.step = 'onboarding_3'; }
      else if (step === 'onboarding_3') { user.state = userMessage; user.step = 'onboarding_4'; }
      else if (step === 'onboarding_4') { user.workAreas = userMessage; user.step = 'onboarding_5'; }
      else if (step === 'onboarding_5') { user.workHours = userMessage; user.finishTime = extractWorkHours(userMessage); user.step = 'onboarding_6'; }
      else if (step === 'onboarding_6') { user.suppliers = userMessage; user.step = 'onboarding_7'; }
      else if (step === 'onboarding_7') {
        user.adminHeadache = userMessage;
        user.businessContext = buildBusinessContext(user);
        user.step = 'onboarding_8';
        await saveUser(userPhone, user);

        // Send the "save my photo" message WITH Flow's picture attached.
        const contactMsg = twiml.message();
        contactMsg.body("Nice one. One last thing before we start: save this number as 'SiteFlow' so I'm easy to find, and add my photo if you like. Let me know when you're done.");
        if (FLOW_PHOTO_URL) { contactMsg.media(FLOW_PHOTO_URL); }

        return reply();
      } else if (step === 'onboarding_8') {
        user.onboarded = true;
        user.step = 'done';
        await saveUser(userPhone, user);
        twiml.message("Thanks " + user.name + " - that's everything I need. I've got your back from here. Whenever something needs doing, just tell me and I'll keep you on track.");
        return reply();
      }

      await saveUser(userPhone, user);
      const stepNum = parseInt(step.split('_')[1]);
      twiml.message(QUESTIONS[stepNum - 1]);
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

        const rm = flowReply.match(/REMINDER:\s*(.+?)\s*\|\s*(.+)/);
        if (rm) {
          const parsedTime = parseAuTime(rm[2].trim(), tzForState(user.state));
          if (parsedTime) await saveReminder({ phone: userPhone, name: user.name, task: rm[1].trim(), time: parsedTime });
          flowReply = flowReply.replace(/\nREMINDER:.*$/m, '').trim();
        }

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

    if (user.pendingReminderTask && user.pendingReminderTask !== '') {
      const task = user.pendingReminderTask;
      user.pendingReminderTask = '';
      await saveUser(userPhone, user);
      const parsedTime = parseAuTime(userMessage, userTz);

      if (parsedTime) {
        await saveReminder({ phone: userPhone, name: user.name, task: task, time: parsedTime });
        twiml.message("Locked in. I'll remind you to " + task + " at " + parsedTime.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: userTz }) + ".");
      } else {
        user.pendingReminderTask = task;
        await saveUser(userPhone, user);
        twiml.message("I didn't catch that time. What time exactly?");
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

      if (changed) {
        await saveUser(userPhone, user);
        twiml.message(turnOff
          ? "Done - I'll leave off the " + changed + " from now."
          : "Got it - I'll start sending you " + changed + ".");
        return reply();
      }
    }

    const reminderKeywords = ['remind me', 'reminder', "don't let me forget", 'make sure i'];
    const hasReminder = reminderKeywords.some(function(k) { return userMessage.toLowerCase().includes(k); });

    if (hasReminder && isVagueTime(userMessage)) {
      const taskMatch = userMessage.match(/remind(?:er)?\s+(?:me\s+)?(?:to\s+)?(.+?)(?:\s+in the morning|\s+after work|\s+at night|\s+tonight|\s+this evening|\s+at lunch|\s+lunchtime|\s+first thing|\s+later|\s+sometime)/i);
      const task = taskMatch ? taskMatch[1].trim() : userMessage;
      user.pendingReminderTask = task;
      await saveUser(userPhone, user);
      twiml.message("What time exactly?");
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
      "\nBusiness notes: " + JSON.stringify(user.knowledge.notes) : '';

    const systemPrompt = "You are Flow, an AI assistant built specifically for Australian construction business owners.\n\nRULES:\n- Professional and direct - no fluff\n- Never say you cannot access the internet\n- Never offer further help at the end of a message\n- Never end with a question unless you genuinely need information\n- Never mention ChatGPT or OpenAI\n- Always refer to yourself as Flow\n- Maximum three sentences per reply\n- Australian spelling and dollars\n- Always use the user's work areas and state for location based questions\n- You know their regular suppliers and their biggest admin headache. Reference suppliers by name when ordering or prices come up, and look for natural chances to help with that admin pain.\n\nWhen search results are provided you MUST use them.\n\nFor reminders with a clear time confirm in one sentence then add: REMINDER: [task] | [time]\n\nIf the user asks for something you genuinely cannot do, respond warmly in one or two sentences, tell them it is not a current feature, then add on its OWN new line exactly:\nFEATURE_REQUEST: [what they asked for]\n\nAs you chat, quietly learn about the business. When you learn something genuinely new (not already listed below), add it on its OWN new line at the very end of your reply using these tags - do not repeat a tag for something already known:\nLEARN_TEAM: [name] | [role]\nLEARN_SUPPLIER: [name] | [category]\nLEARN_CLIENT: [name] | [notes]\nLEARN_NOTE: [fact]\nThese tags are stripped before the user sees the message, so keep them off the lines the user reads.\n\nWhen the user mentions a person's name you don't recognise from the team list, after completing their request ask: 'Is [name] part of your team? I can keep track of them for you.'\n\nUser profile: " + user.businessContext + teamContext + knowledgeContext + "\nName: " + user.name + "\nState: " + user.state + "\nWork areas: " + user.workAreas + "\nWork hours: " + user.workHours + "\nFinish time: " + user.finishTime + "\nRegular suppliers: " + user.suppliers + "\nBiggest admin headache: " + user.adminHeadache + "\nLocal time: " + new Date().toLocaleString('en-AU', { timeZone: userTz }) + searchContext;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }].concat(user.history),
      max_tokens: 250
    });

    let flowReply = (response.choices[0].message.content || '').trim();

    // --- REMINDER side-effect (the tag line is stripped in the pass below) ---
    const reminderMatch = flowReply.match(/REMINDER:\s*(.+?)\s*\|\s*(.+)/);
    if (reminderMatch) {
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
      } else {
        keptLines.push(line);
      }
    }
    flowReply = keptLines.join('\n').trim();

    if (!flowReply) flowReply = "Righto - got that.";

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Flow is live on port " + PORT);
});
