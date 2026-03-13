const express = require('express'); // Note : Framework pour gérer les requêtes
const path = require('path'); // Note : Gestion des chemins de fichiers
const { MongoClient } = require('mongodb'); // Note : Connexion Cloud MongoDB
const { v4: uuid } = require('uuid'); // Note : Pour les IDs uniques

const app = express(); // Note : Instance du serveur
const PORT = process.env.PORT || 10000; // Note : Port Render

// Note : SECURITE - On utilise la variable MONGO_URI de Render
const uri = process.env.MONGO_URI; 
const client = new MongoClient(uri);
let db, gallery;

async function connectDB() {
  try {
    if (!uri) { console.error("❌ Erreur : MONGO_URI manquante !"); return; }
    await client.connect();
    db = client.db("goldpixel_db"); // Note : Base de données
    gallery = db.collection("artworks"); // Note : Collection d'images
    console.log("✅ Gold Pixel est connecté au Cloud MongoDB !");
  } catch (e) { console.error("❌ Erreur connexion DB:", e); }
}
connectDB();

app.use(express.json({ limit: '15mb' })); // Note : Pour les images pixelisées
app.use(express.static(__dirname)); // Note : Sert les fichiers à la racine

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });

// Note : API Galerie - Récupère les œuvres
app.get('/api/gallery', async (req, res) => {
  try {
    const arts = await gallery.find({}).sort({createdAt: -1}).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json([]); }
});

// Note : API Sauvegarde - Enregistre l'œuvre avec pseudo et titre
app.post('/api/save', async (req, res) => {
  try {
    const { name, title, img } = req.body;
    const artwork = { id: uuid(), name, title, img, votes: 0, createdAt: new Date() };
    await gallery.insertOne(artwork);
    res.json({ id: artwork.id });
  } catch (e) { res.status(500).json({ error: "Échec" }); }
});

// Note : API Vote
app.post('/api/vote', async (req, res) => {
  const { id } = req.body;
  await gallery.updateOne({ id: id }, { $inc: { votes: 1 } });
  const art = await gallery.findOne({ id: id });
  res.json({ votes: art ? art.votes : 0 });
});

app.listen(PORT, () => { console.log(`🚀 Gold Pixel est prêt sur le port 10000`); });
