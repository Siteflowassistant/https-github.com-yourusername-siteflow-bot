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

function isCorrection(message) {
  const correctionPhrases = [
    'sorry i meant', 'sorry, i meant', 'i meant', 'actually',
    'correction', 'wrong', 'not that', 'ignore that',
    'disregard', 'scratch that', 'no wait', 'wait no',
    'sorry', 'oops', 'mistake'
  ];
  const lower = message.toLowerCase();
  return correctionPhrases.some(function(p) { return lower.includes(p); });
}

function extractCorrection(message) {
  const patterns = [
    /sorry[,]?\s+i meant\s+(.+)/i,
    /i meant\s+(.+)/i,
    /actually\s+(.+)/i,
    /correction[:\s]+(.+)/i,
    /no wait[,]?\s+(.+)/i,
    /wait[,]?\s+(.+)/i,
    /oops[,]?\s+(.+)/i,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const match = message.match(patterns[i]);
    if (match) return match[1].trim();
  }
  return null;
}

function getStepQuestion(step, name) {
  if (step === 1) return "What's your name?";
  if (step === 2) return "Good to meet you " + name + ". What's your trade? For example: Builder, Carpenter, Electrician, Plumber, Landscaper, Roofer, or other.";
  if (step === 3) return "How many people on your team including yourself?";
  if (step === 4) return "How do you currently manage your tasks and reminders?";
  if (step === 5) return "What state are you based in?";
  if (step === 6) return "What areas do you mainly work in? For example: Northern suburbs, CBD, regional, or specific towns.";
  if (step === 7) return "What are your normal work hours? For example: 7am to 5pm.";
  return '';
}

function isVagueTime(message) {
  const vagueTerms = [
    'in the morning', 'this morning', 'morning',
    'after work', 'end of day', 'when i finish', 'when i get home',
    'at night', 'tonight', 'this evening', 'evening',
    'at lunch', 'lunchtime', 'lunch time',
    'first thing', 'start of day',
    'later', 'soon', 'sometime today'
  ];
  const lower = message.toLowerCase();
  return vagueTerms.some(function(t) { return lower.includes(t); });
}

function isProfileUpdate(message) {
  const updatePhrases = [
    'update my', 'change my', 'my trade is now', 'my team is now',
    'i moved to', 'i now work in', 'my hours are now', 'my finish time is now',
    'new number', 'i am now', 'i work in', 'im now', 'i\'m now',
    'update profile', 'change profile', 'edit my'
  ];
  const lower = message.toLowerCase();
  return updatePhrases.some(function(p) { return lower.includes(p); });
}

function extractWorkHours(workHours) {
  const match = workHours.match(/to\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
  if (match) return match[1].trim();
  const parts = workHours.split(/[-–to]+/);
  if (parts.length >= 2) return parts[parts.length - 1].trim();
  return workHours.trim();
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
              if (results.length === 0) {
                resolve('No search results found.');
                return;
              }
              const summary = results.slice(0, 4).map(function(r) {
                return r.title + ': ' + (r.description || '');
              }).join('\n');
              resolve(summary);
            } catch (e) {
              resolve('Could not parse search results.');
            }
          }

          if (encoding === 'gzip') {
            zlib.gunzip(buffer, function(err, decoded) {
              if (err) { resolve('Could not decode search results.'); }
              else { processData(decoded); }
            });
          } else if (encoding === 'deflate') {
            zlib.inflate(buffer, function(err, decoded) {
              if (err) { resolve('Could not decode search results.'); }
              else { processData(decoded); }
            });
          } else {
            processData(buffer);
          }
        } catch (e) {
          resolve('Search unavailable right now.');
        }
      });
    });

    req.on('error', function(err) {
      resolve('Search unavailable right now.');
    });

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
        console.log("Reminder sent to " + reminder.phone + ": " + reminder.task);
      } catch (err) {
        console.error('Failed to send reminder:', err);
      }
    }
  }
}, 60000);

app.post('/sms', async function(req, res) {
  const userMessage = req.body.Body.trim();
  const userPhone = req.body.From;
  const twiml = new twilio.twiml.MessagingResponse();

  if (!userContexts[userPhone]) {
    userContexts[userPhone] = {
      name: '',
      trade: '',
      teamSize: '',
      taskManagement: '',
      state: '',
      workAreas: '',
      workHours: '',
      finishTime: '',
      businessContext: '',
      step: 0,
      pendingReminderTask: '',
      history: []
    };
  }

  const user = userContexts[userPhone];

  if (userMessage === '86753099') {
    userContexts[userPhone] = {
      name: '',
      trade: '',
      teamSize: '',
      taskManagement: '',
      state: '',
      workAreas: '',
      workHours: '',
      finishTime: '',
      businessContext: '',
      step: 0,
      pendingReminderTask: '',
      history: []
    };
    twiml.message("Profile reset. Starting fresh.");
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
    return;
  }

  if (user.step < 8 || user.step === 0.5) {
    let reply = '';

    if (user.step > 0 && user.step < 8 && isCorrection(userMessage)) {
      const correctedValue = extractCorrection(userMessage);
      const prevStep = user.step - 1;

      if (correctedValue) {
        if (prevStep === 1) user.name = correctedValue;
        else if (prevStep === 2) user.trade = correctedValue;
        else if (prevStep === 3) user.teamSize = correctedValue;
        else if (prevStep === 4) user.taskManagement = correctedValue;
        else if (prevStep === 5) user.state = correctedValue;
        else if (prevStep === 6) user.workAreas = correctedValue;
        else if (prevStep === 7) { user.workHours = correctedValue; user.finishTime = extractWorkHours(correctedValue); }
        reply = "Updated. " + getStepQuestion(user.step, user.name);
      } else {
        user.step = prevStep;
        reply = "No problem — " + getStepQuestion(prevStep, user.name);
      }

      twiml.message(reply);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(twiml.toString());
      return;
    }

    if (user.step === 0) {
      user.step = 0.5;
      reply = "G'day, I'm Flow — your SiteFlow AI assistant built for construction. To get started, I'll need to ask you a few quick questions so I can understand your business and work the way you do. Ready to get started?";
    } else if (user.step === 0.5) {
      user.step = 1;
      reply = "What's your name?";
    } else if (user.step === 1) {
      user.name = userMessage;
      user.step = 2;
      reply = "Good to meet you " + user.name + ". What's your trade? For example: Builder, Carpenter, Electrician, Plumber, Landscaper, Roofer, or other.";
    } else if (user.step === 2) {
      user.trade = userMessage;
      user.step = 3;
      reply = "Got it. How many people on your team including yourself?";
    } else if (user.step === 3) {
      user.teamSize = userMessage;
      user.step = 4;
      reply = "How do you currently manage your tasks and reminders?";
    } else if (user.step === 4) {
      user.taskManagement = userMessage;
      user.step = 5;
      reply = "What state are you based in?";
    } else if (user.step === 5) {
      user.state = userMessage;
      user.step = 6;
      reply = "What areas do you mainly work in? For example: Northern suburbs, CBD, regional, or specific towns.";
    } else if (user.step === 6) {
      user.workAreas = userMessage;
      user.step = 7;
      reply = "What are your normal work hours? For example: 7am to 5pm.";
    } else if (user.step === 7) {
      user.workHours = userMessage;
      user.finishTime = extractWorkHours(userMessage);
      user.step = 8;
      user.businessContext = user.name + " is a " + user.trade + " based in " + user.state + ", mainly working in " + user.workAreas + ". Team size: " + user.teamSize + ". Work hours: " + user.workHours + ". Finish time: " + user.finishTime + ". Currently manages tasks by: " + user.taskManagement + ".";
      reply = "All set " + user.name + ". Tell me what needs doing.";
    }

    twiml.message(reply);
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
      reminders.push({
        phone: userPhone,
        name: user.name,
        task: task,
        time: parsedTime
      });
      console.log("Reminder set: " + task + " for " + parsedTime);
      twiml.message("Locked in. I'll remind you to " + task + " at " + parsedTime.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Adelaide' }) + ".");
    } else {
      twiml.message("I didn't catch that time. What time exactly?");
      user.pendingReminderTask = task;
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
      const match = userMessage.match(/(?:area|suburb|location|work in)\s+(?:is now|is|to|=|:)?\s*(.+)/i);
      if (match) { user.workAreas = match[1].trim(); updated = true; updatedField = 'work areas'; }
    }
    if (lower.includes('hours') || lower.includes('finish time') || lower.includes('finish at')) {
      const match = userMessage.match(/(?:hours|finish time|finish at)\s+(?:is now|is|to|are now|are|=|:)?\s*(.+)/i);
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

  const reminderKeywords = ['remind me', 'reminder', 'don\'t let me forget', 'make sure i'];
  const hasReminder = reminderKeywords.some(function(k) { return userMessage.toLowerCase().includes(k); });

  if (hasReminder && isVagueTime(userMessage)) {
    const taskMatch = userMessage.match(/remind(?:er)?\s+(?:me\s+)?(?:to\s+)?(.+?)(?:\s+in the morning|\s+after work|\s+at night|\s+tonight|\s+this evening|\s+at lunch|\s+lunchtime|\s+first thing|\s+later|\s+soon|\s+sometime)/i);
    const task = taskMatch ? taskMatch[1].trim() : userMessage;
    user.pendingReminderTask = task;
    twiml.message("What time exactly?");
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
    return;
  }

  user.history.push({ role: 'user', content: userMessage });

  if (user.history.length > 20) {
    user.history = user.history.slice(-20);
  }

  try {
    const needsSearch = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You decide if a message needs a web search to answer properly. Reply with only YES or NO. Reply YES if the message asks about prices, products, comparisons, weather, current information, suppliers, availability, or anything that needs up to date information. Reply NO for reminders, general chat, or task management.'
        },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 5
    });

    const shouldSearch = needsSearch.choices[0].message.content.trim().toUpperCase() === 'YES';
    let searchContext = '';

    if (shouldSearch) {
      const weatherKeywords = ['weather', 'rain', 'temperature', 'forecast', 'hot', 'cold', 'wind'];
      const isWeather = weatherKeywords.some(function(w) { return userMessage.toLowerCase().includes(w); });
      let searchQuery = userMessage + ' Australia';
      if (isWeather) {
        searchQuery = 'weather forecast ' + user.workAreas + ' ' + user.state + ' Australia today';
      }
      console.log('Searching web for: ' + searchQuery);
      const searchResults = await searchWeb(searchQuery);
      console.log('Search results: ' + searchResults.substring(0, 100));
      searchContext = '\n\nSEARCH RESULTS — you must use these to answer:\n' + searchResults;
    }

    const systemPrompt = "You are Flow, an AI assistant built specifically for Australian construction business owners.\n\nRULES:\n- Professional and direct — no fluff\n- Never say you cannot access the internet — you have search results provided to you\n- Never offer further help at the end of a message\n- Never end with a question unless you genuinely need information\n- Never mention ChatGPT or OpenAI\n- Always refer to yourself as Flow\n- Maximum three sentences per reply\n- Australian spelling and dollars\n- Always use the user's work areas and state for location based questions\n\nWhen search results are provided you MUST use them. Summarise clearly and give a practical recommendation.\n\nFor reminders with a clear specific time confirm in one sentence then add on a new line: REMINDER: [task] | [time]\n\nUser profile: " + user.businessContext + "\nUser name: " + user.name + "\nUser state: " + user.state + "\nUser work areas: " + user.workAreas + "\nUser work hours: " + user.workHours + "\nUser finish time: " + user.finishTime + "\nTime in Adelaide: " + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' }) + searchContext;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt }
      ].concat(user.history),
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
        reminders.push({
          phone: userPhone,
          name: user.name,
          task: task,
          time: parsedTime
        });
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
