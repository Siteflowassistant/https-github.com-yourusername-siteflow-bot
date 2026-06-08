const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
const chrono = require('chrono-node');

const app = express();
app.use(express.urlencoded({ extended: false }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const userContexts = {};
const reminders = [];

setInterval(async () => {
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

app.post('/sms', async (req, res) => {
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

  const systemPrompt = "You are Flow, an AI assistant built specifically for Australian construction business owners.\n\nYour personality:\n- Professional and direct\n- Clear and efficient — no fluff, no filler\n- Never say mate, no worries, or offer further help at the end of a message\n- Never end with a question unless you genuinely need information to complete a task\n- Never mention ChatGPT or OpenAI\n- Always refer to yourself as Flow\n- Keep replies to one or two sentences maximum\n- Use Australian spelling\n\nYour job:\n- Help construction business owners stay organised\n- Set reminders and follow through on them\n- Reduce admin and mental load\n\nIMPORTANT — When the user asks for a reminder:\n- Confirm it in one short sentence\n- End your reply with this exact format on a new line: REMINDER: [task description] | [time description]\n- Example: REMINDER: Invoice David | tonight at 6pm\n- Example: REMINDER: Order timber | tomorrow at 9am\n- Example: REMINDER: Call the plumber | Friday at 3pm\n\nWhen you do not know something be honest and brief. Never make up information.\n\nThe user's business information: " + user.businessContext + "\nCurrent date and time in Adelaide: " + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' });

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt }
      ].concat(user.history),
      max_tokens: 150
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
