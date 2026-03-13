const express = require('express'); // Note : Framework web
const path = require('path'); // Note : Gestion des chemins
const { MongoClient } = require('mongodb'); // Note : Client MongoDB Cloud
const { v4: uuid } = require('uuid'); // Note : Identifiants uniques

const app = express(); // Note : Instance serveur
const PORT = process.env.PORT || 10000; // Note : Port Render

// Note : PROTECTION ACTIVÉE. On utilise la variable d'environnementMONGO_URI définie sur Render.
const uri = process.env.MONGO_URI; 
const client = new MongoClient(uri);
let db, gallery;

async function connectDB() {
  try {
    // Note : On vérifie si la variable est bien présente pour éviter les plantages
    if (!uri) {
      console.error("❌ Erreur : La variable MONGO_URI n'est pas définie sur Render !");
      return;
    }
    await client.connect();
    db = client.db("goldpixel_db"); // Note : Nom de ta base
    gallery = db.collection("artworks"); // Note : Ta collection d'images
    console.log("✅ Gold Pixel est connecté au Cloud MongoDB (Mode Sécurisé) !");
  } catch (e) { 
    console.error("❌ Erreur de connexion Cloud :", e); 
  }
}
connectDB();

app.use(express.json({ limit: '15mb' })); // Note : Pour les gros pixels
app.use(express.static(__dirname)); // Note : Sert index.html et goldpixel.html

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });

app.get('/api/gallery', async (req, res) => {
  try {
    const arts = await gallery.find({}).sort({createdAt: -1}).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json([]); }
});

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

app.post('/api/vote', async (req, res) => {
  const { id } = req.body;
  await gallery.updateOne({ id: id }, { $inc: { votes: 1 } });
  const art = await gallery.findOne({ id: id });
  res.json({ votes: art ? art.votes : 0 });
});

app.listen(PORT, () => { 
  console.log(`🚀 Gold Pixel Studio tourne sur le port ${PORT}`); 
});
