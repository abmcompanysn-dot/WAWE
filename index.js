require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
// Utiliser express.json() pour parser le corps des requêtes JSON.
app.use(express.json());

// Route racine pour vérifier que le serveur est en ligne
app.get('/', (req, res) => {
  res.send('Le serveur de webhook est actif.');
});

// Route pour la vérification du webhook par Meta (Facebook)
app.get('/api/webhook', (req, res) => {
  // Le jeton de vérification est maintenant défini directement dans le code.
  const VERIFY_TOKEN = '123456';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Route pour recevoir les notifications de messages de WhatsApp
app.post('/api/webhook', async (req, res) => {
  try {
    const { entry } = req.body;
    console.log('Corps de la requête reçu:', JSON.stringify(req.body, null, 2));

    const message = entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (message) {
      const from = message.from;
      const type = message.type;
      let userMessage; // Le contenu ou l'ID que nous allons traiter

      // Rendre le système intelligent : il comprend le texte ET les clics sur les boutons/listes
      if (type === 'text') {
        userMessage = message.text.body;
      } else if (type === 'interactive') {
        const interactiveType = message.interactive.type;

        if (interactiveType === 'list_reply') {
          // L'utilisateur a cliqué sur un élément d'une liste
          userMessage = message.interactive.list_reply.id;
          console.log(`Réponse de liste reçue, ID: ${userMessage}`);
        } else if (interactiveType === 'button_reply') {
          // L'utilisateur a cliqué sur un bouton
          userMessage = message.interactive.button_reply.id;
          console.log(`Réponse de bouton reçue, ID: ${userMessage}`);
        }
      }

      if (userMessage && from) {
        // --- Étape 1 : Enregistrer le message via l'API Google Apps Script ---
        try {
          await axios.post(process.env.APP_SCRIPT_URL, {
            timestamp: new Date().toISOString(),
            from: from,
            message: userMessage // On envoie le texte ou l'ID de l'interaction
          });
          console.log('Message enregistré dans Google Sheets.');
        } catch (scriptError) {
          console.error('Erreur lors de l\'envoi des données à Google Apps Script:', scriptError.message);
        }

        // --- Étape 2 : Obtenir la réponse à envoyer depuis l'API ---
        let whatsappPayload;

        try {
          // On appelle notre API en GET avec des paramètres dans l'URL
          const { data: replyData } = await axios.get(process.env.APP_SCRIPT_URL, {
            params: {
              action: 'findReply',
              keyword: userMessage, // On utilise le texte ou l'ID comme mot-clé
              from: from
            }
          });

          console.log('Réponse reçue de l\'API Google:', JSON.stringify(replyData));

          // Construire le payload WhatsApp en fonction du type de réponse
          if (replyData.status === 'success') {
            if (replyData.type === 'text') {
              whatsappPayload = { to: from, text: { body: replyData.content } };
            } else if (replyData.type === 'interactive') {
              whatsappPayload = { to: from, type: 'interactive', interactive: replyData.content };
            }
          }
        } catch (readError) {
          console.error('Erreur lors de la lecture depuis Google Apps Script:', readError.message);
        }

        // --- Étape 3 : Envoyer la réponse à l'utilisateur via WhatsApp ---
        if (whatsappPayload) {
          await axios.post(`https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`, 
            {
              messaging_product: 'whatsapp',
              ...whatsappPayload
            }, 
            {
              headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
              }
            }
          );
          console.log('Réponse envoyée à WhatsApp.');
        }
      }
    }

    // Répondre 200 OK à Meta pour indiquer que la notification a été reçue.
    res.sendStatus(200);
  } catch (error) {
    console.error('Erreur lors du traitement du webhook:', error.response ? error.response.data : error.message);
    // Il est important de répondre 200 même en cas d'erreur pour que Meta ne désactive pas le webhook.
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur actif sur http://localhost:${PORT}`));
