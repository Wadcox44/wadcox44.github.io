// Importation des outils de base
const express = require('express'); // Charge Express pour gérer les routes du portail
const app = express(); // Initialise l'application web
const path = require('path'); // Module pour gérer les chemins de fichiers proprement

// Configuration de l'accès aux fichiers
app.use(express.static(__dirname)); // Rend tous les fichiers du dossier racine accessibles (images, css)

// Route d'accueil
app.get('/', (req, res) => { // Définit ce qui se passe quand on arrive sur l'URL de base
    res.sendFile(path.join(__dirname, 'index.html')); // Envoie ton fichier index.html Cyberpunk
});

// Lancement du serveur du portail
const PORT = process.env.PORT || 3000; // Utilise le port 3000 ou celui de l'hébergeur
app.listen(PORT, () => { // Démarre l'écoute du serveur
    console.log(`Le Portail JeuxVideo.Pi est en ligne sur le port ${PORT}`); // Message de confirmation passionné
});
