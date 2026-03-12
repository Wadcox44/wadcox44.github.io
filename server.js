const express = require('express'); // Note : Framework Express
const path = require('path'); // Note : Gestion des chemins de fichiers
const fs = require('fs'); // Note : Manipulation du système de fichiers
const app = express(); // Note : Instance du serveur Gold Pixel

app.use(express.json({ limit: '50mb' })); 
app.use(express.static(__dirname)); 
app.use('/gallery', express.static(path.join(__dirname, 'gallery'))); 

// Note : Création automatique du dossier s'il manque
const dir = './gallery';
if (!fs.existsSync(dir)) fs.mkdirSync(dir);

let galleryData = []; // Note : Base de données temporaire

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });
app.get('/api/gallery', (req, res) => { res.json(galleryData); });

// Note : Route pour SAUVEGARDER
app.post('/api/save', (req, res) => {
    const { name, img } = req.body;
    const id = Date.now().toString();
    const fileName = `art_${id}.jpg`;
    const filePath = path.join(__dirname, 'gallery', fileName);
    const base64Data = img.replace(/^data:image\/jpeg;base64,/, "");

    fs.writeFile(filePath, base64Data, 'base64', (err) => {
        if (err) return res.status(500).send("Erreur écriture");
        const newArt = { id, name: name || "Artiste", img: `/gallery/${fileName}`, fileName };
        galleryData.push(newArt);
        res.status(200).send({ success: true, id: id });
    });
});

// Note : Route pour SUPPRIMER (Vérifie si le fichier existe avant)
app.post('/api/delete', (req, res) => {
    const { id } = req.body;
    const artIndex = galleryData.findIndex(a => a.id === id);
    if (artIndex === -1) return res.status(404).send("Introuvable");

    const art = galleryData[artIndex];
    const filePath = path.join(__dirname, 'gallery', art.fileName);

    fs.unlink(filePath, (err) => {
        if (err) console.log("Fichier déjà supprimé physiquement");
        galleryData.splice(artIndex, 1); // Note : Retire de la liste
        res.status(200).send({ success: true });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Studio prêt sur le port ${PORT}`));
