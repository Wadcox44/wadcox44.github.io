import axios from 'axios';

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
    const response = await axios.post(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {},
      { headers: { Authorization: `Key ${PI_API_KEY}` } }
    );

    console.log("Paiement approuvé !");
    return res.status(200).json(response.data);
  } catch (error) {
    const errorData = error.response ? error.response.data : {};
    
    // Si le paiement est déjà approuvé, on renvoie quand même un succès
    // Cela débloque l'interface utilisateur sur ton téléphone
    if (errorData.error === 'already_approved') {
      console.log("Paiement déjà approuvé sur Pi, déblocage de l'interface.");
      return res.status(200).json({ approved: true });
    }

    console.error("Erreur Pi:", errorData);
    return res.status(500).json({ error: "Erreur lors de l'approbation." });
  }
}
