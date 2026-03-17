const express = require('express'); // Importation du framework Express pour créer le serveur web
const path = require('path'); // Module pour gérer les chemins de fichiers et dossiers
const { MongoClient } = require('mongodb'); // Client pour se connecter à ta base de données Cloud MongoDB
const { v4: uuid } = require('uuid'); // Pour générer des identifiants uniques (utilisé pour la galerie)

const app = express(); // Initialisation de l'application Express
const PORT = process.env.PORT || 10000; // Définition du port (celui de Render ou 10000 par défaut)

const uri = process.env.MONGO_URI; // RÉCUPÉRATION DE TA VARIABLE SECRÈTE DEPUIS RENDER (C'est ici que le _ est crucial !)
const client = new MongoClient(uri); // Création du client de connexion avec ton lien secret
let db, gallery; // Déclarations des variables pour la base de données et la collection

async function connectDB() { // Fonction asynchrone pour établir la connexion
  try {
    if (!uri) { // Vérification si la variable est bien présente
        console.error("❌ Erreur : La variable MONGO_URI est vide sur Render !"); 
        return; 
    }
    await client.connect(); // Tentative de connexion au Cluster MongoDB Atlas
    db = client.db("jeuxvideo_db"); // Sélection de ta nouvelle base de données "jeuxvideo_db"
    gallery = db.collection("artworks"); // Sélection de la collection pour stocker les images
    console.log("✅ Système JeuxVideo.Pi connecté avec succès au nouveau Cluster !"); // Message de succès dans les logs
  } catch (e) {
    console.error("❌ Erreur de connexion à la base de données :", e); // Message d'erreur si la connexion échoue
  }
}
connectDB(); // Appel de la fonction de connexion au démarrage du serveur

// Configuration des CORS pour autoriser les navigateurs à communiquer avec le serveur
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*'); // Autorise toutes les origines
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS'); // Autorise ces méthodes HTTP
  res.header('Access-Control-Allow-Headers', 'Content-Type'); // Autorise le format JSON
  if (req.method === 'OPTIONS') return res.sendStatus(200); // Réponse rapide pour les requêtes de pré-vérification
  next();
});

app.use(express.json({ limit: '20mb' })); // Permet au serveur de lire le format JSON (max 20 Mo pour les images)
app.use(express.urlencoded({ extended: true })); // Permet de lire les données de formulaires classiques

// --- ROUTES API ---

app.get('/api/gallery', async (req, res) => { // Route pour récupérer les images de la galerie
  try {
    if (!gallery) return res.status(503).json([]); // Sécurité si la base n'est pas encore connectée
    const arts = await gallery.find({}).sort({ createdAt: -1 }).toArray(); // Récupère tout, du plus récent au plus ancien
    res.json(arts); // Envoie la liste des images au format JSON
  } catch (e) { res.status(500).json([]); }
});

app.post('/api/save', async (req, res) => { // Route pour enregistrer un nouveau dessin
  try {
    const { name, title, img } = req.body; // Récupère le nom, le titre et l'image envoyés par le jeu
    const artwork = { id: uuid(), name, title, img, votes: 0, createdAt: new Date() }; // Prépare l'objet à enregistrer
    await gallery.insertOne(artwork); // Insère le dessin dans la base MongoDB
    res.json({ id: artwork.id, success: true }); // Confirme le succès au joueur
  } catch (e) { res.status(500).json({ error: "Erreur sauvegarde" }); }
});

// --- GESTION DES FICHIERS STATIQUES ---

app.use(express.static(path.join(__dirname))); // Rend accessible tous les fichiers à la racine (comme index.html)
app.use('/gold-pixel', express.static(path.join(__dirname, 'Games/Goldpixel'))); // Rend accessible le dossier du jeu

// --- ROUTES HTML ---

app.get('/', (req, res) => { // Route principale qui affiche le portail
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/gold-pixel', (req, res) => { // Route qui affiche la page du jeu Gold Pixel
  res.sendFile(path.join(__dirname, 'Games/Goldpixel/goldpixel.html'));
});

app.listen(PORT, () => { // Démarrage officiel du serveur
  console.log(`🚀 Empire JeuxVideo.Pi en ligne sur le port ${PORT}`);
});
