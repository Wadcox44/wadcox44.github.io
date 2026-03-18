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

// --- GESTION DES CLÉS ET DES DOSSIERS (VERSION FINALE) ---

// Note : On récupère les deux clés depuis tes variables Render
const keyJeuxVideo = process.env.PI_API_KEY_JEUXVIDEO || "";
const keyGoldPixel = process.env.PI_API_KEY_GOLDPIXEL || "";

// Note : Route de validation (OK : tu as confirmé que ça marche !)
app.get('/validation-key.txt', (req, res) => {
  res.send(`${keyJeuxVideo}\n${keyGoldPixel}`); 
});

// Note : Dossier Games/Goldpixel (Correction du 'p' minuscule selon ton image)
app.use('/goldpixel', express.static(path.join(__dirname, 'Games', 'Goldpixel')));

// Note : Route pour servir goldpixel.html
app.get('/goldpixel', (req, res) => {
  res.sendFile(path.join(__dirname, 'Games', 'Goldpixel', 'goldpixel.html'), (err) => {
    if (err) {
      res.status(404).send("Erreur : Fichier goldpixel.html introuvable dans Games/Goldpixel");
    }
  });
});

// Note : On garde le portail à la racine en dernier
app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => console.log(`🚀 Serveur actif sur le port ${PORT}`));
