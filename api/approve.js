import axios from 'axios';

export default async function handler(req, res) {
  // --- CONFIGURATION DES CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: "Méthode POST requise" });

  const { paymentId } = req.body;
  const PI_API_KEY = process.env.PI_API_KEY;

  try {
    // Tentative d'approbation officielle
    const response = await axios.post(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {},
      { headers: { Authorization: `Key ${PI_API_KEY}` } }
    );

    console.log("Paiement approuvé avec succès !");
    return res.status(200).json(response.data);

  } catch (error) {
    const errorData = error.response ? error.response.data : {};
    console.log("Réponse de l'API Pi:", errorData);

    // --- LE CORRECTIF MAGIQUE ---
    // Si le paiement est déjà approuvé, on renvoie "true" pour libérer le SDK
    if (errorData.message === "already_approved" || errorData.error === "already_approved") {
      console.log("Déblocage : paiement déjà approuvé.");
      return res.status(200).json({ approved: true });
    }

    return res.status(500).json({ error: "Erreur lors de l'approbation" });
  }
}
