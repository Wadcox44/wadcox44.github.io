const axios = require('axios');

export default async function handler(req, res) {
  // Autoriser la connexion depuis le Pi Browser (CORS)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Utilisez POST." });
  }

  const { paymentId } = req.body;
  
  // ICI : Remplace par ta clé secrète (Server API Key) du portail Pi
  const PI_API_KEY = process.env.PI_API_KEY;

  try {
    // On demande au réseau Pi d'approuver le paiement
    const response = await axios.post(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {},
      {
        headers: { Authorization: `Key ${PI_API_KEY}` }
      }
    );

    console.log("Paiement approuvé !");
    return res.status(200).json(response.data);
  } catch (error) {
    console.error("Erreur Pi:", error.response ? error.response.data : error.message);
    return res.status(500).json({ error: "Erreur lors de l'approbation du paiement." });
  }
}
