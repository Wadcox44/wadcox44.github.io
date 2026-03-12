const express = require('express'); // Note : Framework Express
const path = require('path'); // Note : Gestion des chemins fichiers
const app = express(); // Note : Instance du serveur Gold Pixel

// Note : Limite augmentée à 50mb pour supporter les changements de formats
app.use(express.json({ limit: '50mb' })); 
app.use(express.static(__dirname)); 

// Note : Notre base de données en mémoire vive
let galleryData = []; 

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });

// API : Récupérer les œuvres (Note : Ajout d'un log pour vérifier les appels)
app.get('/api/gallery', (req, res) => { 
    console.log(`Envoi de la galerie : ${galleryData.length} œuvres stockées.`);
    res.json(galleryData); 
});

// API : Sauvegarder
app.post('/api/save', (req, res) => {
    if(!req.body.img) return res.status(400).send("Image manquante");
    
    const newArt = { 
        id: Date.now().toString(), 
        name: req.body.name || "Pionnier", 
        img: req.body.img, 
        votes: 0 
    };
    
    galleryData.push(newArt);
    console.log(`Nouvelle œuvre de ${newArt.name} enregistrée !`);
    res.status(200).send({ id: newArt.id });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gold Pixel Studio prêt sur http://localhost:${PORT}`));
