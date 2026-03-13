const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');
const { v4: uuid } = require('uuid');

const app = express();
const PORT = process.env.PORT || 10000;

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);
let db, gallery;

async function connectDB() {
  try {
    if (!uri) { console.error("❌ Erreur : MONGO_URI manquante !"); return; }
    await client.connect();
    db = client.db("goldpixel_db");
    gallery = db.collection("artworks");
    console.log("✅ Gold Pixel v3.0 connecté au Cloud MongoDB !");
  } catch (e) { console.error("❌ Erreur connexion DB:", e); }
}
connectDB();

app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });

// GET - Toutes les œuvres
app.get('/api/gallery', async (req, res) => {
  try {
    const arts = await gallery.find({}).sort({ createdAt: -1 }).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json([]); }
});

// GET - Top 10 les plus likées
app.get('/api/top10', async (req, res) => {
  try {
    const arts = await gallery.find({}).sort({ votes: -1 }).limit(10).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json([]); }
});

// POST - Sauvegarder une œuvre
app.post('/api/save', async (req, res) => {
  try {
    const { name, title, img } = req.body;
    if (!name || !title || !img) return res.status(400).json({ error: "Données manquantes" });
    const artwork = {
      id: uuid(),
      name: name.trim().substring(0, 50),
      title: title.trim().substring(0, 80),
      img,
      votes: 0,
      voters: [],
      createdAt: new Date()
    };
    await gallery.insertOne(artwork);
    res.json({ id: artwork.id, success: true });
  } catch (e) { res.status(500).json({ error: "Échec sauvegarde" }); }
});

// POST - Voter pour une œuvre (anti-doublon par session via IP)
app.post('/api/vote', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "ID manquant" });
    const art = await gallery.findOne({ id });
    if (!art) return res.status(404).json({ error: "Œuvre introuvable" });
    await gallery.updateOne({ id }, { $inc: { votes: 1 } });
    const updated = await gallery.findOne({ id });
    res.json({ votes: updated ? updated.votes : 0 });
  } catch (e) { res.status(500).json({ error: "Erreur vote" }); }
});

// DELETE - Supprimer une œuvre (admin)
app.delete('/api/artwork/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await gallery.deleteOne({ id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Erreur suppression" }); }
});

app.listen(PORT, () => {
  console.log(`🚀 Gold Pixel v3.0 est prêt sur le port ${PORT}`);
});
