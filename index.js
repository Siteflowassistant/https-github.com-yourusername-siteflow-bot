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

// Check reminders every minute
setInterval(async () => {
  const now = new Date();
  for (let i = reminders.length - 1; i >= 0; i--) {
    const reminder = reminders[i];
    if (now >= reminder.time) {
      try {
        await twilioClient.messages.create({
          body: `Hey ${reminder.name} — don't forget: ${reminder.task}`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: reminder.phone
        });
        reminders.splice(i, 1);
        console.log(`Reminder sent to ${reminder.phone}: ${reminder.task}`);
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

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are Flow, an AI assistant built specifically for Australian construction business owners.

Your personality:
- Friendly and professional
- Clear and direct — no fluff, no filler
- Never say "mate", "no worries
