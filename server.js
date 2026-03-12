const express = require('express'); // Note : Importe le framework Express pour gérer les routes
const path = require('path'); // Note : Module natif pour gérer les chemins de fichiers
const app = express(); // Note : Initialise l'application serveur

// Note : On augmente la limite de réception pour les images HD du canevas
app.use(express.json({ limit: '50mb' })); 
app.use(express.static(__dirname)); // Note : Rend les fichiers locaux accessibles (HTML, CSS, JS)

let galleryData = []; // Note : Stockage temporaire des œuvres en mémoire vive

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });

// Note : Route pour envoyer la liste des œuvres avec en-tête anti-cache
app.get('/api/gallery', (req, res) => { 
    res.setHeader('Cache-Control', 'no-store'); 
    res.json(galleryData); 
});

// Note : Route pour enregistrer une nouvelle œuvre
app.post('/api/save', (req, res) => {
    const newArt = { 
        id: Date.now().toString(), 
        name: req.body.name, 
        img: req.body.img, 
        votes: 0 
    };
    galleryData.push(newArt);
    res.status(200).send({ success: true, id: newArt.id });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gold Pixel Studio actif : http://localhost:${PORT}`));
