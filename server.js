// --- IMPORTATION DES OUTILS DE BASE ---
const express = require('express'); // Charge Express pour gérer les routes du portail
const path = require('path'); // Module pour gérer les chemins de fichiers proprement
const app = express(); // Initialise l'application web

// --- MIDDLEWARES DE CONFIGURATION ---
// Note : Permet au serveur de lire les données JSON envoyées par le jeu (images, votes)
// On met une limite à 5mb pour que les dessins haute définition passent sans souci !
app.use(express.json({ limit: '5mb' })); 

// Note : Rend tous les fichiers du dossier racine accessibles (CSS, JS, etc.)
app.use(express.static(__dirname)); 

// Note : Force l'accès au dossier Images (avec majuscule) pour tes visuels passionnés
app.use('/Images', express.static(path.join(__dirname, 'Images')));

// --- BASE DE DONNÉES TEMPORAIRE (Mémoire vive) ---
// Note : En attendant une vraie DB, on stocke les œuvres de la saison ici
let galleryData = []; 

// --- ROUTES DU PORTAIL ---

// Route d'accueil (Index)
app.get('/', (req, res) => { 
    res.sendFile(path.join(__dirname, 'index.html')); 
});

// Route spécifique pour Gold Pixel
app.get('/goldpixel', (req, res) => {
    res.sendFile(path.join(__dirname, 'goldpixel.html'));
});

// --- API GOLD PIXEL (Le moteur du jeu) ---

// Note : Récupérer toutes les œuvres de la Galerie des Saisons
app.get('/api/gallery', (req, res) => {
    res.json(galleryData);
});

// Note : Sauvegarder un nouveau dessin (coût : 1 Pi en théorie)
app.post('/api/save', (req, res) => {
    const newArt = { 
        id: Date.now(), 
        name: req.body.name, 
        img: req.body.img, 
        votes: 0 
    };
    galleryData.push(newArt);
    console.log(`🎨 Nouvelle œuvre ajoutée par @${newArt.name}`);
    res.status(200).send({ message: "Chef-d'œuvre enregistré !" });
});

// Note : Système de vote pour les œuvres préférées des Pionniers
app.post('/api/vote', (req, res) => {
    const id = req.body.id;
    const art = galleryData.find(a => a.id === id);
    if (art) {
        art.votes++;
        res.status(200).send({ votes: art.votes });
    } else {
        res.status(404).send({ message: "Œuvre non trouvée" });
    }
});

// --- LANCEMENT DU SERVEUR ---
const PORT = process.env.PORT || 3000; 
app.listen(PORT, () => { 
    console.log(`🚀 Le Portail JeuxVideo.Pi est en ligne sur le port ${PORT}`); 
    console.log(`✨ Prêt pour le Grand Nettoyage du dernier week-end du mois !`);
});
