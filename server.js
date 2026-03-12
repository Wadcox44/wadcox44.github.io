const express = require('express'); // Note : Framework pour le serveur
const path = require('path'); // Note : Gestion des dossiers
const fs = require('fs'); // Note : Écriture des fichiers JPG
const app = express(); 

app.use(express.json({ limit: '50mb' })); // Note : Pour recevoir les images
app.use(express.static(__dirname)); 
app.use('/gallery', express.static(path.join(__dirname, 'gallery'))); // Note : Accès aux images

// Note : Création du dossier gallery s'il n'existe pas
const dir = './gallery';
if (!fs.existsSync(dir)) fs.mkdirSync(dir);

let galleryData = []; // Note : Mémoire vive des œuvres

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });

// Note : API pour récupérer la liste
app.get('/api/gallery', (req, res) => { res.json(galleryData); });

// Note : API pour SAUVEGARDER
app.post('/api/save', (req, res) => {
    const { name, img } = req.body;
    const id = Date.now().toString();
    const fileName = `art_${id}.jpg`;
    const filePath = path.join(__dirname, 'gallery', fileName);
    const base64Data = img.replace(/^data:image\/jpeg;base64,/, "");

    fs.writeFile(filePath, base64Data, 'base64', (err) => {
        if (err) return res.status(500).send("Erreur");
        const newArt = { id, name: name || "Artiste", img: `/gallery/${fileName}`, fileName };
        galleryData.push(newArt);
        res.status(200).send({ success: true, id: id });
    });
});

// Note : API pour SUPPRIMER
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
app.listen(PORT, () => console.log(`🚀 Gold Pixel Studio sur le port ${PORT}`));
