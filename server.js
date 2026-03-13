const express  = require('express'); // Note : Framework web
const fs        = require('fs'); // Note : Système de fichiers
const path      = require('path'); // Note : Gestion des dossiers
const { v4: uuid } = require('uuid'); // Note : Générateur d'identifiants

const app  = express(); // Note : Création de l'application
const PORT = process.env.PORT || 10000; // Note : Port pour le déploiement Render

const GALLERY_DIR  = path.join(__dirname, 'gallery'); // Note : Dossier de stockage
const GALLERY_FILE = path.join(GALLERY_DIR, 'artworks.json'); // Note : Base de données JSON

if (!fs.existsSync(GALLERY_DIR)) fs.mkdirSync(GALLERY_DIR, { recursive: true }); // Note : Créer dossier si absent
if (!fs.existsSync(GALLERY_FILE)) fs.writeFileSync(GALLERY_FILE, '[]', 'utf8'); // Note : Créer fichier si absent

function readGallery() { try { return JSON.parse(fs.readFileSync(GALLERY_FILE, 'utf8')); } catch { return []; } } // Note : Lire JSON
function writeGallery(data) { fs.writeFileSync(GALLERY_FILE, JSON.stringify(data, null, 2), 'utf8'); } // Note : Écrire JSON

app.use(express.json({ limit: '10mb' })); // Note : Supporte les images base64
app.use(express.static(__dirname)); // Note : TRÈS IMPORTANT - Sert les fichiers à la racine pour Render

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); }); // Note : Page accueil
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); }); // Note : Page studio

app.get('/api/gallery', (req, res) => { res.json(readGallery()); }); // Note : Route API galerie

app.post('/api/save', (req, res) => { // Note : Route API sauvegarde
  const { name, img } = req.body;
  const data = readGallery();
  if (data.length >= 500) return res.status(429).json({ error: 'Galerie pleine' });
  const artwork = { id: uuid(), name: String(name).slice(0, 32), img, votes: 0, createdAt: new Date().toISOString() };
  data.push(artwork);
  writeGallery(data);
  res.json({ id: artwork.id });
});

app.post('/api/vote', (req, res) => { // Note : Route API votes
  const { id } = req.body;
  const data = readGallery();
  const art = data.find(a => a.id === id);
  if (art) { art.votes = (art.votes || 0) + 1; writeGallery(data); res.json({ votes: art.votes }); }
  else { res.status(404).json({ error: 'Non trouvé' }); }
});

app.post('/api/delete', (req, res) => { // Note : Route API suppression
  const { id } = req.body;
  const data = readGallery();
  const idx = data.findIndex(a => a.id === id);
  if (idx !== -1) { data.splice(idx, 1); writeGallery(data); res.json({ ok: true }); }
  else { res.status(404).json({ error: 'Non trouvé' }); }
});

app.listen(PORT, () => { console.log(`✅ Studio Gold Pixel en ligne (Port ${PORT})`); }); // Note : Lancement
