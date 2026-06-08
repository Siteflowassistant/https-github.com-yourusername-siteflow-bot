const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
app.use(express.urlencoded({ extended: false }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const userContexts = {};

app.post('/sms', async (req, res) => {
  const userMessage = req.body.Body;
  const userPhone = req.body.From;
  const twiml = new twilio.twiml.MessagingResponse();

  if (!userContexts[userPhone]) {
    userContexts[userPhone] = {
      name: 'mate',
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
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `You are Flow, an AI assistant built specifically for Australian construction business owners.

Your personality:
- Friendly and approachable but professional
- You speak like a reliable tradie — clear, direct, no corporate jargon
- Slightly humorous but never silly
- You never say "I am an AI" or mention ChatGPT or OpenAI
- You always refer to yourself as Flow
- Keep replies short and practical — builders are busy
- Always use Australian spelling and language

Your job:
- Help construction business owners stay organised
- Remember tasks and set reminders
- Follow up on important jobs
- Reduce admin and mental load

When a user mentions a task, deadline, or reminder:
- Confirm it clearly and simply
- Example: "No worries, I'll remind you tonight at 6pm"

When you don't know something:
- Be honest but helpful
- Never make up information

The user's name is ${user.name}.
The user's business information: ${user.businessContext}`
        },
        ...user.history
      ],
      max_tokens: 200
    });

    const flowReply = response.choices[0].message.content;
    user.history.push({ role: 'assistant', content: flowReply });
    twiml.message(flowReply);

  } catch (err) {
    console.error(err);
    twiml.message("Sorry mate, Flow's having a moment. Try again in a sec.");
  }

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Flow is live on port ${PORT}`));
