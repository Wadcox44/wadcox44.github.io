const express = require('express'); // Importe Express pour ton portail
const path = require('path'); // Module pour naviguer dans les dossiers
const { MongoClient } = require('mongodb'); // Client pour ton tout nouveau MongoDB
const { v4: uuid } = require('uuid'); // Générateur d'ID pour la galerie

const app = express(); // Création de l'application
const PORT = process.env.PORT || 10000; // Port utilisé par Render

// L'URL de connexion sera celle que tu as mise dans l'onglet Environment de Render
const uri = process.env.MONGO_URI; 
const client = new MongoClient(uri); 
let db, gallery;

async function connectDB() { 
  try {
    if (!uri) { 
      console.error("❌ Erreur : La variable MONGO_URI est vide sur Render !"); 
      return; 
    }
    await client.connect(); 
    
    // ON UTILISE TA NOUVELLE BASE TOUTE NEUVE ICI
    db = client.db("jeuxvideo_db"); 
    gallery = db.collection("artworks"); 
    
    console.log("✅ Système JeuxVideo.Pi connecté avec succès au nouveau Cluster !");
  } catch (e) { 
    console.error("❌ Erreur de connexion à la base de données :", e); 
  }
}
connectDB(); // Allumage de la connexion

// ─── CORS (Pour que le site puisse parler au serveur) ───
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── MIDDLEWARES ───
app.use(express.json({ limit: '20mb' })); // Pour accepter les images de la galerie
app.use(express.urlencoded({ extended: true }));

// ─── ROUTES API (Galerie, Votes, etc.) ───
app.get('/api/gallery', async (req, res) => {
  try {
    if (!gallery) return res.status(503).json([]);
    const arts = await gallery.find({}).sort({ createdAt: -1 }).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json([]); }
});

app.post('/api/save', async (req, res) => {
  try {
    const { name, title, img } = req.body;
    const artwork = { id: uuid(), name, title, img, votes: 0, createdAt: new Date() };
    await gallery.insertOne(artwork);
    res.json({ id: artwork.id, success: true });
  } catch (e) { res.status(500).json({ error: "Erreur sauvegarde" }); }
});

// ─── GESTION DES FICHIERS STATIQUES ───

// Sert le portail JeuxVideo.Pi (index.html à la racine)
app.use(express.static(path.join(__dirname))); 

// Sert le jeu Gold Pixel (Dossier Games/Goldpixel)
// C'est ici que la magie opère pour trouver ton fichier goldpixel.html
app.use('/gold-pixel', express.static(path.join(__dirname, 'Games/Goldpixel')));

// ─── ROUTES HTML ───

// Page d'accueil (Le Portail)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Page du jeu (Quand on clique sur le bouton)
app.get('/gold-pixel', (req, res) => {
  res.sendFile(path.join(__dirname, 'Games/Goldpixel/goldpixel.html'));
});

// ─── LANCEMENT ───
app.listen(PORT, () => {
  console.log(`🚀 Portail JeuxVideo.Pi en ligne sur le port ${PORT}`);
});
