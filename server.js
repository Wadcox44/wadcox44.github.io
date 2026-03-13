const express = require('express'); // Note : Framework serveur
const path = require('path'); // Note : Chemins de fichiers
const { MongoClient } = require('mongodb'); // Note : Driver pour MongoDB
const { v4: uuid } = require('uuid'); // Note : IDs uniques

const app = express(); // Note : Instance Express
const PORT = process.env.PORT || 10000; // Note : Port Render

// Note : REMPLACE CETTE LIGNE par ton lien MongoDB Atlas (garde les guillemets)
const uri = "TON_LIEN_MONGODB_ICI"; 
const client = new MongoClient(uri);
let db, gallery;

async function connectDB() {
  try {
    await client.connect();
    db = client.db("goldpixel_db"); // Note : Nom de la base
    gallery = db.collection("artworks"); // Note : Nom de la collection
    console.log("✅ Connecté à MongoDB Atlas !");
  } catch (e) { console.error("❌ Erreur connexion DB:", e); }
}
connectDB();

app.use(express.json({ limit: '15mb' })); // Note : Pour les images HD
app.use(express.static(__dirname)); // Note : Sert les fichiers racines

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });

// Note : Récupérer la galerie depuis le cloud
app.get('/api/gallery', async (req, res) => {
  try {
    const arts = await gallery.find({}).toArray();
    res.json(arts);
  } catch (e) { res.status(500).send(e); }
});

// Note : Sauvegarder dans le cloud
app.post('/api/save', async (req, res) => {
  const { name, title, img } = req.body;
  const artwork = { 
    id: uuid(), 
    name: String(name).slice(0, 20), 
    title: String(title).slice(0, 30), 
    img, 
    votes: 0, 
    createdAt: new Date().toISOString() 
  };
  await gallery.insertOne(artwork);
  res.json({ id: artwork.id });
});

// Note : Voter dans le cloud
app.post('/api/vote', async (req, res) => {
  const { id } = req.body;
  await gallery.updateOne({ id: id }, { $inc: { votes: 1 } });
  const art = await gallery.findOne({ id: id });
  res.json({ votes: art.votes });
});

// Note : Supprimer du cloud
app.post('/api/delete', async (req, res) => {
  const { id } = req.body;
  await gallery.deleteOne({ id: id });
  res.json({ ok: true });
});

app.listen(PORT, () => { console.log(`🚀 Gold Pixel Studio sur port ${PORT}`); });
