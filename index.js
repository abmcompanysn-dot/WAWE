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
app.post('/api/webhook', async (req, res) => { // Cette route est maintenant appelée par WhatsAuto
  try {
    // 1. Analyser le corps de la requête venant de WhatsAuto
    const { phone, message, sender } = req.body;
    console.log(`Message reçu de WhatsAuto: De ${sender} (${phone}), Message: "${message}"`);

    if (!phone || !message) {
      console.error('Requête invalide de WhatsAuto: "phone" ou "message" manquant.');
      return res.status(400).json({ error: 'Invalid request' });
    }

    // 2. Appeler Google Apps Script pour obtenir la réponse intelligente
    let replyMessage = "Désolé, une erreur est survenue."; // Réponse par défaut

    try {
      const { data: scriptResponse } = await axios.post(process.env.APP_SCRIPT_URL, {
        from: phone,
        message: message,
        senderName: sender // On peut passer le nom de l'expéditeur aussi
      });

      console.log('Réponse reçue de Google Apps Script:', JSON.stringify(scriptResponse));

      // Extraire la réponse du script
      if (scriptResponse && scriptResponse.status === 'success' && scriptResponse.reply) {
        replyMessage = scriptResponse.reply;
      }
    } catch (scriptError) {
      console.error('Erreur lors de l\'appel à Google Apps Script:', scriptError.message);
      // On utilisera la réponse par défaut
    }

    // 3. Renvoyer la réponse à WhatsAuto dans le format attendu
    console.log(`Envoi de la réponse à WhatsAuto: "${replyMessage}"`);
    res.status(200).json({
      reply: replyMessage
    });

  } catch (error) {
    console.error('Erreur globale dans le traitement du webhook:', error.message);
    // En cas d'erreur imprévue, renvoyer une réponse par défaut pour ne pas bloquer WhatsAuto
    res.status(200).json({
      reply: "Une erreur interne est survenue."
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur actif sur http://localhost:${PORT}`));
