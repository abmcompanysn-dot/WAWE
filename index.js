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

// Nouvelle route pour l'API de statut (données JSON)
app.get('/api/status', (req, res) => {
  console.log("[STATUS] La route /api/status a été appelée."); // Log de débogage
  res.status(200).json({
    serverStatus: 'Actif',
    transactionsRecentes: liveLogs
  });
});

// Nouvelle route pour le tableau de bord visuel (HTML)
app.get('/api/dashboard', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(dashboardHtmlContent);
});

// Nouvelle route de débogage pour vérifier les variables d'environnement
app.get('/api/test-env', (req, res) => {
  console.log('Vérification de la variable d\'environnement APP_SCRIPT_URL.');
  const url = process.env.APP_SCRIPT_URL;
  if (url && url.startsWith('https://script.google.com')) {
    console.log('Variable APP_SCRIPT_URL trouvée et valide:', url);
    res.status(200).send(`<h1>SUCCÈS</h1><p>La variable d'environnement APP_SCRIPT_URL est bien configurée.</p><p>Valeur : ${url}</p>`);
  } else {
    console.error('ERREUR: Variable APP_SCRIPT_URL manquante ou invalide.');
    res.status(500).send(`<h1>ERREUR</h1><p>La variable d'environnement APP_SCRIPT_URL n'est pas configurée ou est invalide sur Vercel.</p><p>Valeur actuelle : ${url}</p>`);
  }
});

/**
 * Gère une requête entrante du webhook WhatsAuto.
 */
async function handleWebhookRequest(req, res) {
  // Création d'un ID unique pour chaque transaction pour un suivi facile dans les logs
  const transactionId = Math.random().toString(36).substring(2, 9);
  console.log(`\n--- [Début de la transaction: ${transactionId}] ---`);

  // Log de débogage pour voir si la requête arrive bien
  console.log(`[${transactionId}] Requête reçue sur /api/webhook.`);
  console.log(`[${transactionId}] Corps de la requête: ${JSON.stringify(req.body)}`);

  // Création de l'entrée pour notre interface de suivi
  const logEntry = {
    transaction: transactionId,
    timestamp: new Date().toISOString(),
    status: 'En cours',
    author: {
      phone: req.body.phone || 'N/A',
      name: req.body.sender || 'Inconnu'
    },
    request: {
      message: req.body.message || ''
    },
    response: {
      message: null
    },
    error: null
  };

  try {
    // 1. Analyser le corps de la requête venant de WhatsAuto
    const { phone, message, sender } = req.body;
    console.log(`[${transactionId}] Requête reçue de l'auteur: ${sender || 'Inconnu'} (${phone})`);
    console.log(`[${transactionId}] Message original: "${message}"`);

    if (!phone || !message) {
      const errorMsg = 'Requête invalide, "phone" ou "message" manquant.';
      console.error(`[${transactionId}] ERREUR: ${errorMsg}`);
      logEntry.status = 'Échoué';
      logEntry.error = errorMsg;
      // On renvoie une réponse au format attendu par WhatsAuto pour un meilleur débogage
      // au lieu de l'erreur "null", vous verrez ce message d'erreur dans WhatsAuto.
      return res.status(200).json({ reply: `ERREUR: ${errorMsg}` });
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
        logEntry.error = "La réponse du script Google était invalide ou vide.";
        // Si le script n'a pas renvoyé de réponse valide, on ne renvoie rien d'utile pour l'utilisateur.
        replyMessage = '.'; // On envoie un point pour s'assurer que la réponse n'est jamais vide.
      }
    } catch (scriptError) {
      if (scriptError.code === 'ECONNABORTED') {
        console.error(`[${transactionId}] ERREUR: Le script Google Apps n'a pas répondu dans le temps imparti (timeout).`);
        logEntry.error = "Timeout lors de l'appel à Google Apps Script.";
        logEntry.status = 'Erreur';
      }
      console.error(`[${transactionId}] ERREUR lors de l'appel à Google Apps Script:`, scriptError.message);
      // Ajouter plus de détails sur l'erreur axios si disponible
      if (scriptError.response) {
        logEntry.error = `Erreur ${scriptError.response.status}: ${scriptError.response.data}`;
      } else {
        logEntry.error = logEntry.error || scriptError.message;
      }
      logEntry.status = 'Erreur';
    }

    // 3. Renvoyer la réponse à WhatsAuto dans le format attendu
    console.log(`[${transactionId}] Envoi de la réponse finale à WhatsAuto: "${replyMessage}"`);
    // Mettre à jour le statut du log en cas de succès
    if (logEntry.status === 'En cours') {
      logEntry.status = 'Terminé';
    }
    logEntry.response.message = replyMessage;
    res.status(200).json({
      reply: replyMessage
    });
    console.log(`--- [Fin de la transaction: ${transactionId}] ---`);

  } catch (error) {
    const errorMsg = error.message;
    console.error(`[${transactionId}] ERREUR globale dans le traitement du webhook:`, errorMsg);
    logEntry.status = 'Erreur';
    logEntry.error = errorMsg;
    logEntry.response.message = "Une erreur interne est survenue.";
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
}

// --- Routes Webhook ---
// On regroupe les routes GET et POST pour /api/webhook pour une meilleure robustesse.
app.route('/api/webhook')
  .get((req, res) => {
    // Cette route peut être utilisée pour un simple test de connectivité.
    // La logique de vérification de Meta a été retirée car elle n'est plus nécessaire.
    res.status(200).send('Webhook endpoint is active and ready to receive POST requests from WhatsAuto.');
  })
  .post(handleWebhookRequest);

// Exporter l'application pour Vercel.
// La ligne app.listen() est retirée car Vercel gère le port d'écoute.
module.exports = app;

// On garde cette partie commentée pour pouvoir tester facilement en local si besoin.
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => console.log(`Serveur actif sur http://localhost:${PORT}`));
