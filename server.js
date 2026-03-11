const express = require('express'); // Charge le module Express pour créer ton serveur web
const app = express(); // Initialise l'application Express pour ton portail JeuxVideo.Pi
const path = require('path'); // Module pour gérer les chemins de dossiers sans erreur

app.use(express.static(__dirname)); // Dit au serveur de rendre accessibles tous les dossiers (comme gold-pixel)

app.get('/', (req, res) => { // Quand on arrive sur l'URL racine de ton portail
    res.sendFile(path.join(__dirname, 'index.html')); // Envoie ton fichier d'accueil principal
});

app.get('/gold-pixel', (req, res) => { // Quand on veut jouer à Gold Pixel
    res.sendFile(path.join(__dirname, 'gold-pixel', 'index.html')); // Va chercher le jeu dans son dossier
});

const PORT = process.env.PORT || 3000; // Utilise le port du serveur ou le port 3000 par défaut
app.listen(PORT, () => { // Démarre officiellement le serveur
    console.log(`Le serveur de ton portail est lancé sur le port ${PORT}`); // Message de confirmation passionné
});
