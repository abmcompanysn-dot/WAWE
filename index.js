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
  // Création d'un ID unique pour chaque transaction pour un suivi facile dans les logs
  const transactionId = Math.random().toString(36).substring(2, 9);
  console.log(`\n--- [Début de la transaction: ${transactionId}] ---`);

  try {
    // 1. Analyser le corps de la requête venant de WhatsAuto
    const { phone, message, sender } = req.body;
    console.log(`[${transactionId}] Requête reçue de l'auteur: ${sender || 'Inconnu'} (${phone})`);
    console.log(`[${transactionId}] Message original: "${message}"`);

    if (!phone || !message) {
      console.error(`[${transactionId}] ERREUR: Requête invalide, "phone" ou "message" manquant.`);
      return res.status(400).json({ error: 'Invalid request' });
    }

    // 2. Appeler Google Apps Script pour obtenir la réponse intelligente
    let replyMessage = "Désolé, une erreur est survenue.";

    try {
      console.log(`[${transactionId}] Envoi des données à Google Apps Script pour analyse...`);
      const { data: scriptResponse } = await axios.post(process.env.APP_SCRIPT_URL, {
        from: phone,
        message: message,
        senderName: sender // On peut passer le nom de l'expéditeur aussi
      }, {
        timeout: 8000 // Ajout d'un timeout de 8 secondes
      });

      console.log(`[${transactionId}] Réponse reçue de Google Apps Script:`, JSON.stringify(scriptResponse));

      // Extraire la réponse du script
      if (scriptResponse && scriptResponse.status === 'success' && scriptResponse.reply) {
        replyMessage = scriptResponse.reply;
      }
    } catch (scriptError) {
      if (scriptError.code === 'ECONNABORTED') {
        console.error(`[${transactionId}] ERREUR: Le script Google Apps n'a pas répondu dans le temps imparti (timeout).`);
      }
      console.error(`[${transactionId}] ERREUR lors de l'appel à Google Apps Script:`, scriptError.message);
      // On utilisera la réponse par défaut
    }

    // 3. Renvoyer la réponse à WhatsAuto dans le format attendu
    console.log(`[${transactionId}] Envoi de la réponse finale à WhatsAuto: "${replyMessage}"`);
    res.status(200).json({
      reply: replyMessage
    });
    console.log(`--- [Fin de la transaction: ${transactionId}] ---`);

  } catch (error) {
    console.error(`[${transactionId}] ERREUR globale dans le traitement du webhook:`, error.message);
    // En cas d'erreur imprévue, renvoyer une réponse par défaut pour ne pas bloquer WhatsAuto
    res.status(200).json({
      reply: "Une erreur interne est survenue."
    });
    console.log(`--- [Fin de la transaction avec ERREUR: ${transactionId}] ---`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur actif sur http://localhost:${PORT}`));
