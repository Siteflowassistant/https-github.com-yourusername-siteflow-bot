const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const chrono = require('chrono-node');
const https = require('https');
const zlib = require('zlib');

const app = express();
app.use(express.urlencoded({ extended: false }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const userContexts = {};
const reminders = [];

function newUser() {
  return {
    name: '', trade: '', teamSize: '', taskManagement: '',
    state: '', workAreas: '', workHours: '', finishTime: '',
    businessContext: '', onboarded: false,
    onboardingIndex: 0,
    pendingReminderTask: '', history: []
  };
}

const QUESTIONS = [
  "G'day, I'm Flow — your SiteFlow AI assistant built for construction. To get started I need to ask a few quick questions so I can understand your business. What's your name?",
  "What's your trade? For example: Builder, Carpenter, Electrician, Plumber, Landscaper, Roofer, or other.",
  "How many people on your team including yourself?",
  "How do you currently manage your tasks and reminders?",
  "What state are you based in?",
  "What areas do you mainly work in? For example: Northern suburbs, CBD, regional, or specific towns.",
  "What are your normal work hours? For example: 7am to 5pm."
];

function extractWorkHours(workHours) {
  const match = workHours.match(/to\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
  if (match) return match[1].trim();
  const parts = workHours.split(/[-–to]+/);
  if (parts.length >= 2) return parts[parts.length - 1].trim();
  return workHours.trim();
}

function isVagueTime(message) {
  const vagueTerms = ['in the morning', 'this morning', 'after work', 'end of day', 'when i finish', 'when i get home', 'at night', 'tonight', 'this evening', 'evening', 'at lunch', 'lunchtime', 'lunch time', 'first thing', 'start of day', 'later today', 'sometime today'];
  const lower = message.toLowerCase();
  return vagueTerms.some(function(t) { return lower.includes(t); });
}

function isProfileUpdate(message) {
  const phrases = ['update my', 'change my', 'my trade is now', 'my team is now', 'i moved to', 'i now work in', 'my hours are now', 'update profile', 'change profile', 'edit my'];
  const lower = message.toLowerCase();
  return phrases.some(function(p) { return lower.includes(p); });
}

function searchWeb(query) {
  return new Promise(function(resolve) {
    const encodedQuery = encodeURIComponent(query);
    const options = {
      hostname: 'api.search.brave.com',
      path: '/res/v1/web/search?q=' + encodedQuery + '&count=5',
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': process.env.BRAVE_API_KEY
      }
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
              const summary = results.slice(0, 4).map(function(r) {
                return r.title + ': ' + (r.description || '');
              }).join('\n');
              resolve(summary);
            } catch (e) { resolve('Could not parse search results.'); }
          }

          if (encoding === 'gzip') {
            zlib.gunzip(buffer, function(err, decoded) {
              if (err) { resolve('Could not decode.'); } else { processData(decoded); }
            });
          } else if (encoding === 'deflate') {
            zlib.inflate(buffer, function(err, decoded) {
              if (err) { resolve('Could not decode.'); } else { processData(decoded); }
            });
          } else { processData(buffer); }
        } catch (e) { resolve('Search unavailable.'); }
      });
    });

    req.on('error', function() { resolve('Search unavailable.'); });
    req.end();
  });
}

setInterval(async function() {
  const now = new Date();
  for (let i = reminders.length - 1; i >= 0; i--) {
    const reminder = reminders[i];
    if (now >= reminder.time) {
      try {
        await twilioClient.messages.create({
          body: "Hey " + reminder.name + " — don't forget: " + reminder.task,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: reminder.phone
        });
        reminders.splice(i, 1);
        console.log("Reminder sent: " + reminder.task);
      } catch (err) { console.error('Reminder failed:', err); }
    }
  }
}, 60000);

app.post('/sms', async function(req, res) {
  const userMessage = req.body.Body.trim();
  const userPhone = req.body.From;
  const twiml = new twilio.twiml.MessagingResponse();

  if (!userContexts[userPhone]) {
    userContexts[userPhone] = newUser();
  }

  const user = userContexts[userPhone];

  if (userMessage === '86753099') {
    userContexts[userPhone] = newUser();
    twiml.message("Profile reset. Starting fresh.");
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
    return;
  }

  if (!user.onboarded) {
    const idx = user.onboardingIndex;
    console.log("Onboarding idx: " + idx + " message: " + userMessage);

    if (idx === 0) {
      user.onboardingIndex = 1;
      twiml.message(QUESTIONS[0]);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(twiml.toString());
      return;
    }

    if (idx === 1) { user.name = userMessage; }
    else if (idx === 2) { user.trade = userMessage; }
    else if (idx === 3) { user.teamSize = userMessage; }
    else if (idx === 4) { user.taskManagement = userMessage; }
    else if (idx === 5) { user.state = userMessage; }
    else if (idx === 6) { user.workAreas = userMessage; }
    else if (idx === 7) {
      user.workHours = userMessage;
      user.finishTime = extractWorkHours(userMessage);
      user.onboarded = true;
      user.businessContext = user.name + " is a " + user.trade + " based in " + user.state + ", mainly working in " + user.workAreas + ". Team size: " + user.teamSize + ". Work hours: " + user.workHours + ". Finish time: " + user.finishTime + ". Currently manages tasks by: " + user.taskManagement + ".";
      twiml.message("All set " + user.name + ". Tell me what needs doing.");
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(twiml.toString());
      return;
    }

    user.onboardingIndex = idx + 1;
    twiml.message(QUESTIONS[idx]);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
    return;
  }

  if (user.pendingReminderTask && user.pendingReminderTask !== '') {
    const task = user.pendingReminderTask;
    user.pendingReminderTask = '';
    const now = new Date();
    const parsedTime = chrono.parseDate(userMessage, now, { forwardDate: true, timezone: 'Australia/Adelaide' });

    if (parsedTime) {
      reminders.push({ phone: userPhone, name: user.name, task: task, time: parsedTime });
      console.log("Reminder set: " + task + " for " + parsedTime);
      twiml.message("Locked in. I'll remind you to " + task + " at " + parsedTime.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Adelaide' }) + ".");
    } else {
      user.pendingReminderTask = task;
      twiml.message("I didn't catch that time. What time exactly?");
    }

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
    return;
  }

  if (isProfileUpdate(userMessage)) {
    const lower = userMessage.toLowerCase();
    let updated = false;
    let updatedField = '';

    if (lower.includes('trade') || lower.includes('job')) {
      const match = userMessage.match(/(?:trade|job)\s+(?:is now|is|to|=)\s+(.+)/i);
      if (match) { user.trade = match[1].trim(); updated = true; updatedField = 'trade'; }
    }
    if (lower.includes('team') || lower.includes('staff')) {
      const match = userMessage.match(/(?:team|staff)\s+(?:is now|is|to|=)\s+(.+)/i);
      if (match) { user.teamSize = match[1].trim(); updated = true; updatedField = 'team size'; }
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

    if (updated) {
      user.businessContext = user.name + " is a " + user.trade + " based in " + user.state + ", mainly working in " + user.workAreas + ". Team size: " + user.teamSize + ". Work hours: " + user.workHours + ". Finish time: " + user.finishTime + ". Currently manages tasks by: " + user.taskManagement + ".";
      twiml.message("Updated your " + updatedField + ".");
    } else {
      twiml.message("What would you like to update? You can change your trade, team size, state, work areas, or work hours.");
    }

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
    return;
  }

  const reminderKeywords = ['remind me', 'reminder', "don't let me forget", 'make sure i'];
  const hasReminder = reminderKeywords.some(function(k) { return userMessage.toLowerCase().includes(k); });

  if (hasReminder && isVagueTime(userMessage)) {
    const taskMatch = userMessage.match(/remind(?:er)?\s+(?:me\s+)?(?:to\s+)?(.+?)(?:\s+in the morning|\s+after work|\s+at night|\s+tonight|\s+this evening|\s+at lunch|\s+lunchtime|\s+first thing|\s+later|\s+sometime)/i);
    const task = taskMatch ? taskMatch[1].trim() : userMessage;
    user.pendingReminderTask = task;
    twiml.message("What time exactly?");
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
    return;
  }

  user.history.push({ role: 'user', content: userMessage });
  if (user.history.length > 20) { user.history = user.history.slice(-20); }

  try {
    const needsSearch = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You decide if a message needs a web search to answer properly. Reply with only YES or NO. Reply YES if the message asks about prices, products, comparisons, weather, current information, suppliers, or availability. Reply NO for reminders, general chat, or task management.' },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 5
    });

    const shouldSearch = needsSearch.choices[0].message.content.trim().toUpperCase() === 'YES';
    let searchContext = '';

    if (shouldSearch) {
      const weatherKeywords = ['weather', 'rain', 'temperature', 'forecast', 'hot', 'cold', 'wind'];
      const isWeather = weatherKeywords.some(function(w) { return userMessage.toLowerCase().includes(w); });
      const searchQuery = isWeather ? 'weather forecast ' + user.workAreas + ' ' + user.state + ' Australia today' : userMessage + ' Australia';
      console.log('Searching: ' + searchQuery);
      const searchResults = await searchWeb(searchQuery);
      searchContext = '\n\nSEARCH RESULTS — you must use these to answer:\n' + searchResults;
    }

    const systemPrompt = "You are Flow, an AI assistant built specifically for Australian construction business owners.\n\nRULES:\n- Professional and direct — no fluff\n- Never say you cannot access the internet\n- Never offer further help at the end of a message\n- Never end with a question unless you genuinely need information\n- Never mention ChatGPT or OpenAI\n- Always refer to yourself as Flow\n- Maximum three sentences per reply\n- Australian spelling and dollars\n- Always use the user's work areas and state for location based questions\n\nWhen search results are provided you MUST use them.\n\nFor reminders with a clear time confirm in one sentence then add: REMINDER: [task] | [time]\n\nUser profile: " + user.businessContext + "\nName: " + user.name + "\nState: " + user.state + "\nWork areas: " + user.workAreas + "\nWork hours: " + user.workHours + "\nFinish time: " + user.finishTime + "\nTime in Adelaide: " + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' }) + searchContext;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemPrompt }].concat(user.history),
      max_tokens: 250
    });

    let flowReply = response.choices[0].message.content;

    const reminderMatch = flowReply.match(/REMINDER:\s*(.+?)\s*\|\s*(.+)/);
    if (reminderMatch) {
      const task = reminderMatch[1].trim();
      const timeText = reminderMatch[2].trim();
      const now = new Date();
      const parsedTime = chrono.parseDate(timeText, now, { forwardDate: true, timezone: 'Australia/Adelaide' });
      if (parsedTime) {
        reminders.push({ phone: userPhone, name: user.name, task: task, time: parsedTime });
        console.log("Reminder set: " + task + " for " + parsedTime);
      }
      flowReply = flowReply.replace(/\nREMINDER:.*$/m, '').trim();
    }

    user.history.push({ role: 'assistant', content: flowReply });
    twiml.message(flowReply);

  } catch (err) {
    console.error(err);
    twiml.message("Flow is having a moment. Try again in a sec.");
  }

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Flow is live on port " + PORT);
});
