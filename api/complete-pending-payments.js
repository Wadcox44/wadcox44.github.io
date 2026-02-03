export default async function handler(req, res) {
    // Cette clé doit être configurée dans Vercel > Settings > Environment Variables
    const PI_API_KEY = process.env.PI_API_KEY;

    // Sécurité: autoriser CORS si besoin (pour que le frontend puisse l'appeler)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { payment } = req.body;

    if (!payment) {
        return res.status(400).json({ error: "No payment data" });
    }

    const paymentId = payment.identifier;
    const txid = payment.transaction?.txid;

    console.log(`Traitement paiement bloqué: ${paymentId}`);

    try {
        let url;
        // Cas 1: Il y a un TXID -> On valide (complete)
        if (txid) {
            url = `https://api.minepi.com/v2/payments/${paymentId}/complete`;
            await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Key ${PI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ txid })
            });
        }
        // Cas 2: Pas de TXID -> On annule (cancel)
        else {
            url = `https://api.minepi.com/v2/payments/${paymentId}/cancel`;
            await fetch(url, {
                method: 'POST',
                headers: { 'Authorization': `Key ${PI_API_KEY}` }
            });
        }

        return res.status(200).json({ success: true, message: "Paiement traité" });

    } catch (error) {
        console.error("Erreur Pi API:", error);
        return res.status(200).json({ error: error.message });
    }
}
