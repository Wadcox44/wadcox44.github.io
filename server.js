const express = require('express'); // Note : Framework pour gérer les requêtes HTTP
const path = require('path'); // Note : Utilitaire pour les chemins de dossiers et fichiers
const { MongoClient } = require('mongodb'); // Note : Client officiel pour se connecter à MongoDB
const { v4: uuid } = require('uuid'); // Note : Module pour générer des identifiants uniques

const app = express(); // Note : Initialisation de l'application
const PORT = process.env.PORT || 10000; // Note : Port dynamique imposé par Render

// Note : UTILISE TON LIEN ICI (N'oublie pas de mettre ton vrai mot de passe !)
const uri = "mongodb+srv://thoneick:TON_MOT_DE_PASSE_ICI@goldpixel.g5fuvd8.mongodb.net/?appName=GoldPixel"; 
const client = new MongoClient(uri);
let db, gallery;

// Note : Fonction pour connecter le serveur à ta base de données Cloud
async function connectDB() {
  try {
    await client.connect();
    db = client.db("goldpixel_db"); // Note : Crée ou utilise la base nommée goldpixel_db
    gallery = db.collection("artworks"); // Note : Utilise la collection artworks pour les dessins
    console.log("✅ Gold Pixel est connecté au Cloud MongoDB !");
  } catch (e) { 
    console.error("❌ Erreur de connexion MongoDB :", e); 
  }
}
connectDB(); // Note : Lancement de la connexion

app.use(express.json({ limit: '15mb' })); // Note : Augmente la limite pour recevoir les images pixelisées
app.use(express.static(__dirname)); // Note : Sert les fichiers index.html et goldpixel.html depuis la racine

// Note : Route pour la page d'accueil (JeuxVideo.Pi)
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// Note : Route pour accéder au Studio de dessin
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });

// Note : API pour récupérer toutes les œuvres sauvegardées dans le Cloud
app.get('/api/gallery', async (req, res) => {
  try {
    const arts = await gallery.find({}).sort({createdAt: -1}).toArray();
    res.json(arts);
  } catch (e) { res.status(500).json({error: "Erreur lors du chargement de la galerie"}); }
});

// Note : API pour enregistrer un nouveau dessin dans MongoDB
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
  } catch (e) { res.status(500).json({error: "Erreur lors de la sauvegarde"}); }
});

// Note : API pour gérer les votes (incrémentation de 1)
app.post('/api/vote', async (req, res) => {
  try {
    const { id } = req.body;
    await gallery.updateOne({ id: id }, { $inc: { votes: 1 } });
    const art = await gallery.findOne({ id: id });
    res.json({ votes: art ? art.votes : 0 });
  } catch (e) { res.status(500).json({error: "Erreur de vote"}); }
});

// Note : Démarrage du serveur
app.listen(PORT, () => { 
  console.log(`🚀 Gold Pixel Studio est prêt sur le port ${PORT}`); 
});
