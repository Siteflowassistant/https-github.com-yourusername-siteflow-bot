const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const chrono = require('chrono-node');
const https = require('https');

const app = express();
app.use(express.urlencoded({ extended: false }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const userContexts = {};
const reminders = [];

function searchWeb(query) {
  return new Promise(function(resolve, reject) {
    const encodedQuery = encodeURIComponent(query);
    const options = {
      hostname: 'api.search.brave.com',
      path: '/res/v1/web/search?q=' + encodedQuery + '&count=5',
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': process.env.BRAVE_API_KEY
      }
    };

    const req = https.request(options, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          const parsed = JSON.parse(data);
          const results = parsed.web && parsed.web.results ? parsed.web.results : [];
          const summary = results.slice(0, 4).map(function(r) {
            return r.title + ': ' + r.description;
          }).join('\n');
          resolve(summary || 'No results found.');
        } catch (e) {
          resolve('Could not retrieve search results.');
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
          content: 'You decide if a message needs a web search to answer properly. Reply with only YES or NO. Reply YES if the message asks about prices, products, comparisons, current information, suppliers, availability, news, or anything that needs up to date information. Reply NO for reminders, general chat, task management, or anything that does not need current data.'
        },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 5
    });

    const shouldSearch = needsSearch.choices[0].message.content.trim().toUpperCase() === 'YES';
    let searchContext = '';

    if (shouldSearch) {
      console.log('Searching web for: ' + userMessage);
      const searchResults = await searchWeb(userMessage + ' Australia');
      searchContext = '\n\nWeb search results for context:\n' + searchResults;
      console.log('Search complete.');
    }

    const systemPrompt = "You are Flow, an AI assistant built specifically for Australian construction business owners.\n\nYour personality:\n- Professional and direct\n- Clear and efficient — no fluff, no filler\n- Never say mate, no worries, or offer further help at the end of a message\n- Never end with a question unless you genuinely need information to complete a task\n- Never mention ChatGPT or OpenAI\n- Always refer to yourself as Flow\n- Keep replies concise — three sentences maximum\n- Use Australian spelling and dollars\n\nYour job:\n- Help construction business owners stay organised\n- Set reminders and follow through on them\n- Search for prices, products, and supplier information when asked\n- Reduce admin and mental load\n\nWhen comparing prices or products:\n- Give a direct, practical summary\n- Use Australian dollars where possible\n- Give a recommendation if the data supports it\n\nIMPORTANT — When the user asks for a reminder:\n- Confirm it in one short sentence\n- End your reply with this exact format on a new line: REMINDER: [task description] | [time description]\n- Example: REMINDER: Invoice David | tonight at 6pm\n\nWhen you do not know something be honest and brief. Never make up information.\n\nThe user's business information: " + user.businessContext + "\nCurrent date and time in Adelaide: " + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' }) + searchContext;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt }
      ].concat(user.history),
      max_tokens: 200
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
        console.log("Reminder set: " + task + " for " + parsedTime + " to " + userPhone);
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
