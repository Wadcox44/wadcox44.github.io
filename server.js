const express = require('express'); // Note : Framework pour gérer le serveur
const path = require('path'); // Note : Utilitaire pour les chemins de fichiers
const { MongoClient } = require('mongodb'); // Note : Driver pour MongoDB Cloud
const { v4: uuid } = require('uuid'); // Note : Pour générer des IDs uniques

const app = express(); // Note : Instance Express
const PORT = process.env.PORT || 10000; // Note : Port pour Render

// Note : SECURITE - Utilise la variable d'environnement MONGO_URI définie sur Render
const uri = process.env.MONGO_URI; 
const client = new MongoClient(uri);
let db, gallery;

async function connectDB() {
  try {
    if (!uri) { console.error("❌ Erreur : MONGO_URI non définie sur Render !"); return; }
    await client.connect();
    db = client.db("goldpixel_db"); // Note : Nom de la base de données
    gallery = db.collection("artworks"); // Note : Collection des œuvres
    console.log("✅ Gold Pixel est connecté au Cloud MongoDB !");
  } catch (e) { console.error("❌ Erreur connexion DB:", e); }
}
connectDB();

app.use(express.json({ limit: '15mb' })); // Note : Pour les images haute définition
app.use(express.static(__dirname)); // Note : Sert les fichiers à la racine

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });

// Note : API Galerie - Récupère les œuvres triées par date
app.get('/api/gallery', async (req, res) => {
  try {
    const arts = await gallery.find({}).sort({createdAt: -1}).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json([]); }
});

// Note : API Sauvegarde - Enregistre l'œuvre dans le Cloud
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
  } catch (e) { res.status(500).json({ error: "Échec sauvegarde" }); }
});

// Note : API Vote
app.post('/api/vote', async (req, res) => {
  const { id } = req.body;
  await gallery.updateOne({ id: id }, { $inc: { votes: 1 } });
  const art = await gallery.findOne({ id: id });
  res.json({ votes: art ? art.votes : 0 });
});

app.listen(PORT, () => { console.log(`🚀 Gold Pixel Studio en ligne sur le port ${PORT}`); });
