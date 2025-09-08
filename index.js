require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
// Utiliser express.json() pour parser le corps des requêtes JSON.
app.use(express.json());

// --- Interface de suivi en direct ---
// Lire le fichier dashboard.html une seule fois au démarrage pour garantir sa disponibilité sur Vercel
let dashboardHtmlContent;
try {
  dashboardHtmlContent = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
} catch (error) {
  console.error("Erreur critique: Impossible de charger le fichier dashboard.html. Le tableau de bord sera indisponible.", error);
  dashboardHtmlContent = "<h1>Erreur 500</h1><p>Le fichier du tableau de bord n'a pas pu être chargé.</p>";
}

// Stocke les 50 dernières transactions en mémoire.
const liveLogs = [];
const MAX_LOGS = 50;

// Route racine pour vérifier que le serveur est en ligne
app.get('/', (req, res) => {
  res.send('Le serveur de webhook est actif.');
});

// Nouvelle route pour l'interface de suivi en direct
app.get('/api/status', (req, res) => {
  console.log("[STATUS] La route /api/status a été appelée."); // Log de débogage
  res.status(200).json({
    serverStatus: 'Actif',
    transactionsRecentes: liveLogs
  });
});

// Nouvelle route pour l'interface de suivi en direct (HTML)
app.get('/api/dashboard', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(dashboardHtmlContent);
});

// --- Routes Webhook ---
// On regroupe les routes GET et POST pour /api/webhook pour une meilleure robustesse.
app.route('/api/webhook')
  .get((req, res) => {
    // Cette route est utilisée pour la vérification initiale (par Meta ou autre).
    const VERIFY_TOKEN = '123456';
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      console.log('WEBHOOK_VERIFICATION_FAILED');
      res.sendStatus(403);
    }
  })
  .post(async (req, res) => {
    // Cette route reçoit les requêtes de WhatsAuto.
    // Le code ci-dessous est le même qu'avant.

  // Création d'un ID unique pour chaque transaction pour un suivi facile dans les logs
  const transactionId = Math.random().toString(36).substring(2, 9);
  console.log(`\n--- [Début de la transaction: ${transactionId}] ---`);

  // Création de l'entrée pour notre interface de suivi
  const logEntry = {
    transaction: transactionId,
    timestamp: new Date().toISOString(),
    statut: 'En cours',
    auteur: {
      phone: req.body.phone || 'N/A',
      name: req.body.sender || 'Inconnu'
    },
    requete: {
      message: req.body.message || ''
    },
    reponse: {
      message: null
    },
    erreur: null
  };

  try {
    // 1. Analyser le corps de la requête venant de WhatsAuto
    const { phone, message, sender } = req.body;
    console.log(`[${transactionId}] Requête reçue de l'auteur: ${sender || 'Inconnu'} (${phone})`);
    console.log(`[${transactionId}] Message original: "${message}"`);

    if (!phone || !message) {
      const errorMsg = 'Requête invalide, "phone" ou "message" manquant.';
      console.error(`[${transactionId}] ERREUR: ${errorMsg}`);
      logEntry.statut = 'Échoué';
      logEntry.erreur = errorMsg;
      return res.status(400).json({ error: 'Invalid request' });
    }

    // 2. Appeler Google Apps Script pour obtenir la réponse intelligente
    let replyMessage = "Désolé, une erreur est survenue."; // Réponse par défaut

    try {
      console.log(`[${transactionId}] Envoi des données à Google Apps Script pour analyse...`);
      const { data: scriptResponse } = await axios.post(process.env.APP_SCRIPT_URL, {
        from: phone,
        message: message,
        senderName: sender
      }, {
        timeout: 8000 // Ajout d'un timeout de 8 secondes
      });

      console.log(`[${transactionId}] Réponse reçue de Google Apps Script:`, JSON.stringify(scriptResponse));

      // Vérifier si la réponse du script est valide
      if (scriptResponse && scriptResponse.status === 'success' && typeof scriptResponse.reply !== 'undefined' && scriptResponse.reply !== null) {
        // Si la réponse du script est une chaîne vide ou composée uniquement d'espaces,
        // on envoie une réponse minimale (un point) pour éviter l'erreur "null" de WhatsAuto.
        replyMessage = String(scriptResponse.reply).trim() === '' ? '.' : scriptResponse.reply;
      } else {
        // Si le script n'a pas renvoyé de réponse valide, on ne renvoie rien d'utile pour l'utilisateur.
        replyMessage = '.'; // On envoie un point pour s'assurer que la réponse n'est jamais vide.
      }
    } catch (scriptError) {
      if (scriptError.code === 'ECONNABORTED') {
        console.error(`[${transactionId}] ERREUR: Le script Google Apps n'a pas répondu dans le temps imparti (timeout).`);
        logEntry.erreur = "Timeout lors de l'appel à Google Apps Script.";
      }
      console.error(`[${transactionId}] ERREUR lors de l'appel à Google Apps Script:`, scriptError.message);
      logEntry.erreur = logEntry.erreur || scriptError.message;
    }

    // 3. Renvoyer la réponse à WhatsAuto dans le format attendu
    console.log(`[${transactionId}] Envoi de la réponse finale à WhatsAuto: "${replyMessage}"`);
    logEntry.reponse.message = replyMessage;
    logEntry.statut = 'Terminé';
    res.status(200).json({
      reply: replyMessage
    });
    console.log(`--- [Fin de la transaction: ${transactionId}] ---`);

  } catch (error) {
    const errorMsg = error.message;
    console.error(`[${transactionId}] ERREUR globale dans le traitement du webhook:`, errorMsg);
    logEntry.statut = 'Erreur';
    logEntry.erreur = errorMsg;
    logEntry.reponse.message = "Une erreur interne est survenue.";
    res.status(200).json({
      reply: "Une erreur interne est survenue."
    });
    console.log(`--- [Fin de la transaction avec ERREUR: ${transactionId}] ---`);
  } finally {
    // Ajouter l'entrée de log au début du tableau et limiter sa taille
    liveLogs.unshift(logEntry);
    if (liveLogs.length > MAX_LOGS) {
      liveLogs.pop();
    }
  }
  });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur actif sur http://localhost:${PORT}`));
