const express = require('express'); // Importe Express pour gérer le serveur
const path = require('path'); // Module pour naviguer dans les dossiers
const { MongoClient } = require('mongodb'); // Client pour ta base de données
const { v4: uuid } = require('uuid'); // Pour générer des identifiants uniques

const app = express(); // Création de l'application
const PORT = process.env.PORT || 10000; // Port utilisé par Render (par défaut 10000)

const uri = process.env.MONGO_URI; // Ton lien secret MongoDB configuré sur Render
const client = new MongoClient(uri); // Prépare la connexion
let db, gallery;

async function connectDB() { // Allume la connexion à la base de données
  try {
    if (!uri) { console.error("❌ Erreur : MONGO_URI manquante !"); return; }
    await client.connect(); // Connexion effective au cloud
    db = client.db("goldpixel_db"); // Utilise ta base de données
    gallery = db.collection("artworks"); // Utilise ta collection d'images
    console.log("✅ Gold Pixel v3.0 connecté au Cloud MongoDB !");
  } catch (e) { console.error("❌ Erreur connexion DB:", e); }
}
connectDB(); // Lance la connexion au démarrage

// ─── CORS (Autorise les échanges de données) ───
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── MIDDLEWARES ───
app.use(express.json({ limit: '20mb' })); // Permet de lire les grosses images
app.use(express.urlencoded({ extended: true }));

// ─── ROUTES API (Gestion des dessins) ───
app.get('/api/gallery', async (req, res) => { // Récupère les œuvres
  try {
    if (!gallery) return res.status(503).json([]);
    const arts = await gallery.find({}).sort({ createdAt: -1 }).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json([]); }
});

app.post('/api/save', async (req, res) => { // Sauvegarde une œuvre
  try {
    if (!gallery) return res.status(503).json({ error: "DB non connectée" });
    const { name, title, img } = req.body;
    if (!img) return res.status(400).json({ error: "Image manquante" });
    const artwork = { id: uuid(), name, title, img, votes: 0, createdAt: new Date() };
    await gallery.insertOne(artwork);
    res.json({ id: artwork.id, success: true });
  } catch (e) { res.status(500).json({ error: "Échec sauvegarde" }); }
});

app.post('/api/vote', async (req, res) => { // Ajoute un vote
  try {
    if (!gallery) return res.status(503).json({ error: "DB non connectée" });
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "ID manquant" });
    await gallery.updateOne({ id }, { $inc: { votes: 1 } });
    const updated = await gallery.findOne({ id });
    res.json({ votes: updated ? updated.votes : 0 });
  } catch (e) { res.status(500).json({ error: "Erreur vote" }); }
});

// ─── GESTION DES FICHIERS STATIQUES ───

// 1. Rend accessible le dossier racine (pour index.html du portail)
app.use(express.static(path.join(__dirname))); 

// 2. Rend accessible le dossier de ton jeu Goldpixel
// Note : J'utilise 'Games' et 'Goldpixel' avec les majuscules comme tu me l'as dit
app.use('/gold-pixel', express.static(path.join(__dirname, 'Games/Goldpixel')));

// ─── ROUTES HTML (Affichage des pages) ───

// Route pour le Portail JeuxVideo.Pi (index.html à la racine)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Route pour lancer le jeu Gold Pixel
app.get('/gold-pixel', (req, res) => {
  res.sendFile(path.join(__dirname, 'Games/Goldpixel/goldpixel.html'));
});

// ─── LANCEMENT DU SERVEUR ───
server.listen(PORT, () => { // On utilise server.listen si tu as Socket.io (ou app.listen sinon)
  console.log(`🚀 Portail JeuxVideo.Pi en ligne sur le port ${PORT}`);
});
