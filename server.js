const express = require('express'); // Note : Framework pour gérer le serveur
const path = require('path'); // Note : Pour gérer les dossiers et fichiers
const fs = require('fs'); // Note : Module File System pour écrire sur le disque
const app = express(); // Note : Initialise l'application Gold Pixel

app.use(express.json({ limit: '50mb' })); // Note : Supporte les images haute définition
app.use(express.static(__dirname)); // Note : Rend le dossier racine accessible
app.use('/gallery', express.static(path.join(__dirname, 'gallery'))); // Note : Accès public aux images sauvegardées

// Note : Crée le dossier "gallery" s'il est absent
const dir = './gallery';
if (!fs.existsSync(dir)) fs.mkdirSync(dir);

let galleryData = []; // Note : Stockage temporaire des infos de la galerie

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });
app.get('/api/gallery', (req, res) => { res.json(galleryData); });

// Note : Sauvegarde physique de l'image
app.post('/api/save', (req, res) => {
    const { name, img } = req.body;
    const id = Date.now().toString();
    const fileName = `art_${id}.jpg`;
    const filePath = path.join(__dirname, 'gallery', fileName);
    const base64Data = img.replace(/^data:image\/jpeg;base64,/, "");

    fs.writeFile(filePath, base64Data, 'base64', (err) => {
        if (err) return res.status(500).send("Erreur d'écriture");
        const newArt = { id, name: name || "Artiste", img: `/gallery/${fileName}`, fileName };
        galleryData.push(newArt);
        res.status(200).send({ success: true, id: id });
    });
});

// Note : Suppression physique et logique
app.post('/api/delete', (req, res) => {
    const { id } = req.body;
    const idx = galleryData.findIndex(a => a.id === id);
    if (idx !== -1) {
        const art = galleryData[idx];
        const filePath = path.join(__dirname, 'gallery', art.fileName);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        galleryData.splice(idx, 1);
        res.status(200).send({ success: true });
    } else { res.status(404).send("Non trouvé"); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gold Pixel Studio opérationnel sur le port ${PORT}`));
