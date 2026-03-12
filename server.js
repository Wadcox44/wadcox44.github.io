// --- CONFIGURATION DU SERVEUR GOLD PIXEL ---
const express = require('express'); // Importation d'Express pour gérer les requêtes
const path = require('path'); // Outil pour gérer les chemins de fichiers
const app = express(); // Création de l'application

// Note : Augmentation de la limite pour accepter les images en haute définition
app.use(express.json({ limit: '10mb' })); 
// Note : Rend les fichiers du dossier actuel accessibles (HTML, JS, CSS)
app.use(express.static(__dirname)); 

// Stockage en mémoire (sera réinitialisé lors du reset mensuel)
let galleryData = []; 

// --- ROUTES PRINCIPALES ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });

// --- API DE LA GALERIE ---

// Note : Récupérer toutes les œuvres
app.get('/api/gallery', (req, res) => { res.json(galleryData); });

// Note : Sauvegarder une nouvelle œuvre avec ID unique
app.post('/api/save', (req, res) => {
    const newArt = { 
        id: Date.now().toString(), // Identifiant unique pour la suppression
        name: req.body.name, 
        img: req.body.img, 
        votes: 0 // Compteur de likes initial
    };
    galleryData.push(newArt);
    res.status(200).send({ id: newArt.id });
});

// Note : Voter pour un chef-d'œuvre
app.post('/api/vote', (req, res) => {
    const art = galleryData.find(a => a.id === req.body.id);
    if (art) {
        art.votes++;
        res.status(200).send({ votes: art.votes });
    } else {
        res.status(404).send("Art introuvable");
    }
});

// Note : Supprimer uniquement sa propre œuvre
app.post('/api/delete', (req, res) => {
    galleryData = galleryData.filter(art => art.id !== req.body.id);
    res.status(200).send({ message: "Supprimé" });
});

// --- DÉMARRAGE ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Gold Pixel en ligne sur le port ${PORT}`);
});
