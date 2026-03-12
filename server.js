// Importation des outils de base
const express = require('express'); // Charge Express pour gérer les routes du portail
const app = express(); // Initialise l'application web
const path = require('path'); // Module pour gérer les chemins de fichiers proprement

// --- NOUVEAU : Configuration pour recevoir les données des dessins ---
app.use(express.json({ limit: '5mb' })); // Autorise le serveur à recevoir du texte lourd (images en Base64)
app.use(express.static(__dirname)); // Rend tous les fichiers du dossier racine accessibles (images, css)

// --- NOUVEAU : Mémoire temporaire pour la Galerie des Saisons ---
let gallery = []; // Crée une liste vide pour stocker les œuvres et les votes dans la RAM du serveur

// Route d'accueil
app.get('/', (req, res) => { // Définit ce qui se passe quand on arrive sur l'URL de base
    res.sendFile(path.join(__dirname, 'index.html')); // Envoie ton fichier index.html Cyberpunk
});

// --- NOUVEAU : Route pour le jeu Gold Pixel ---
app.get('/goldpixel', (req, res) => { // Définit l'accès direct à la page du jeu
    res.sendFile(path.join(__dirname, 'goldpixel.html')); // Envoie le fichier du jeu Gold Pixel Lite
});

// --- NOUVEAU : Routes API pour faire parler le jeu avec le serveur ---

app.get('/api/gallery', (req, res) => { // Route pour que le jeu demande la liste des œuvres
    res.json(gallery); // Le serveur renvoie la liste complète au format JSON
});

app.post('/api/save', (req, res) => { // Route pour recevoir une nouvelle œuvre créée
    const newArt = { // Crée un objet structuré pour l'œuvre
        id: Date.now(), // Utilise l'heure précise comme identifiant unique
        name: req.body.name, // Récupère le pseudo envoyé par le joueur
        img: req.body.img, // Récupère l'image envoyée par le joueur
        votes: 0 // Initialise le compteur de votes à zéro
    };
    gallery.unshift(newArt); // Ajoute cette œuvre tout en haut de la liste
    res.json({ success: true }); // Confirme au jeu que l'enregistrement a réussi
});

app.post('/api/vote', (req, res) => { // Route pour enregistrer un vote (+1)
    const artId = req.body.id; // Récupère l'ID de l'œuvre qui a reçu un vote
    const art = gallery.find(a => a.id === artId); // Cherche l'œuvre correspondante dans la liste
    if (art) { // Si l'œuvre existe bien...
        art.votes += 1; // On ajoute 1 à son score de votes
        res.json({ success: true, newVotes: art.votes }); // On renvoie le nouveau score au jeu
    } else { // Si l'œuvre n'est pas trouvée...
        res.status(404).send("Œuvre introuvable"); // On renvoie une erreur 404
    }
});

// Lancement du serveur du portail
const PORT = process.env.PORT || 3000; // Utilise le port 3000 ou celui de l'hébergeur (Render)
app.listen(PORT, () => { // Démarre l'écoute du serveur
    console.log(`Le Portail JeuxVideo.Pi est en ligne sur le port ${PORT}`); // Message de confirmation passionné
    console.log(`Système Gold Pixel Lite : Activé`); // Confirmation que la mémoire de la galerie est prête
});
