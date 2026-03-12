// --- IMPORTATION DES OUTILS ---
const express = require('express'); // Note : Charge le framework Express
const path = require('path'); // Note : Gère les chemins de fichiers
const app = express(); // Note : Crée l'instance du serveur

// --- CONFIGURATION CRITIQUE ---
// Note : Augmentation à 50mb pour être CERTAIN que les images passent
app.use(express.json({ limit: '50mb' })); 
// Note : Support pour les données de formulaires lourdes
app.use(express.urlencoded({ limit: '50mb', extended: true })); 
// Note : Rend les fichiers locaux (HTML, CSS, JS) accessibles
app.use(express.static(__dirname)); 

// --- BASE DE DONNÉES TEMPORAIRE ---
let galleryData = []; 

// --- ROUTES DE NAVIGATION ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });

// --- API DE LA GALERIE ---

// API : Récupérer toutes les œuvres sauvegardées
app.get('/api/gallery', (req, res) => { 
    console.log(`🖼️  Envoi de la galerie (${galleryData.length} œuvres)`);
    res.json(galleryData); 
});

// API : Sauvegarder une nouvelle œuvre
app.post('/api/save', (req, res) => {
    try {
        const newArt = { 
            id: Date.now().toString(), // Note : Crée un identifiant unique
            name: req.body.name || "Pionnier Anonyme", 
            img: req.body.img, // Note : L'image sous forme de texte long
            votes: 0 
        };
        
        // Note : Vérification si l'image est bien présente
        if (!req.body.img) {
            console.error("❌ Erreur : Aucune donnée d'image reçue !");
            return res.status(400).send("Image manquante");
        }

        galleryData.push(newArt);
        console.log(`✅ Œuvre de ${newArt.name} sauvegardée avec succès !`);
        res.status(200).send({ id: newArt.id });
    } catch (err) {
        console.error("💥 Crash lors de la sauvegarde :", err);
        res.status(500).send("Erreur interne");
    }
});

// API : Voter pour une œuvre
app.post('/api/vote', (req, res) => {
    const art = galleryData.find(a => a.id === req.body.id);
    if (art) { 
        art.votes++; 
        console.log(`👍 Vote ajouté pour l'ID ${req.body.id}`);
        res.status(200).send({ votes: art.votes }); 
    } else { 
        res.status(404).send("Introuvable"); 
    }
});

// API : Supprimer (Sécurité : le filtre se base sur l'ID envoyé)
app.post('/api/delete', (req, res) => {
    const initialCount = galleryData.length;
    galleryData = galleryData.filter(art => art.id !== req.body.id);
    
    if (galleryData.length < initialCount) {
        console.log(`🗑️  Œuvre ${req.body.id} supprimée.`);
        res.status(200).send({ message: "Supprimé" });
    } else {
        res.status(404).send("Rien à supprimer");
    }
});

// --- LANCEMENT DU STUDIO ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n***************************************`);
    console.log(`🚀 GOLD PIXEL STUDIO est prêt !`);
    console.log(`📍 URL : http://localhost:${PORT}`);
    console.log(`***************************************\n`);
});
