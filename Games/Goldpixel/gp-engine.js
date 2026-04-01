/* ═══════════════════════════════════════════════════════════════
   GP ENGINE v6 — Gold Pixel (Canvas Fluide + Undo + Grille)
   Games/Goldpixel/gp-engine.js
═══════════════════════════════════════════════════════════════ */

const GP = (() => {
  'use strict';

  /* ── CONFIG ────────────────────────────────────────────────── */
  const DEV_MODE      = true; // ACTIVÉ: Stock illimité (Étape 8)
  const POLL_MS       = 3000;
  const STOCK_MAX     = DEV_MODE ? 999999 : 5;
  const COOLDOWN_MS   = DEV_MODE ? 0 : 30000;
  const BG_COLOR      = '#f5f0e8';
  
  if (DEV_MODE) window.DEV_MODE = true;

  /* ── ÉTAT ──────────────────────────────────────────────────── */
  let CANVAS_W = 100; // Mis à jour via API
  let CANVAS_H = 100;
  let cv, ctx, innerWrap, gridOverlay;
  
  // Echelle visuelle (CSS Pixel)
  let cssScale = 1;
  let ZOOM_LEVELS = [1, 5, 12]; // [Panoramique, Intermédiaire, Précision]

  const _pix = new Map(); // "col,row" → { color, user }

  // Cooldown
  let _localStock   = STOCK_MAX;
  let _cooldownLeft = 0;

  // Undo system
  let _undo  = null;
  let _undoT = null;

  // Input
  let _lastInputType = 'mouse'; // 'mouse' | 'touch'

  // Réseau
  let _lastTs     = 0;
  let _pollTimer  = null;
  let _gridLoaded = false;
  let _sock       = null;
  let _sockReady  = false;

  /* ══════════════════════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════════════════════ */
  function init() {
    cv        = document.getElementById('gameCanvas');
    innerWrap = document.getElementById('canvas-inner');
    gridOverlay = document.getElementById('grid-overlay');

    if (cv) {
      ctx = cv.getContext('2d');
      if (innerWrap) innerWrap.addEventListener('dragstart', e => e.preventDefault());
    }

    /* ── TOUCH : 1 doigt = drag (pan), tap sans mouvement = interaction ──
       Listeners sur canvas-wrap (le conteneur scrollable), pas sur le canvas,
       pour que scrollLeft/scrollTop soient directement manipulables.
       Le seuil de 5px distingue un tap d'un drag sans ambiguïté. ── */
    const wrap = document.getElementById('canvas-wrap');
    if (wrap) {
      // État du geste courant (scope local, une seule source de vérité)
      let _t0x = 0;          // clientX au touchstart
      let _t0y = 0;          // clientY au touchstart
      let _scrollX0 = 0;     // scrollLeft au touchstart
      let _scrollY0 = 0;     // scrollTop  au touchstart
      let _isDragging = false; // true dès que déplacement > DRAG_THRESHOLD
      let _hasMoved = false;  // true si le doigt a bougé (bloque la pose au touchend)

      const DRAG_THRESHOLD = 5; // px — même valeur que l'ancien code

      wrap.addEventListener('touchstart', e => {
        // Ignorer multi-touch (pinch) — pas de zoom demandé
        if (e.touches.length !== 1) { _hasMoved = true; return; }

        _lastInputType = 'touch';
        const t = e.touches[0];
        _t0x      = t.clientX;
        _t0y      = t.clientY;
        _scrollX0 = wrap.scrollLeft;
        _scrollY0 = wrap.scrollTop;
        _isDragging = false;
        _hasMoved   = false;
      }, { passive: true });

      wrap.addEventListener('touchmove', e => {
        if (e.touches.length !== 1) return;
        const t  = e.touches[0];
        const dx = t.clientX - _t0x;
        const dy = t.clientY - _t0y;

        if (!_isDragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
          _isDragging = true;
          _hasMoved   = true; // pose bloquée pour ce geste
        }

        if (_isDragging) {
          // Déplacer le viewport en soustrayant le delta (sens naturel)
          wrap.scrollLeft = _scrollX0 - dx;
          wrap.scrollTop  = _scrollY0 - dy;
          // Cacher le fantôme pendant le drag
          _updateGhost(null, null);
        }
      }, { passive: true });

      wrap.addEventListener('touchend', e => {
        if (e.touches.length !== 0) return; // encore des doigts → attendre

        if (!_hasMoved) {
          // TAP propre : aucun mouvement détecté → poser un pixel
          const t = e.changedTouches[0];
          _onCanvasClick(t, 'touch');
        }

        _isDragging = false;
        _hasMoved   = false;
      }, { passive: true });
    }

    /* ── SOURIS : survol (ghost) + clic (pose) — inchangé ── */
    if (cv) {
      cv.addEventListener('pointermove', e => {
        if (e.pointerType === 'mouse') {
          _lastInputType = 'mouse';
          const coords = _resolveCoords(e);
          if (coords) _updateGhost(coords.col, coords.row);
          else        _updateGhost(null, null);
        }
      });
      cv.addEventListener('pointerleave', () => _updateGhost(null, null));

      cv.addEventListener('click', e => {
        // Ignorer si le dernier geste était tactile (évite le ghost-click mobile)
        if (_lastInputType === 'touch') return;
        _onCanvasClick(e, 'mouse');
      });
    }

    _buildPalette();
    _startCooldownTick();
  }

  /* ══════════════════════════════════════════════════════════════
     CANVAS RENDU
  ══════════════════════════════════════════════════════════════ */
  function _expand() {
    const wrap = document.getElementById('canvas-wrap');
    if (!wrap) return;

    // 2. Format RECTANGLE HORIZONTAL (largeur > hauteur STRICTEMENT)
    const margin = 20;
    const w = wrap.clientWidth - margin;
    const h = wrap.clientHeight - margin;

    CANVAS_W = Math.max(w, 100);
    // On force la hauteur à être proportionnellement horizontale (60% de la largeur max)
    CANVAS_H = Math.max(Math.min(h, Math.floor(CANVAS_W * 0.6)), 50);
    
    if (cv) {
      cv.width = CANVAS_W;
      cv.height = CANVAS_H;
      _redrawFull();
      fitToScreen();
    }
  }

  function _px(col, row, color) {
    if (!ctx) return;
    ctx.fillStyle = color;
    ctx.fillRect(col, row, 1, 1);
  }

  function _redrawFull() {
    if (!ctx) return;
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    _pix.forEach((v, k) => {
      const parts = k.split(',');
      _px(Number(parts[0]), Number(parts[1]), v.color);
    });
  }

  function _applyPx(col, row, color, user, recordUndo = false) {
    if (recordUndo) {
      const prev = _pix.get(`${col},${row}`);
      _undo = { col, row, prevColor: prev ? prev.color : null, prevUser: prev ? prev.user : null };
      clearTimeout(_undoT);
      _undoT = setTimeout(() => { _undo = null; _updateUndoUI(); }, 30000);
      _updateUndoUI();
    }
    
    if (color === BG_COLOR || color === null) {
      _pix.delete(`${col},${row}`);
    } else {
      _pix.set(`${col},${row}`, { color, user });
    }
    
    // Rendu Stable (Étape 4) : Redraw complet du tableau dynamique
    _redrawFull();
  }
  
  // Reset Canvas (Étape 5)
  function resetCanvas() {
    _pix.clear();
    _redrawFull();
    window.showToast?.('🧹 Canvas remis à blanc !');
  }

  /* ══════════════════════════════════════════════════════════════
     INPUTS & ZOOM
  ══════════════════════════════════════════════════════════════ */
  let ghostEl;
  let _ghostCell = null;

  function _resolveCoords(e) {
    if (!cv || !innerWrap) return null;
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const cellSize = rect.width / CANVAS_W;
    const col = Math.floor(x / cellSize);
    const row = Math.floor(y / cellSize);
    
    if (col >= 0 && col < CANVAS_W && row >= 0 && row < CANVAS_H) {
      return { col, row };
    }
    return null; // Hors-limites
  }

  function _updateGhost(col, row) {
    if (!ghostEl) ghostEl = document.getElementById('ghost-pixel');
    if (!ghostEl) return;
    
    if (col === null || row === null) {
      ghostEl.style.display = 'none';
      _ghostCell = null;
      document.getElementById('coord-display').textContent = 'X: -- | Y: --';
      return;
    }
    
    _ghostCell = { col, row };
    document.getElementById('coord-display').textContent = `X: ${col} | Y: ${row}`;
    ghostEl.style.display = 'block';
    
    // Pourcentage parfait : aucun problème de redimensionnement dynamique
    ghostEl.style.width  = (100 / CANVAS_W) + '%';
    ghostEl.style.height = (100 / CANVAS_H) + '%';
    ghostEl.style.left   = ((col / CANVAS_W) * 100) + '%';
    ghostEl.style.top    = ((row / CANVAS_H) * 100) + '%';
    
    ghostEl.style.backgroundColor = window.activeColor || BG_COLOR;
  }

  function _onCanvasClick(e, inputType) {
    const coords = _resolveCoords(e);
    if (!coords) return;
    const { col, row } = coords;

    // 1. Zoom (Smart Tap) : S'active si on est pas au niveau de zoom maximal.
    if (cssScale < ZOOM_LEVELS[2] * 0.9) {
      zoomToCell(col, row);
      window.showToast?.('🔍 Zoom sur cible. Re-touche pour peindre !');
      // Pose un tracker visuel mais "Ne pas poser de pixel immédiatement"
      _updateGhost(col, row); 
      return; 
    }

    // 2. Pose de pixel confirmée UNIQUEMENT si on était déjà zoomé
    placePixel(col, row);
    
    // Nettoyage immédiat
    if (inputType === 'touch') {
       _updateGhost(null, null);
    }
  }

  function fitToScreen() {
    const wrap = document.getElementById('canvas-wrap');
    if (!wrap) return;
    
    // Échelle initiale à 1 puisque _expand() s'est ajusté pile poil au conteneur !
    cssScale = 1;
    
    ZOOM_LEVELS[0] = 1;           // Vue globale
    ZOOM_LEVELS[1] = 4;           // Vue moyenne
    ZOOM_LEVELS[2] = 12;          // Vue précision (Pixel art)

    _applyZoom();
  }

  // Zoom HUD / Centré sur Viewport (Étape 3)
  function zoomIn() {
    const next = ZOOM_LEVELS.find(lvl => lvl > cssScale + 0.1);
    if (next) _zoomAndCenterScreen(next);
  }

  function zoomOut() {
    const prev = [...ZOOM_LEVELS].reverse().find(lvl => lvl < cssScale - 0.1);
    if (prev) {
      _zoomAndCenterScreen(prev);
    } else {
      fitToScreen(); // Fallback panoramique pur
    }
  }

  function _zoomAndCenterScreen(newScale) {
    const wrap = document.getElementById('canvas-wrap');
    if (!wrap) return;

    // 1. Point central actuel du contenant, mappé dans l'espace logique global (col, row approx)
    const cx = (wrap.scrollLeft + wrap.clientWidth / 2) / cssScale;
    const cy = (wrap.scrollTop  + wrap.clientHeight / 2) / cssScale;

    // 2. Modifie l'échelle
    cssScale = newScale;
    _applyZoom();

    // 3. Ajuste les scrollbars pour retomber sur le même centre cible
    wrap.scrollLeft = (cx * cssScale) - (wrap.clientWidth / 2);
    wrap.scrollTop  = (cy * cssScale) - (wrap.clientHeight / 2);
  }

  function resetView() {
    fitToScreen();
  }

  function _applyZoom() {
    if (!innerWrap) return;
    const w = Math.round(CANVAS_W * cssScale);
    const h = Math.round(CANVAS_H * cssScale);
    innerWrap.style.width = w + 'px';
    innerWrap.style.height = h + 'px';

    // Grille visible uniquement si on a zoomé assez pour voir les cases
    if (gridOverlay) {
      if (cssScale > 3) {
        gridOverlay.style.display = 'block';
        gridOverlay.style.backgroundImage = `
          linear-gradient(to right, rgba(0,0,0,0.1) 1px, transparent 1px),
          linear-gradient(to bottom, rgba(0,0,0,0.1) 1px, transparent 1px)
        `;
        gridOverlay.style.backgroundSize = `${cssScale}px ${cssScale}px`;
      } else {
        gridOverlay.style.display = 'none';
      }
    }
  }

  function zoomToCell(col, row) {
    // Zoom direct absolu au niveau de PRÉCISION
    cssScale = ZOOM_LEVELS[2];
    _applyZoom();

    // Pan sur col, row
    const wrap = document.getElementById('canvas-wrap');
    if (!wrap) return;
    
    // Position idéale : centre du pixel choisi (col + 0.5) mutiplié par l'échelle d'affichage
    const px = Math.round((col + 0.5) * cssScale);
    const py = Math.round((row + 0.5) * cssScale);
    
    // On glisse les barres de défilement pour centrer la coordonnée à l'écran
    wrap.scrollLeft = px - wrap.clientWidth / 2;
    wrap.scrollTop  = py - wrap.clientHeight / 2;
  }

  function goToInputCoords() {
    const elX = document.getElementById('coord-x');
    const elY = document.getElementById('coord-y');
    if (!elX || !elY) return;

    const x = parseInt(elX.value, 10);
    const y = parseInt(elY.value, 10);

    if (isNaN(x) || isNaN(y)) return;
    if (x >= 0 && x < CANVAS_W && y >= 0 && y < CANVAS_H) {
      zoomToCell(x, y);
      _updateGhost(x, y);
    } else {
      window.showToast?.('⚠️ Coordonnées hors limites !');
    }
  }

  /* ══════════════════════════════════════════════════════════════
     PALETTE UI
  ══════════════════════════════════════════════════════════════ */
  function _buildPalette() {
    const grid = document.getElementById('palette-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const colors = (window.COLORS || []).filter(c => c !== window.GOLD_COLOR);
    colors.forEach(c => {
      const el = document.createElement('div');
      el.className = 'px-swatch' + (c === window.activeColor ? ' active' : '');
      el.style.background = c;
      el.dataset.color = c; // Sauvegarde la couleur brute (#HEX)
      el.addEventListener('click', () => _pick(c));
      el.addEventListener('touchstart', e => { e.preventDefault(); _pick(c); }, { passive: false });
      grid.appendChild(el);
    });
    _syncGold();
    _updatePreview(window.activeColor);
  }

  function _pick(c) {
    if (c === window.GOLD_COLOR) { pickGold(); return; }
    window.activeColor = c;
    document.querySelectorAll('.px-swatch').forEach(el =>
      // Utilise dataset.color car style.backgroundColor convertit en rgb(...)
      el.classList.toggle('active', el.dataset.color === c)
    );
    document.getElementById('btn-gold')?.classList.remove('active');
    _updatePreview(c);
  }

  function pickGold() {
    window.activeColor = window.GOLD_COLOR;
    document.querySelectorAll('.px-swatch').forEach(el => el.classList.remove('active'));
    _syncGold();
    _updatePreview(window.GOLD_COLOR);
  }

  function _syncGold() {
    const gb = document.getElementById('btn-gold');
    if (!gb) return;
    gb.classList.toggle('active', window.activeColor === window.GOLD_COLOR);
    gb.classList.remove('empty'); 
  }

  function _updatePreview(color) {
    const el = document.getElementById('color-preview');
    if (el) el.style.background = color || '#3690ea';
    // Le fantôme change instantanément de couleur quand on choisit la palette (s'il était affiché)
    if (_ghostCell) {
       _updateGhost(_ghostCell.col, _ghostCell.row);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     COOLDOWN
  ══════════════════════════════════════════════════════════════ */
  function _startCooldownTick() {
    setInterval(() => {
      if (_cooldownLeft > 0) {
        _cooldownLeft -= 1;
        _updateCooldownUI();
        if (_cooldownLeft <= 0 && _localStock < STOCK_MAX) {
          _localStock = Math.min(STOCK_MAX, _localStock + 1);
          _updateCooldownUI();
          if (_localStock < STOCK_MAX) _cooldownLeft = COOLDOWN_MS / 1000;
        }
      }
    }, 1000);
  }

  function _updateCooldownUI() {
    const el = document.getElementById('tb-cooldown');
    const s1 = document.getElementById('tb-stock-val');
    if (s1) s1.textContent = _localStock;
    if (!el) return;
    
    if (_cooldownLeft <= 0 || _localStock >= STOCK_MAX) {
      el.textContent = '✓';
      el.classList.add('ready');
    } else {
      el.textContent = `${_cooldownLeft}s`;
      el.classList.remove('ready');
    }
  }

  /* ══════════════════════════════════════════════════════════════
     ACTIONS JOUEURS (Placer et Annuler)
  ══════════════════════════════════════════════════════════════ */
  function placePixel(col, row) {
    const isGold = window.activeColor === window.GOLD_COLOR;

    // Seul le pixel standard est soumis au stock visuel restreint
    if (!isGold && _localStock <= 0) {
      window.showToast?.(`⏳ +1 pixel dans ${_cooldownLeft}s`);
      return;
    }

    const color = window.activeColor;
    _applyPx(col, row, color, '@' + (window.piUsername || 'anon'), true);

    if (!isGold) {
      _localStock = Math.max(0, _localStock - 1);
      if (_cooldownLeft <= 0) _cooldownLeft = COOLDOWN_MS / 1000;
      _updateCooldownUI();
    }
    
    window.pixelsPlaced = (window.pixelsPlaced || 0) + 1;
    window.updateStockUI?.();

    if (_sockReady && _sock) {
      _sock.emit('pixel:place', { col, row, color, username: window.piUsername || 'anonyme' });
    } else if (window.apiFetch) {
      window.apiFetch('/api/pixelwar/place', 'POST', { col, row, color, username: window.piUsername }).catch(() => {});
    }
  }

  function undo() {
    if (!_undo) { window.showToast?.('Rien à annuler'); return; }
    const { col, row, prevColor, prevUser } = _undo;
    
    clearTimeout(_undoT);
    _undo = null;
    _updateUndoUI();

    // Effacement si c'était vide, sinon restauration de la vieille couleur
    const targetColor = prevColor || BG_COLOR;
    _applyPx(col, row, targetColor, prevUser, false);
    
    // Rendre un jeton
    if (_localStock < STOCK_MAX) {
      _localStock++;
      _updateCooldownUI();
    }
    
    // Annulation côté serveur
    if (_sockReady && _sock) {
      _sock.emit('pixel:place', { col, row, color: targetColor, username: window.piUsername || 'anonyme' });
    } else if (window.apiFetch) {
      window.apiFetch('/api/pixelwar/place', 'POST', { col, row, color: targetColor, username: window.piUsername }).catch(() => {});
    }
  }

  function _updateUndoUI() {
    const b = document.getElementById('btn-undo');
    if (!b) return;
    b.classList.toggle('active', !!_undo);
  }

  /* ══════════════════════════════════════════════════════════════
     RÉSEAU
  ══════════════════════════════════════════════════════════════ */
  async function _loadGrid() {
    try {
      _expand();
      
      // 1. Vider complétement le canvas (Aucun dessin d'oeuvre d'art ou de pixels)
      _gridLoaded = true;
      _pix.clear();
      _redrawFull();
    } catch (e) {
      console.warn('[GP] loadGrid:', e);
    }
  }

  async function _poll() {
    if (!window.apiFetch || !_lastTs) return;
    try {
      const d = await window.apiFetch(`/api/pixelwar/grid?since=${_lastTs}`, 'GET');
      if (!d?.pixels?.length) { if (d?.ts) _lastTs = d.ts; return; }
      d.pixels.forEach(p => {
        if (p.user === '@' + window.piUsername) return;
        _applyPx(p.col, p.row, p.color, p.user, false);
        window.SENTINEL?.checkIncoming(p.col, p.row, p.user || '?');
      });
      if (d.ts) _lastTs = d.ts;
    } catch (_) {}
  }

  function _initSocket() {
    if (typeof io === 'undefined') return;
    _sock = io({ transports: ['websocket', 'polling'], reconnectionAttempts: 8 });

    _sock.on('connect',    () => { _sockReady = true; });
    _sock.on('disconnect', () => { _sockReady = false; });

    _sock.on('canvas:state', ({ pixels, canvasW, canvasH }) => {
      if (!_gridLoaded) {
        _expand(canvasW || 3000, canvasH || 3000);
        if (Array.isArray(pixels)) {
          pixels.forEach(p => _applyPx(p.col, p.row, p.color, p.user, false));
          if (window.SENTINEL && window.piUsername) {
            pixels.filter(p => p.user === '@' + window.piUsername)
                  .forEach(p => window.SENTINEL.registerMyPixel(p.col, p.row));
          }
        }
        _gridLoaded = true;
      }
    });

    _sock.on('pixel:update', (p) => {
      _applyPx(p.col, p.row, p.color, p.user, false);
      if (p.user !== '@' + window.piUsername) {
        window.SENTINEL?.checkIncoming(p.col, p.row, p.user || '?');
      }
    });

    _sock.on('pixel:ack', ({ col, row, ok, error, stock }) => {
      if (!ok) {
        _applyPx(col, row, BG_COLOR, null, false);
        window.showToast?.('❌ ' + (error || 'Refusé'));
      } else if (typeof stock === 'number') {
        window.stock = stock;
        window.updateStockUI?.();
      }
    });

    _sock.on('canvas:reset', ({ msg }) => {
      _lastTs = 0;
      _gridLoaded = false;
      _pix.clear();
      if (ctx) {
        ctx.fillStyle = BG_COLOR;
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      }
      window.showToast?.(msg || '🔄 Nouveau mois — canvas réinitialisé !');
    });
  }

  /* ══════════════════════════════════════════════════════════════
     BOOTSTRAP
  ══════════════════════════════════════════════════════════════ */
  async function startEngine() {
    init();
    
    // 3. NETTOYAGE ENGINE - Démarrage complet à vide
    // AUCUN chargement de contenu pré-chargé ni fetch
    _gridLoaded = true;
    _expand();
    _pix.clear();
    _redrawFull();
  }

  Object.defineProperty(window, '_localStock', { get: () => _localStock, configurable: true });

  return { startEngine, pick: _pick, pickGold, zoomIn, zoomOut, resetView, undo, zoomToCell, placePixel, resetCanvas, goToInputCoords };

})();
