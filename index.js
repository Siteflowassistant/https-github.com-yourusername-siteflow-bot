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

function resolveTimeShortcuts(message, finishTime) {
  const finish = finishTime || '5:00pm';
  return message
    .replace(/after work/gi, 'at ' + finish)
    .replace(/end of day/gi, 'at ' + finish)
    .replace(/when i finish/gi, 'at ' + finish)
    .replace(/when i get home/gi, 'at ' + finish)
    .replace(/after i finish/gi, 'at ' + finish)
    .replace(/lunchtime/gi, 'at 12:00pm')
    .replace(/lunch time/gi, 'at 12:00pm')
    .replace(/this morning/gi, 'at 8:00am')
    .replace(/start of day/gi, 'at 7:00am')
    .replace(/first thing/gi, 'at 7:00am');
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
      finishTime: '',
      businessContext: '',
      step: 0,
      history: []
    };
  }

  const user = userContexts[userPhone];

  if (user.step < 8) {
    let reply = '';

    if (user.step === 0) {
      user.step = 1;
      reply = "G'day, I'm Flow — your SiteFlow AI assistant for construction. Before we get started, what's your name?";

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
      reply = "What time do you usually finish work?";

    } else if (user.step === 7) {
      user.finishTime = userMessage;
      user.step = 8;
      user.businessContext = user.name + " is a " + user.trade + " based in " + user.state + ", mainly working in " + user.workAreas + ". Team size: " + user.teamSize + ". Finish time: " + user.finishTime + ". Currently manages tasks by: " + user.taskManagement + ".";
      reply = "All set " + user.name + ". Tell me what needs doing.";
    }

    twiml.message(reply);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
    return;
  }

  const resolvedMessage = resolveTimeShortcuts(userMessage, user.finishTime);
  user.history.push({ role: 'user', content: resolvedMessage });

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
        { role: 'user', content: resolvedMessage }
      ],
      max_tokens: 5
    });

    const shouldSearch = needsSearch.choices[0].message.content.trim().toUpperCase() === 'YES';
    let searchContext = '';

    if (shouldSearch) {
      const weatherKeywords = ['weather', 'rain', 'temperature', 'forecast', 'hot', 'cold', 'wind'];
      const isWeather = weatherKeywords.some(function(w) { return resolvedMessage.toLowerCase().includes(w); });
      let searchQuery = resolvedMessage + ' Australia';
      if (isWeather) {
        searchQuery = 'weather forecast ' + user.workAreas + ' ' + user.state + ' Australia today';
      }
      console.log('Searching web for: ' + searchQuery);
      const searchResults = await searchWeb(searchQuery);
      console.log('Search results: ' + searchResults.substring(0, 100));
      searchContext = '\n\nSEARCH RESULTS — you must use these to answer:\n' + searchResults;
    }

    const systemPrompt = "You are Flow, an AI assistant built specifically for Australian construction business owners.\n\nRULES:\n- Professional and direct — no fluff\n- Never say you cannot access the internet — you have search results provided to you\n- Never offer further help at the end of a message\n- Never end with a question unless you genuinely need information\n- Never mention ChatGPT or OpenAI\n- Always refer to yourself as Flow\n- Maximum three sentences per reply\n- Australian spelling and dollars\n- Always use the user's work areas and state for location based questions\n\nWhen search results are provided you MUST use them. Summarise clearly and give a practical recommendation.\n\nFor reminders confirm in one sentence then add on a new line: REMINDER: [task] | [time]\n\nUser profile: " + user.businessContext + "\nUser name: " + user.name + "\nUser state: " + user.state + "\nUser work areas: " + user.workAreas + "\nUser finish time: " + user.finishTime + "\nTime in Adelaide: " + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' }) + searchContext;

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
