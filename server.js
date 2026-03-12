const express = require('express');
const path = require('path');
const app = express();

// Note : On autorise des fichiers plus lourds pour les dessins détaillés
app.use(express.json({ limit: '10mb' })); 
app.use(express.static(__dirname)); 

// Note : La base de données temporaire pour la session actuelle
let galleryData = []; 

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });

// API : Récupérer les œuvres
app.get('/api/gallery', (req, res) => { res.json(galleryData); });

// API : Sauvegarder
app.post('/api/save', (req, res) => {
    const newArt = { 
        id: Date.now().toString(),
        name: req.body.name, 
        img: req.body.img, 
        votes: 0 
    };
    galleryData.push(newArt);
    res.status(200).send({ id: newArt.id });
});

// API : Voter
app.post('/api/vote', (req, res) => {
    const art = galleryData.find(a => a.id === req.body.id);
    if (art) { art.votes++; res.status(200).send({ votes: art.votes }); }
    else { res.status(404).send("Introuvable"); }
});

// API : Supprimer
app.post('/api/delete', (req, res) => {
    galleryData = galleryData.filter(art => art.id !== req.body.id);
    res.status(200).send({ message: "Supprimé" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gold Pixel Studio sur le port ${PORT}`));
