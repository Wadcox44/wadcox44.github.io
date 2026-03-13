const express  = require('express'); // Note : Framework pour gérer le serveur
const fs        = require('fs'); // Note : Gestion des fichiers
const path      = require('path'); // Note : Gestion des chemins dossiers
const { v4: uuid } = require('uuid'); // Note : Pour générer des IDs uniques

const app  = express(); // Note : Initialisation
const PORT = process.env.PORT || 10000; // Note : Port par défaut de Render

/* ── Dossier galerie ── */
const GALLERY_DIR  = path.join(__dirname, 'gallery');
const GALLERY_FILE = path.join(GALLERY_DIR, 'artworks.json');

// Note : Création auto des dossiers de stockage
if (!fs.existsSync(GALLERY_DIR)) fs.mkdirSync(GALLERY_DIR, { recursive: true });
if (!fs.existsSync(GALLERY_FILE)) fs.writeFileSync(GALLERY_FILE, '[]', 'utf8');

/* ── Helpers lecture/écriture ── */
function readGallery() {
  try { return JSON.parse(fs.readFileSync(GALLERY_FILE, 'utf8')); }
  catch { return []; }
}
function writeGallery(data) {
  fs.writeFileSync(GALLERY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/* ── Middleware ── */
app.use(express.json({ limit: '10mb' })); // Note : Autorise les images un peu plus lourdes
// NOTE CRUCIALE : On utilise __dirname (la racine) car tes fichiers ne sont pas dans /public
app.use(express.static(__dirname)); 

/* Note : On sert les fichiers depuis la racine */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Note : Route pour accéder directement au studio
app.get('/goldpixel', (req, res) => {
  res.sendFile(path.join(__dirname, 'goldpixel.html'));
});

/* ══════════════════════════════════════════
   API GALLERY
══════════════════════════════════════════ */
app.get('/api/gallery', (req, res) => {
  const data = readGallery();
  res.json(data);
});

app.post('/api/save', (req, res) => {
  const { name, img } = req.body;
  if (!name || !img) return res.status(400).json({ error: 'champs requis' });
  
  const data = readGallery();
  if (data.length >= 500) return res.status(429).json({ error: 'galerie pleine' });

  const artwork = {
    id: uuid(),
    name: String(name).slice(0, 32).replace(/[<>"']/g, ''),
    img,
    votes: 0,
    createdAt: new Date().toISOString()
  };

  data.push(artwork);
  writeGallery(data);
  res.json({ id: artwork.id });
});

app.post('/api/vote', (req, res) => {
  const { id } = req.body;
  const data = readGallery();
  const art = data.find(a => a.id === id);
  if (!art) return res.status(404).json({ error: 'non trouvé' });
  art.votes = (art.votes || 0) + 1;
  writeGallery(data);
  res.json({ votes: art.votes });
});

app.post('/api/delete', (req, res) => {
  const { id } = req.body;
  const data = readGallery();
  const index = data.findIndex(a => a.id === id);
  if (index === -1) return res.status(404).json({ error: 'non trouvé' });
  data.splice(index, 1);
  writeGallery(data);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`✅ Gold Pixel Studio — Port ${PORT}`);
});
