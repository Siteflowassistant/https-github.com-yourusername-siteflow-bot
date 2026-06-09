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
              console.error('Parse error:', e.message);
              resolve('Could not parse search results.');
            }
          }

          if (encoding === 'gzip') {
            zlib.gunzip(buffer, function(err, decoded) {
              if (err) {
                resolve('Could not decode search results.');
              } else {
                processData(decoded);
              }
            });
          } else if (encoding === 'deflate') {
            zlib.inflate(buffer, function(err, decoded) {
              if (err) {
                resolve('Could not decode search results.');
              } else {
                processData(decoded);
              }
            });
          } else {
            processData(buffer);
          }
        } catch (e) {
          console.error('Search error:', e.message);
          resolve('Search unavailable right now.');
        }
      });
    });

    req.on('error', function(err) {
      console.error('Request error:', err.message);
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
  const userMessage = req.body.Body;
  const userPhone = req.body.From;
  const twiml = new twilio.twiml.MessagingResponse();

  if (!userContexts[userPhone]) {
    userContexts[userPhone] = {
      name: 'there',
      businessContext: 'A construction business owner in Australia.',
      history: []
    };
  }

  const user = userContexts[userPhone];
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
          content: 'You decide if a message needs a web search to answer properly. Reply with only YES or NO. Reply YES if the message asks about prices, products, comparisons, current information, suppliers, availability, or anything that needs up to date information. Reply NO for reminders, general chat, or task management.'
        },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 5
    });

    const shouldSearch = needsSearch.choices[0].message.content.trim().toUpperCase() === 'YES';
    let searchContext = '';

    if (shouldSearch) {
      console.log('Searching web for: ' + userMessage);
      const searchResults = await searchWeb(userMessage + ' Australia price');
      console.log('Search results: ' + searchResults.substring(0, 100));
      searchContext = '\n\nSEARCH RESULTS — you must use these to answer:\n' + searchResults;
    }

    const systemPrompt = "You are Flow, an AI assistant built specifically for Australian construction business owners.\n\nRULES:\n- Professional and direct — no fluff\n- Never say you cannot access the internet — you have search results provided to you\n- Never say mate or offer further help at the end\n- Never mention ChatGPT or OpenAI\n- Always refer to yourself as Flow\n- Maximum three sentences per reply\n- Australian spelling and dollars\n\nWhen search results are provided at the bottom of this message you MUST use them. Summarise them clearly and give a practical recommendation.\n\nFor reminders confirm in one sentence then add on a new line: REMINDER: [task] | [time]\n\nBusiness info: " + user.businessContext + "\nTime in Adelaide: " + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' }) + searchContext;

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
