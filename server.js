const express = require('express'); // Note : Framework pour gérer le serveur
const path = require('path'); // Note : Utilitaire pour les dossiers
const { MongoClient } = require('mongodb'); // Note : Connexion Cloud MongoDB
const { v4: uuid } = require('uuid'); // Note : Identifiants uniques pour les œuvres

const app = express(); // Note : Instance du serveur
const PORT = process.env.PORT || 10000; // Note : Port Render

// Note : SECURITE - Lien récupéré via les variables d'environnement Render
const uri = process.env.MONGO_URI; 
const client = new MongoClient(uri);
let db, gallery;

async function connectDB() {
  try {
    if (!uri) { console.error("❌ Erreur : MONGO_URI manquante !"); return; }
    await client.connect();
    db = client.db("goldpixel_db"); // Note : Nom de la base de données
    gallery = db.collection("artworks"); // Note : Collection des œuvres
    console.log("✅ Gold Pixel est connecté au Cloud MongoDB !");
  } catch (e) { console.error("❌ Erreur connexion DB:", e); }
}
connectDB();

app.use(express.json({ limit: '15mb' })); // Note : Pour les images pixelisées
app.use(express.static(__dirname)); // Note : Sert les fichiers racine

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });

// Note : API GALERIE - Récupère toutes les oeuvres sauvegardées
app.get('/api/gallery', async (req, res) => {
  try {
    const arts = await gallery.find({}).sort({createdAt: -1}).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json([]); }
});

// Note : API SAUVEGARDE - Enregistre pseudo, titre, image et votes
app.post('/api/save', async (req, res) => {
  try {
    const { name, title, img } = req.body;
    const artwork = { 
      id: uuid(), 
      name: name || "Anonyme", 
      title: title || "Sans titre", 
      img, 
      votes: 0, 
      createdAt: new Date() 
    };
    await gallery.insertOne(artwork);
    res.json({ id: artwork.id });
  } catch (e) { res.status(500).json({ error: "Échec" }); }
});

// Note : API VOTE - Incrémente le compteur de 1 dans MongoDB
app.post('/api/vote', async (req, res) => {
  const { id } = req.body;
  await gallery.updateOne({ id: id }, { $inc: { votes: 1 } });
  const art = await gallery.findOne({ id: id });
  res.json({ votes: art ? art.votes : 0 });
});

app.listen(PORT, () => { console.log(`🚀 Gold Pixel Studio en ligne sur le port ${PORT}`); });
