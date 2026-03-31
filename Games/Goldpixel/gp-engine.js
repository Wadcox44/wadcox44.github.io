/* ═══════════════════════════════════════════════════════════════
   GP ENGINE v6 — Gold Pixel (Canvas Fluide + Undo + Grille)
   Games/Goldpixel/gp-engine.js
═══════════════════════════════════════════════════════════════ */

const GP = (() => {
  'use strict';

  /* ── CONFIG ────────────────────────────────────────────────── */
  const POLL_MS       = 3000;
  const STOCK_MAX     = 999999; // ILLIMITÉ (Demande de test)
  const COOLDOWN_MS   = 30000;
  const BG_COLOR      = '#f5f0e8';

  /* ── ÉTAT ──────────────────────────────────────────────────── */
  let CANVAS_W = 100; // Mis à jour via API
  let CANVAS_H = 100;
  let cv, ctx, innerWrap, gridOverlay;
  
  // Echelle visuelle (CSS Pixel)
  let cssScale = 1;

  const _pix = new Map(); // "col,row" → { color, user }

  // Cooldown
  let _localStock   = STOCK_MAX;
  let _cooldownLeft = 0;

  // Undo system
  let _undo  = null;
  let _undoT = null;

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
    cv = document.getElementById('gameCanvas');
    innerWrap = document.getElementById('canvas-inner');
    gridOverlay = document.getElementById('grid-overlay');

    if (cv) {
      ctx = cv.getContext('2d');
      // Pour éviter les bugs drag, on desactive sur l'innerWrap
      if (innerWrap) innerWrap.addEventListener('dragstart', e => e.preventDefault());
      cv.addEventListener('pointerdown', _onCanvasClick);
    }
    
    const wrap = document.getElementById('canvas-wrap');
    if (wrap) {
      wrap.addEventListener('touchstart', _onTouchStart, { passive: false });
      wrap.addEventListener('touchmove', _onTouchMove, { passive: false });
    }

    _buildPalette();
    _startCooldownTick();
  }

  /* ══════════════════════════════════════════════════════════════
     CANVAS RENDU
  ══════════════════════════════════════════════════════════════ */
  function _expand(w, h) {
    if (w <= CANVAS_W && h <= CANVAS_H && _gridLoaded) return;
    CANVAS_W = w || CANVAS_W;
    CANVAS_H = h || CANVAS_H;
    
    if (cv) {
      cv.width = CANVAS_W;
      cv.height = CANVAS_H;
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      _pix.forEach((v, k) => {
        const [col, row] = k.split(',').map(Number);
        _px(col, row, v.color);
      });
      // Met à l'échelle idéale de base (fit l'écran au besoin)
      fitToScreen();
    }
  }

  function _px(col, row, color) {
    if (!ctx) return;
    ctx.fillStyle = color;
    ctx.fillRect(col, row, 1, 1);
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
      _px(col, row, BG_COLOR); // Effacement physique
    } else {
      _pix.set(`${col},${row}`, { color, user });
      _px(col, row, color);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     INPUTS & ZOOM
  ══════════════════════════════════════════════════════════════ */
  function _onCanvasClick(e) {
    if (!cv || !innerWrap) return;
    const rect = innerWrap.getBoundingClientRect();
    
    // Le clic est calculé proportionnellement au niveau de zoom !
    const col = Math.floor((e.clientX - rect.left) / cssScale);
    const row = Math.floor((e.clientY - rect.top) / cssScale);

    if (col >= 0 && col < CANVAS_W && row >= 0 && row < CANVAS_H) {
      placePixel(col, row);
    }
  }

  function fitToScreen() {
    const wrap = document.getElementById('canvas-wrap');
    if (!wrap) return;
    // Le ratio remplit exactement la largeur du conteneur (UI gauche/droite touchées)
    const scaleX = wrap.clientWidth / CANVAS_W;
    cssScale = scaleX;
    if (cssScale > 1 && CANVAS_W > wrap.clientWidth) cssScale = 1; // Pas de flou si l'image est petite
    _applyZoom();
  }

  /* ── PINCH TO ZOOM MOBILE ── */
  let _touchStartDist = 0;
  let _touchStartScale = 1;

  function _onTouchStart(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      _touchStartDist = Math.sqrt(dx*dx + dy*dy);
      _touchStartScale = cssScale;
    }
  }

  function _onTouchMove(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      const wrap = document.getElementById('canvas-wrap');
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      
      const factor = dist / _touchStartDist;
      let newScale = _touchStartScale * factor;
      if (newScale < 0.05) newScale = 0.05;
      if (newScale > 30) newScale = 30;

      // Centrage logique sous les deux doigts
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const rect = wrap.getBoundingClientRect();
      
      // Coordonnées logiques
      const lx = (cx - rect.left + wrap.scrollLeft) / cssScale;
      const ly = (cy - rect.top + wrap.scrollTop) / cssScale;

      cssScale = newScale;
      _applyZoom();

      // Ajuster le scroll pour rester au centre du pincement
      wrap.scrollLeft = (lx * cssScale) - (cx - rect.left);
      wrap.scrollTop = (ly * cssScale) - (cy - rect.top);
    }
  }

  function zoomIn() {
    // Si on est vraiment dézoomé, on accélère le pas
    const step = cssScale < 1 ? 0.2 : (cssScale < 5 ? 1 : 2);
    cssScale = Math.min(cssScale + step, 20); // max 20x pour bien voir les pixels
    _applyZoom();
  }

  function zoomOut() {
    const step = cssScale <= 1 ? 0.2 : (cssScale <= 5 ? 1 : 2);
    cssScale = Math.max(cssScale - step, 0.1);
    _applyZoom();
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
    // Zoom direct
    cssScale = Math.max(cssScale, 10);
    _applyZoom();

    // Pan sur col, row
    const wrap = document.getElementById('canvas-wrap');
    if (!wrap) return;
    const px = Math.round(col * cssScale);
    const py = Math.round(row * cssScale);
    wrap.scrollLeft = px - wrap.clientWidth / 2;
    wrap.scrollTop  = py - wrap.clientHeight / 2;
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
    if (!window.apiFetch) return;
    try {
      const d = await window.apiFetch('/api/pixelwar/grid', 'GET');
      if (d?.canvasW && d?.canvasH) {
        _expand(d.canvasW, d.canvasH);
      } else {
        _expand(3000, 3000); 
      }

      if (d?.pixels) {
        d.pixels.forEach(p => _applyPx(p.col, p.row, p.color, p.user, false));
        if (window.SENTINEL && window.piUsername) {
          d.pixels
            .filter(p => p.user === '@' + window.piUsername)
            .forEach(p => window.SENTINEL.registerMyPixel(p.col, p.row));
        }
      }
      
      if (d?.ts) _lastTs = d.ts;
      _gridLoaded = true;
      
      // Dessiner l'oeuvre centrale demandée
      _drawMasterpiece();
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
    _initSocket();
    await _loadGrid();
    _pollTimer = setInterval(_poll, POLL_MS);
  }

  /* ══════════════════════════════════════════════════════════════
     OEUVRE D'ART LOCALE POUR TEST
  ══════════════════════════════════════════════════════════════ */
  function _drawMasterpiece() {
    const art = [
      "....Y.......Y.......Y....",
      "...YYY.....YYY.....YYY...",
      "..YYYYY...YYYYY...YYYYY..",
      "..YYRYY...YYBYY...YYGYY..",
      "..YYYYY..YYYYYYY..YYYYY..",
      "...YYYYY.YYYYYYY.YYYYY...",
      "...YYYYYYYYYYYYYYYYYYY...",
      "....YYYYYYYYYYYYYYYYY....",
      "......YYYYYYYYYYYYYY.....",
      ".......YYYYYYYYYYYY......",
      ".........................",
      ".........................",
      "....GGGGGG......PPPPPP...",
      "...GGGGGGGG....PPPPPPPP..",
      "..GG......GG..PP......PP.",
      "..GG..........PP......PP.",
      "..GG...GGGGG..PPPPPPPPPP.",
      "..GG......GG..PP.........",
      "...GGGGGGGG...PP.........",
      "....GGGGGG....PP........."
    ];
    
    // Y=Gold, R=Red, B=Blue, G=Green(Logo), P=Purple(Logo)
    const colors = {
      'Y': '#ffd700', 'R': '#e83c50', 'B': '#3690ea', 
      'G': '#42d48a', 'P': '#9b59b6' 
    };
    
    const pixelScale = 15; // Agrandissement pour visibilité
    const artW = art[0].length * pixelScale;
    const artH = art.length * pixelScale;
    const startX = Math.floor(CANVAS_W / 2 - artW / 2);
    const startY = Math.floor(CANVAS_H / 2 - artH / 2);

    for (let r = 0; r < art.length; r++) {
      for (let c = 0; c < art[r].length; c++) {
        const char = art[r][c];
        if (colors[char]) {
          // On le dessine sans encombrer le Socket
          for (let dy = 0; dy < pixelScale; dy++) {
            for (let dx = 0; dx < pixelScale; dx++) {
              _applyPx(startX + c * pixelScale + dx, startY + r * pixelScale + dy, colors[char], '@Antigravity', false);
            }
          }
        }
      }
    }
  }

  Object.defineProperty(window, '_localStock', { get: () => _localStock, configurable: true });

  return { startEngine, pick: _pick, pickGold, zoomIn, zoomOut, resetView, undo, zoomToCell, placePixel };

})();
