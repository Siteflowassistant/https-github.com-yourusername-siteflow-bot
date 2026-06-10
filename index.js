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

// Onboarding questions, asked in order. Each answer is stored and fed into Flow's
// context so he can actually use it (that's what sets him apart from generic AI).
const QUESTIONS = [
  "What's your trade? Builder, carpenter, electrician, plumber, landscaper, roofer — whatever you're known for on site.",
  "Which state are you based in?",
  "Where do you mainly work — particular suburbs, the CBD, regional, a few towns?",
  "What are your usual work hours and days? Something like 'Mon to Fri, 7 to 5' is all I need.",
  "Who are your go-to suppliers? Your timber yard, electrical wholesaler, hire place — whoever you order from regularly.",
  "What's the bit of admin that bites you most — chasing invoices, ordering materials, following up quotes, or booking inspections?"
];

function newUser() {
  return {
    name: '', trade: '', state: '', workAreas: '', workHours: '', finishTime: '',
    suppliers: '', adminHeadache: '',
    businessContext: '', onboarded: false,
    step: 'waitingCode',
    pendingReminderTask: '', history: [],
    teamMembers: []
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
  const parts = workHours.split(/\s*(?:to|[-–])\s*/i); // word "to" or a dash, not the letters t/o
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

async function getUser(phone) {
  const doc = await db.collection('users').doc(phone).get();
  if (doc.exists) return doc.data();
  return newUser();
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

setInterval(async function() {
  try {
    const now = new Date();
    const reminders = await getPendingReminders();
    for (let i = 0; i < reminders.length; i++) {
      const reminder = reminders[i];
      if (now >= reminder.time) {
        try {
          await twilioClient.messages.create({
            body: "Hey " + reminder.name + " — don't forget: " + reminder.task,
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

      const parts = userMessage.split(' ');
      if (parts.length < 2) {
        twiml.message("Format: FLOWADMIN [phone number]");
        return reply();
      }

      let clientPhone = parts[1].trim();
      if (!clientPhone.startsWith('+')) {
        clientPhone = '+61' + clientPhone.replace(/^0/, '');
      }

      const code = generateCode();
      await db.collection('access_codes').doc(clientPhone).set({
        code: code, phone: clientPhone, used: false,
        createdAt: admin.firestore.Timestamp.now()
      });

      await twilioClient.messages.create({
        body: "G'day, your SiteFlow access code is " + code + ". Save this number as a contact, then text us your code to get started with Flow — your AI assistant built for construction.",
        from: process.env.TWILIO_PHONE_NUMBER,
        to: clientPhone
      });

      twiml.message("Code " + code + " sent to " + clientPhone + ".");
      return reply();
    }

    let user = await getUser(userPhone);

    if (user.step === 'waitingCode') {
      const codeDoc = await db.collection('access_codes').doc(userPhone).get();
      console.log("Code check - exists: " + codeDoc.exists + " entered: " + userMessage);

      if (!codeDoc.exists) {
        twiml.message("Welcome to SiteFlow. Enter your access code and we'll get you set up.");
      } else if (codeDoc.data().code === userMessage.trim()) {
        if (codeDoc.data().used) {
          twiml.message("Looks like that code's already been used. Drop a message at siteflowassistant.com and we'll sort out a new one.");
        } else {
          await db.collection('access_codes').doc(userPhone).update({ used: true });
          user.step = 'onboarding_1';
          await saveUser(userPhone, user);
          twiml.message("You're in. I'm Flow — think of me as the team member who remembers everything so you don't have to. A few quick questions so I get to know your business, then I'm ready to go. First up: what should I call you?");
        }
      } else {
        twiml.message("That code isn't matching. Double-check it, or head to siteflowassistant.com to get set up.");
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
        twiml.message("Thanks " + user.name + " — that's everything I need. I've got your back from here. Whenever something needs doing, just tell me and I'll keep you on track.");
        return reply();
      }

      await saveUser(userPhone, user);
      const stepNum = parseInt(step.split('_')[1]);
      twiml.message(QUESTIONS[stepNum - 1]);
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

    const needsSearch = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You decide if a message needs a web search to answer properly. Reply with only YES or NO. Reply YES if the message asks about prices, products, comparisons, weather, current information, suppliers, or availability. Reply NO for reminders, general chat, or task management.' },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 5
    });

    const shouldSearch = (needsSearch.choices[0].message.content || '').toUpperCase().includes('YES');
    let searchContext = '';

    if (shouldSearch) {
      const weatherKeywords = ['weather', 'rain', 'temperature', 'forecast', 'hot', 'cold', 'wind'];
      const isWeather = weatherKeywords.some(function(w) { return userMessage.toLowerCase().includes(w); });
      const searchQuery = isWeather ? 'weather forecast ' + user.workAreas + ' ' + user.state + ' Australia today' : userMessage + ' Australia';
      console.log('Searching: ' + searchQuery);
      const searchResults = await searchWeb(searchQuery);
      searchContext = '\n\nSEARCH RESULTS — you must use these to answer:\n' + searchResults;
    }

    const teamContext = user.teamMembers && user.teamMembers.length > 0 ? '\nTeam members: ' + JSON.stringify(user.teamMembers) : '';

    const systemPrompt = "You are Flow, an AI assistant built specifically for Australian construction business owners.\n\nRULES:\n- Professional and direct — no fluff\n- Never say you cannot access the internet\n- Never offer further help at the end of a message\n- Never end with a question unless you genuinely need information\n- Never mention ChatGPT or OpenAI\n- Always refer to yourself as Flow\n- Maximum three sentences per reply\n- Australian spelling and dollars\n- Always use the user's work areas and state for location based questions\n- You know their regular suppliers and their biggest admin headache. Reference suppliers by name when ordering or prices come up, and look for natural chances to help with that admin pain.\n\nWhen search results are provided you MUST use them.\n\nFor reminders with a clear time confirm in one sentence then add: REMINDER: [task] | [time]\n\nWhen the user mentions a person's name you don't recognise from the team list, after completing their request ask: 'Is [name] part of your team? I can keep track of them for you.'\n\nUser profile: " + user.businessContext + teamContext + "\nName: " + user.name + "\nState: " + user.state + "\nWork areas: " + user.workAreas + "\nWork hours: " + user.workHours + "\nFinish time: " + user.finishTime + "\nRegular suppliers: " + user.suppliers + "\nBiggest admin headache: " + user.adminHeadache + "\nLocal time: " + new Date().toLocaleString('en-AU', { timeZone: userTz }) + searchContext;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }].concat(user.history),
      max_tokens: 250
    });

    let flowReply = (response.choices[0].message.content || '').trim();

    const reminderMatch = flowReply.match(/REMINDER:\s*(.+?)\s*\|\s*(.+)/);
    if (reminderMatch) {
      const task = reminderMatch[1].trim();
      const timeText = reminderMatch[2].trim();
      const parsedTime = parseAuTime(timeText, userTz);
      if (parsedTime) {
        await saveReminder({ phone: userPhone, name: user.name, task: task, time: parsedTime });
        console.log("Reminder saved: " + task + " for " + parsedTime);
      }
      flowReply = flowReply.replace(/\nREMINDER:.*$/m, '').trim();
    }

    if (!flowReply) flowReply = "Righto — got that.";

    user.history.push({ role: 'assistant', content: flowReply });
    await saveUser(userPhone, user);
    twiml.message(flowReply);

    return reply();

  } catch (err) {
    console.error('Unhandled /sms error:', err);
    if (!res.headersSent) {
      const t = new twilio.twiml.MessagingResponse();
      t.message("Flow hit a snag — send that last message again in a moment.");
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(t.toString());
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Flow is live on port " + PORT);
});
