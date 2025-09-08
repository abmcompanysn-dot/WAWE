require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
app.use(bodyParser.json());

app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const entry = req.body.entry;
  console.log('Message reçu:', JSON.stringify(entry, null, 2));

  const msg = entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const from = msg?.from;
  const text = msg?.text?.body;

  if (text && from) {
    await axios.post(`https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to: from,
      type: 'text',
      text: { body: `Bonjour ${from}, vous avez dit : "${text}"` }
    }, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  }

  res.sendStatus(200);
});

app.listen(3000, () => console.log('Webhook actif sur http://localhost:3000/webhook'));