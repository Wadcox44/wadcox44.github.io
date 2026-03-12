// --- IMPORTATION DES OUTILS DE BASE ---
const express = require('express'); // Charge Express pour gérer les routes du portail
const path = require('path'); // Module pour gérer les chemins de fichiers proprement
const app = express(); // Initialise l'application web

// --- CONFIGURATION DE L'ACCÈS AUX FICHIERS ---
// Note : Rend tous les fichiers du dossier racine accessibles (CSS, JS)
app.use(express.static(__dirname)); 

// Note : Force l'accès au dossier Images (avec majuscule) pour tes visuels Gold Pixel
app.use('/Images', express.static(path.join(__dirname, 'Images')));

// --- ROUTES DU PORTAIL ---

// Route d'accueil (Index)
app.get('/', (req, res) => { 
    // Note : Définit ce qui se passe quand on arrive sur l'URL de base
    res.sendFile(path.join(__dirname, 'index.html')); 
});

// Route spécifique pour Gold Pixel
app.get('/goldpixel', (req, res) => {
    // Note : Redirige vers la page du jeu quand on clique sur ta "Hero Card"
    res.sendFile(path.join(__dirname, 'goldpixel.html'));
});

// --- LANCEMENT DU SERVEUR ---
const PORT = process.env.PORT || 3000; // Utilise le port 3000 ou celui de Render
app.listen(PORT, () => { 
    // Note : Message de confirmation passionné dans tes logs
    console.log(`🚀 Le Portail JeuxVideo.Pi est en ligne sur le port ${PORT}`); 
});
