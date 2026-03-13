const express  = require('express'); // Note : Framework web
const fs        = require('fs'); // Note : Gestion fichiers
const path      = require('path'); // Note : Gestion chemins
const { v4: uuid } = require('uuid'); // Note : IDs uniques

const app  = express(); // Note : Instance serveur
const PORT = process.env.PORT || 10000; // Note : Port Render

// Note : On s'assure que le chemin est bien celui du dossier gallery à la racine
const GALLERY_DIR  = path.join(__dirname, 'gallery'); 
const GALLERY_FILE = path.join(GALLERY_DIR, 'artworks.json'); 

// Note : Création automatique au démarrage si absent sur le serveur Render
if (!fs.existsSync(GALLERY_DIR)) fs.mkdirSync(GALLERY_DIR, { recursive: true });
if (!fs.existsSync(GALLERY_FILE)) fs.writeFileSync(GALLERY_FILE, '[]', 'utf8');

function readGallery() { try { return JSON.parse(fs.readFileSync(GALLERY_FILE, 'utf8')); } catch { return []; } }
function writeGallery(data) { fs.writeFileSync(GALLERY_FILE, JSON.stringify(data, null, 2), 'utf8'); }

app.use(express.json({ limit: '15mb' })); // Note : Pour les grosses images
app.use(express.static(__dirname)); // Note : Sert index.html et goldpixel.html

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/goldpixel', (req, res) => { res.sendFile(path.join(__dirname, 'goldpixel.html')); });

app.get('/api/gallery', (req, res) => { res.json(readGallery()); });

app.post('/api/save', (req, res) => { 
  const { name, title, img } = req.body;
  const data = readGallery();
  const artwork = { id: uuid(), name: String(name).slice(0, 20), title: String(title).slice(0, 30), img, votes: 0, createdAt: new Date().toISOString() };
  data.push(artwork);
  writeGallery(data); 
  res.json({ id: artwork.id });
});

app.post('/api/vote', (req, res) => { 
  const { id } = req.body;
  const data = readGallery();
  const art = data.find(a => a.id === id);
  if (art) { art.votes = (art.votes || 0) + 1; writeGallery(data); res.json({ votes: art.votes }); }
  else { res.status(404).json({ error: 'non trouvé' }); }
});

app.post('/api/delete', (req, res) => { 
  const { id } = req.body;
  let data = readGallery();
  data = data.filter(a => a.id !== id);
  writeGallery(data);
  res.json({ ok: true });
});

app.listen(PORT, () => { console.log(`✅ Gold Pixel tourne sur le port ${PORT}`); });
