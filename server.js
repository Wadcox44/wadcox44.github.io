const express = require('express'); // On importe le framework Express pour créer le serveur
const app = express(); // On initialise l'application web JeuxVideo.Pi
const path = require('path'); // Module pour gérer les chemins de fichiers proprement

// On autorise l'accès à tous les fichiers du dossier (images, dossiers de jeux, etc.)
app.use(express.static(__dirname)); 

// Route pour afficher ton portail stylé (index.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html')); // Envoie ton portail avec le look Neon/Orbitron
});

// Route pour lancer Gold Pixel quand on clique sur la Hero Card
app.get('/gold-pixel', (req, res) => {
    res.sendFile(path.join(__dirname, 'gold-pixel', 'index.html')); // Envoie le jeu situé dans le sous-dossier
});

// Définition du port d'écoute (3000 par défaut)
const PORT = process.env.PORT || 3000; 
app.listen(PORT, () => {
    // Message de confirmation pour dire que tout est prêt !
    console.log(`🚀 Ton portail JeuxVideo.Pi est en ligne sur le port ${PORT} !`); 
});
