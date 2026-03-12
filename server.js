const express  = require('express');
const fs        = require('fs');
const path      = require('path');
const { v4: uuid } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Dossier galerie ── */
const GALLERY_DIR  = path.join(__dirname, 'gallery');
const GALLERY_FILE = path.join(GALLERY_DIR, 'artworks.json');

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
app.use(express.json({ limit: '8mb' }));   // images base64 pouvant être lourdes
app.use(express.static(path.join(__dirname, 'public')));

/* Serve index.html depuis public/ */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ══════════════════════════════════════════
   GET /api/gallery
   Retourne toutes les œuvres (triées par date, plus récente en dernier)
══════════════════════════════════════════ */
app.get('/api/gallery', (req, res) => {
  const data = readGallery();
  res.json(data);
});

/* ══════════════════════════════════════════
   POST /api/save
   Corps : { name: string, img: string (base64 dataURL) }
   Sauvegarde l'œuvre et renvoie { id }
══════════════════════════════════════════ */
app.post('/api/save', (req, res) => {
  const { name, img } = req.body;

  if (!name || !img) {
    return res.status(400).json({ error: 'name et img requis' });
  }
  if (typeof img !== 'string' || !img.startsWith('data:image/')) {
    return res.status(400).json({ error: 'format image invalide' });
  }
  // Taille max ~4MB base64
  if (img.length > 5_000_000) {
    return res.status(413).json({ error: 'image trop lourde' });
  }

  const data = readGallery();

  // Limite : max 500 œuvres dans la galerie
  if (data.length >= 500) {
    return res.status(429).json({ error: 'galerie pleine' });
  }

  const artwork = {
    id:        uuid(),
    name:      String(name).slice(0, 32).replace(/[<>"']/g, ''),
    img,
    votes:     0,
    createdAt: new Date().toISOString()
  };

  data.push(artwork);
  writeGallery(data);

  res.json({ id: artwork.id });
});

/* ══════════════════════════════════════════
   POST /api/vote
   Corps : { id: string }
   Incrémente le vote et renvoie { votes }
══════════════════════════════════════════ */
app.post('/api/vote', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id requis' });

  const data = readGallery();
  const art  = data.find(a => a.id === id);
  if (!art)  return res.status(404).json({ error: 'œuvre non trouvée' });

  art.votes = (art.votes || 0) + 1;
  writeGallery(data);

  res.json({ votes: art.votes });
});

/* ══════════════════════════════════════════
   POST /api/delete
   Corps : { id: string }
   Supprime l'œuvre
══════════════════════════════════════════ */
app.post('/api/delete', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id requis' });

  const data    = readGallery();
  const index   = data.findIndex(a => a.id === id);
  if (index === -1) return res.status(404).json({ error: 'œuvre non trouvée' });

  data.splice(index, 1);
  writeGallery(data);

  res.json({ ok: true });
});

/* ══════════════════════════════════════════
   Démarrage
══════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`✅  Gold Pixel Studio — http://localhost:${PORT}`);
});
