const express = require('express');
const path = require('path');
const app = express();

app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname));

let galleryData = []; 

// API : Sauvegarder avec un ID unique
app.post('/api/save', (req, res) => {
    const newArt = { 
        id: Date.now().toString(),
        name: req.body.name, 
        img: req.body.img, 
        votes: 0 // Initialisation des votes
    };
    galleryData.push(newArt);
    res.status(200).send({ id: newArt.id }); // On renvoie l'ID au joueur
});

// API : Voter pour une œuvre
app.post('/api/vote', (req, res) => {
    const art = galleryData.find(a => a.id === req.body.id);
    if (art) {
        art.votes++;
        res.status(200).send({ votes: art.votes });
    } else {
        res.status(404).send("Introuvable");
    }
});

// API : Supprimer
app.post('/api/delete', (req, res) => {
    galleryData = galleryData.filter(art => art.id !== req.body.id);
    res.status(200).send({ message: "Supprimé" });
});

app.get('/api/gallery', (req, res) => { res.json(galleryData); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur Gold Pixel actif sur ${PORT}`));
