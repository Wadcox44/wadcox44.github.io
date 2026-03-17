const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');
const { v4: uuid } = require('uuid');

const app = express();

const cors = require('cors'); // Importation du module CORS

// Autorise le Pi Browser et le SDK à communiquer avec ton serveur
app.use(cors({
    origin: ["https://app-cdn.minepi.com", "https://minepi.com"],
    credentials: true
}));

// Ta route de santé avec un petit bonus de sécurité pour Pi
app.get('/health', (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.status(200).send('OK');
});

// Route de santé pour confirmer au Pi Browser que le serveur est actif
app.get('/health', (req, res) => {
  res.status(200).send('OK'); // Envoie un code 200 (succès) pour la vérification
});

const PORT = process.env.PORT || 10000;

// Connexion MongoDB
const uri = process.env.MONGO_URI; 
const client = new MongoClient(uri);
let db, gallery;

async function connectDB() {
  try {
    await client.connect();
    db = client.db("jeuxvideo_db");
    gallery = db.collection("artworks");
    console.log("✅ Système JeuxVideo.Pi connecté au nouveau MongoDB !");
  } catch (e) {
    console.error("❌ Erreur de connexion DB:", e);
  }
}
connectDB();

app.use(express.json({ limit: '20mb' }));

// --- ROUTES API (On ajoute celles qui manquent pour stopper les erreurs 404) ---

app.get('/api/gallery', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json([]); // Évite l'erreur 503 si DB pas prête
    const arts = await gallery.find({}).sort({ createdAt: -1 }).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json([]); }
});

// On ajoute ces deux-là pour faire plaisir au jeu (même si elles sont vides pour l'instant)
app.get('/api/top10', (req, res) => res.json([])); 
app.get('/api/all-players', (req, res) => res.json([]));

app.post('/api/save', async (req, res) => {
  try {
    const { name, title, img } = req.body;
    const artwork = { id: uuid(), name, title, img, votes: 0, createdAt: new Date() };
    await gallery.insertOne(artwork);
    res.json({ id: artwork.id, success: true });
  } catch (e) { res.status(500).json({ error: "Erreur" }); }
});

// --- FICHIERS STATIQUES ---
// --- GESTION DES FICHIERS (PORTAIL + GOLD PIXEL) ---

// --- ACCÈS UNIQUE POUR GOLD PIXEL LITE ---
// Note : On utilise l'URL /goldpixel pour accéder au dossier Games/GoldPixel
app.use('/goldpixel', express.static(path.join(__dirname, 'Games', 'GoldPixel')));

// Note : On s'assure que si l'utilisateur tape l'URL, le serveur renvoie bien l'index.html
app.get('/goldpixel', (req, res) => {
  res.sendFile(path.join(__dirname, 'Games', 'GoldPixel', 'index.html'));
});
// Note : On garde l'accès au portail JeuxVideo.Pi pour la racine du site
app.use(express.static(path.join(__dirname)));

// Note : On force l'accès à la clé de validation pour le bot de Pi Network
app.get('/validation-key.txt', (req, res) => {
  res.sendFile(path.join(__dirname, 'validation-key.txt'));
});
app.use('/gold-pixel', express.static(path.join(__dirname, 'Games/Goldpixel')));

app.listen(PORT, () => console.log(`🚀 Serveur actif sur le port ${PORT}`));
