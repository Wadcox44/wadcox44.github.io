/* ═══════════════════════════════════════════════════════════════════
   GP CANVAS ENGINE — Gold Pixel
   Fichier : Games/Goldpixel/gp-engine.js

   Responsabilités :
     - Rendu canvas HTML5 2D optimisé (drawPixel unitaire)
     - Pan / Zoom fluide (touch + mouse + wheel)
     - Socket.io client : émission pixel:place + réception pixel:update
     - Chargement initial via GET /api/pixelwar/grid
     - Expansion canvas (+50% surface à 65% rempli)
     - Intégration HUD existant (palette, stock, Sentinelle)

   Dépendances externes :
     - window.COLORS        (palette, défini dans goldpixel.html)
     - window.GOLD_COLOR    (couleur gold spéciale)
     - window.activeColor   (couleur sélectionnée, géré par HUD)
     - window.stock         (stock pixels, géré par HUD)
     - window.goldStock     (stock gold, géré par HUD)
     - window.piUsername    (identifiant joueur)
     - window.piConnected   (booléen)
     - window.SENTINEL      (module Sentinelle)
     - window.updateStockUI()
     - window.saveLSState()
     - window.showToast()
     - window.STOCK_CAP
     - window.GOLD_MAX_ACTIVE
     - window.GOLD_COLOR
     - window.getRechargeS()
═══════════════════════════════════════════════════════════════════ */

const GP = (() => {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     CONFIG CANVAS
  ───────────────────────────────────────────────────────────── */
  let CANVAS_W = 3000;
  let CANVAS_H = 3000;
  const BG_COLOR          = '#f5f0e8';
  const GRID_COLOR        = 'rgba(0,0,0,0.06)';
  const GRID_MAJOR_COLOR  = 'rgba(200,150,10,0.18)';
  const EXPAND_THRESHOLD  = 0.65;   // 65% rempli → expansion
  const EXPAND_FACTOR     = 1.5;    // +50% surface (chaque dim × √1.5)

  /* ─────────────────────────────────────────────────────────────
     ÉTAT INTERNE
  ───────────────────────────────────────────────────────────── */
  let cv, ctx, container;

  // Pan / Zoom
  let scale = 1, panX = 0, panY = 0;
  let _isPanning = false, _panOX = 0, _panOY = 0;
  let _tStart = { x: 0, y: 0 }, _tMoved = false;
  let _pinchD = null, _pinchS = 1;
  let _mDown = false, _mPan = false;
  let _mSX = 0, _mSY = 0, _mOX = 0, _mOY = 0;

  // Grille locale : Map "col,row" → { color, user }
  const pixelMap = new Map();
  let filledCount = 0;

  // Undo
  let _lastPixel  = null;   // { col, row, prevColor, prevUser }
  let _undoTimer  = null;

  // Socket.io
  let _socket = null;
  let _socketReady = false;

  /* ─────────────────────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────────────────────── */
  function init() {
    cv        = document.getElementById('gameCanvas');
    ctx       = cv.getContext('2d');
    container = document.getElementById('canvasContainer');

    cv.width  = CANVAS_W;
    cv.height = CANVAS_H;

    _drawBg();
    _buildPaletteUI();
    resetView();
    _bindEvents();
  }

  /* ─────────────────────────────────────────────────────────────
     BACKGROUND + GRILLE
     Appelé UNE SEULE FOIS à l'init et à chaque expansion.
     Le reste = drawPixel unitaire uniquement.
  ───────────────────────────────────────────────────────────── */
  function _drawBg() {
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Grille fine toutes les 10 cellules
    ctx.lineWidth   = 0.5;
    ctx.strokeStyle = GRID_COLOR;
    for (let x = 0; x <= CANVAS_W; x += 10) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
    }
    for (let y = 0; y <= CANVAS_H; y += 10) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
    }
    // Grille majeure toutes les 100 cellules
    ctx.lineWidth   = 0.8;
    ctx.strokeStyle = GRID_MAJOR_COLOR;
    for (let x = 0; x <= CANVAS_W; x += 100) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
    }
    for (let y = 0; y <= CANVAS_H; y += 100) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     DRAW PIXEL UNITAIRE — seule fonction de dessin en live
  ───────────────────────────────────────────────────────────── */
  function _drawPixel(col, row, color) {
    ctx.fillStyle = color;
    ctx.fillRect(col, row, 1, 1);
  }

  /* Effacer une cellule — redessine juste le fond + lignes de grille */
  function _clearPixel(col, row) {
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(col, row, 1, 1);
    // Rétablir les lignes de grille si nécessaire
    if (col % 10 === 0 || row % 10 === 0) {
      ctx.lineWidth   = col % 100 === 0 || row % 100 === 0 ? 0.8 : 0.5;
      ctx.strokeStyle = col % 100 === 0 || row % 100 === 0 ? GRID_MAJOR_COLOR : GRID_COLOR;
      if (col % 10 === 0) {
        ctx.beginPath(); ctx.moveTo(col, row); ctx.lineTo(col, row + 1); ctx.stroke();
      }
      if (row % 10 === 0) {
        ctx.beginPath(); ctx.moveTo(col, row); ctx.lineTo(col + 1, row); ctx.stroke();
      }
    }
  }

  /* Animation pop-in : alpha 0 → 1 en 8 frames */
  function _drawPixelAnimated(col, row, color) {
    let step = 0;
    const totalSteps = 8;
    const animate = () => {
      step++;
      const alpha = step / totalSteps;
      // D'abord effacer proprement
      _clearPixel(col, row);
      ctx.globalAlpha = alpha;
      ctx.fillStyle   = color;
      ctx.fillRect(col, row, 1, 1);
      ctx.globalAlpha = 1;
      if (step < totalSteps) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  /* ─────────────────────────────────────────────────────────────
     PALETTE UI
  ───────────────────────────────────────────────────────────── */
  function _buildPaletteUI() {
    const grid = document.getElementById('palette-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const palColors = (window.COLORS || []).filter(c => c !== window.GOLD_COLOR);
    palColors.forEach(c => {
      const el = document.createElement('div');
      el.className = 'px-swatch' + (c === window.activeColor ? ' active' : '');
      el.style.background = c;
      el.addEventListener('click', () => _pick(c));
      el.addEventListener('touchstart', e => { e.preventDefault(); _pick(c); }, { passive: false });
      grid.appendChild(el);
    });
    _syncGoldBtn();
  }

  function _pick(c) {
    if (c === window.GOLD_COLOR) { pickGold(); return; }
    if (window.stock <= 0) { window.showToast('📦 Stock vide !'); return; }
    window.activeColor = c;
    document.querySelectorAll('.px-swatch').forEach(el => {
      const bg = el.style.backgroundColor || el.style.background;
      el.classList.toggle('active', bg === c);
    });
    const gb = document.getElementById('btn-gold');
    if (gb) gb.classList.remove('active');
  }

  function pickGold() {
    if ((window.goldStock || 0) <= 0) { window.showToast('✦ Stock Gold épuisé !'); return; }
    window.activeColor = window.GOLD_COLOR;
    document.querySelectorAll('.px-swatch').forEach(el => el.classList.remove('active'));
    _syncGoldBtn();
  }

  function _syncGoldBtn() {
    const gb = document.getElementById('btn-gold');
    if (!gb) return;
    gb.classList.toggle('active', window.activeColor === window.GOLD_COLOR);
    gb.classList.toggle('empty', (window.goldStock || 0) <= 0);
  }

  /* ─────────────────────────────────────────────────────────────
     PAN / ZOOM
  ───────────────────────────────────────────────────────────── */
  function resetView() {
    if (!container) return;
    const vw = container.clientWidth;
    const vh = container.clientHeight;
    const s  = Math.min((vw * 0.95) / CANVAS_W, (vh * 0.95) / CANVAS_H);
    scale = Math.max(s, 0.05);
    panX  = (vw - CANVAS_W * scale) / 2;
    panY  = (vh - CANVAS_H * scale) / 2;
    _applyTransform();
  }

  function zoomIn()  { _zoom(1.35); }
  function zoomOut() { _zoom(0.75); }

  function _zoom(f, cx, cy) {
    if (!container) return;
    const vw = container.clientWidth, vh = container.clientHeight;
    if (cx === undefined) cx = vw / 2;
    if (cy === undefined) cy = vh / 2;
    const ns = Math.min(Math.max(scale * f, 0.02), 60);
    const r  = ns / scale;
    panX  = cx - (cx - panX) * r;
    panY  = cy - (cy - panY) * r;
    scale = ns;
    _applyTransform();
  }

  function _applyTransform() {
    if (cv) cv.style.transform = `translate(${panX}px,${panY}px) scale(${scale})`;
  }

  /* ─────────────────────────────────────────────────────────────
     COORDONNÉES : écran → cellule canvas
  ───────────────────────────────────────────────────────────── */
  function _screenToCell(sx, sy) {
    const rect = container.getBoundingClientRect();
    const col  = Math.floor((sx - rect.left  - panX) / scale);
    const row  = Math.floor((sy - rect.top   - panY) / scale);
    return { col, row };
  }

  function _inBounds(col, row) {
    return col >= 0 && col < CANVAS_W && row >= 0 && row < CANVAS_H;
  }

  /* ─────────────────────────────────────────────────────────────
     PLACE PIXEL — logique principale
  ───────────────────────────────────────────────────────────── */
  function placePixel(col, row) {
    if (!_inBounds(col, row)) return;

    const isGold = (window.activeColor === window.GOLD_COLOR);

    if (isGold && (window.goldStock || 0) <= 0) {
      window.showToast('✦ Stock Gold épuisé !'); return;
    }
    if (!isGold && (window.stock || 0) <= 0) {
      window.showToast('📦 Stock vide !'); return;
    }

    const color    = window.activeColor;
    const key      = col + ',' + row;
    const prevPx   = pixelMap.get(key) || null;

    // Sauvegarder pour undo
    _lastPixel = { col, row, prevColor: prevPx ? prevPx.color : null, prevUser: prevPx ? prevPx.user : null };
    _startUndoTimer();

    // Mise à jour locale optimiste
    _applyPixel(col, row, color, '@' + (window.piUsername || 'anon'), true);

    // Décrémenter stock
    if (isGold) {
      window.goldStock = Math.max(0, (window.goldStock || 0) - 1);
    } else {
      window.stock--;
      if ((window.rechargeLeft || 0) <= 0) window.rechargeLeft = window.getRechargeS ? window.getRechargeS() : 120;
    }
    window.pixelsPlaced = (window.pixelsPlaced || 0) + 1;
    if (window.updateStockUI) window.updateStockUI();
    _syncGoldBtn();
    if (window.saveLSState) window.saveLSState();

    // Flash visuel
    const fl = document.getElementById('px-flash');
    if (fl) { fl.classList.add('on'); setTimeout(() => fl.classList.remove('on'), 80); }

    // Envoyer via Socket.io (prioritaire) OU fallback HTTP
    if (_socketReady && _socket) {
      _socket.emit('pixel:place', {
        col, row, color,
        username: window.piUsername || 'anonyme',
        ts: Date.now(),
      });
      // Le serveur va broadcasten retour → on attend pixel:ack pour confirmer
    } else if (window.piConnected && window.apiFetch) {
      // Fallback HTTP si socket pas dispo
      window.apiFetch('/api/pixelwar/place', 'POST', {
        col, row, color, username: window.piUsername,
      }).then(d => {
        if (d && !d.ok) _rollback(col, row, prevPx, isGold);
      }).catch(() => {});
    }

    _checkExpand();
  }

  /* Appliquer un pixel (local + dessin) */
  function _applyPixel(col, row, color, user, animate) {
    const key    = col + ',' + row;
    const wasEmpty = !pixelMap.has(key);
    pixelMap.set(key, { color, user });
    if (wasEmpty) filledCount++;

    if (animate) _drawPixelAnimated(col, row, color);
    else         _drawPixel(col, row, color);
  }

  /* Rollback optimiste */
  function _rollback(col, row, prevPx, wasGold) {
    if (prevPx) {
      _applyPixel(col, row, prevPx.color, prevPx.user, false);
    } else {
      const key = col + ',' + row;
      pixelMap.delete(key);
      filledCount = Math.max(0, filledCount - 1);
      _clearPixel(col, row);
    }
    if (wasGold) window.goldStock = Math.min(window.GOLD_MAX_ACTIVE || 12, (window.goldStock || 0) + 1);
    else         window.stock = Math.min(window.STOCK_CAP || 60, (window.stock || 0) + 1);
    if (window.updateStockUI) window.updateStockUI();
    window.showToast('❌ Pixel refusé');
  }

  /* ─────────────────────────────────────────────────────────────
     UNDO (30 secondes)
  ───────────────────────────────────────────────────────────── */
  function undo() {
    if (!_lastPixel) { window.showToast('Rien à annuler'); return; }
    const { col, row, prevColor, prevUser } = _lastPixel;
    clearTimeout(_undoTimer);
    _lastPixel = null;
    const btn = document.getElementById('btn-undo');
    if (btn) btn.classList.remove('active');

    if (prevColor) {
      _applyPixel(col, row, prevColor, prevUser, false);
      if (_socketReady && _socket) {
        _socket.emit('pixel:place', { col, row, color: prevColor, username: window.piUsername || 'anonyme', ts: Date.now() });
      } else if (window.apiFetch) {
        window.apiFetch('/api/pixelwar/place', 'POST', { col, row, color: prevColor, username: window.piUsername }).catch(() => {});
      }
    } else {
      pixelMap.delete(col + ',' + row);
      filledCount = Math.max(0, filledCount - 1);
      _clearPixel(col, row);
    }

    const wasGold = window.activeColor === window.GOLD_COLOR;
    if (wasGold) window.goldStock = Math.min(window.GOLD_MAX_ACTIVE || 12, (window.goldStock || 0) + 1);
    else         window.stock = Math.min(window.STOCK_CAP || 60, (window.stock || 0) + 1);
    if (window.updateStockUI) window.updateStockUI();
    window.showToast('↩ Pixel annulé !');
    if (window.saveLSState) window.saveLSState();
  }

  function _startUndoTimer() {
    clearTimeout(_undoTimer);
    const btn = document.getElementById('btn-undo');
    if (btn) btn.classList.add('active');
    _undoTimer = setTimeout(() => {
      _lastPixel = null;
      if (btn) btn.classList.remove('active');
    }, 30000);
  }

  /* ─────────────────────────────────────────────────────────────
     EXPANSION CANVAS
     Déclenchée automatiquement quand 65% des cellules sont remplies.
     Synchronisée via Socket.io event 'canvas:expand'.
  ───────────────────────────────────────────────────────────── */
  function _checkExpand() {
    if (filledCount / (CANVAS_W * CANVAS_H) < EXPAND_THRESHOLD) return;
    // Émettre l'événement d'expansion au serveur (qui validera et broadcastera)
    if (_socketReady && _socket) {
      _socket.emit('canvas:expand', { currentW: CANVAS_W, currentH: CANVAS_H });
    }
  }

  function _doExpand(newW, newH) {
    if (newW <= CANVAS_W && newH <= CANVAS_H) return; // déjà à jour

    // Sauvegarder le contenu actuel
    const tmp = document.createElement('canvas');
    tmp.width  = CANVAS_W;
    tmp.height = CANVAS_H;
    tmp.getContext('2d').drawImage(cv, 0, 0);

    CANVAS_W = newW;
    CANVAS_H = newH;
    cv.width  = newW;
    cv.height = newH;

    _drawBg();
    // Recopier les pixels existants
    ctx.drawImage(tmp, 0, 0);

    // Animation glow sur le canvas
    cv.classList.add('expanding');
    setTimeout(() => cv.classList.remove('expanding'), 900);

    window.showToast(`📐 Canvas agrandi : ${newW}×${newH} !`);
    resetView();
  }

  /* ─────────────────────────────────────────────────────────────
     SOCKET.IO — connexion et événements
  ───────────────────────────────────────────────────────────── */
  function _initSocket() {
    if (typeof io === 'undefined') {
      console.warn('[GP] Socket.io non disponible — mode HTTP fallback');
      return;
    }

    // Se connecter au même serveur
    _socket = io({ transports: ['websocket', 'polling'], reconnectionAttempts: 10 });

    _socket.on('connect', () => {
      _socketReady = true;
      console.log('[GP] Socket connecté :', _socket.id);
      window.showToast('🔗 Connecté en temps réel');
    });

    _socket.on('disconnect', () => {
      _socketReady = false;
      console.warn('[GP] Socket déconnecté');
    });

    // Pixel placé par un autre joueur
    _socket.on('pixel:update', ({ col, row, color, user, ts }) => {
      if (!_inBounds(col, row)) return;
      // Notifier la Sentinelle avant de dessiner
      if (window.SENTINEL && user !== '@' + window.piUsername) {
        window.SENTINEL.checkIncoming(col, row, user || '?');
      }
      // Ne pas redessiner ses propres pixels (déjà fait en optimiste)
      if (user === '@' + window.piUsername) return;
      _applyPixel(col, row, color, user, true);
    });

    // Confirmation de son propre pixel (ack)
    _socket.on('pixel:ack', ({ col, row, ok, error, stock }) => {
      if (!ok) {
        // Rollback
        const wasGold = window.activeColor === window.GOLD_COLOR;
        const key     = col + ',' + row;
        const px      = pixelMap.get(key);
        _rollback(col, row, _lastPixel ? { color: _lastPixel.prevColor, user: _lastPixel.prevUser } : null, wasGold);
        window.showToast('❌ ' + (error || 'Refusé'));
      } else if (typeof stock === 'number') {
        // Synchroniser le stock avec la valeur serveur
        window.stock = stock;
        if (window.updateStockUI) window.updateStockUI();
      }
    });

    // Expansion canvas synchronisée
    _socket.on('canvas:expanded', ({ newW, newH }) => {
      _doExpand(newW, newH);
    });

    // Chargement initial de la grille via socket
    _socket.on('canvas:state', ({ pixels }) => {
      if (!Array.isArray(pixels)) return;
      pixels.forEach(({ col, row, color, user }) => {
        if (_inBounds(col, row)) _applyPixel(col, row, color, user, false);
      });
      // Indexer les pixels du joueur courant pour la Sentinelle
      if (window.SENTINEL && window.piUsername) {
        pixels
          .filter(p => p.user === '@' + window.piUsername)
          .forEach(p => window.SENTINEL.registerMyPixel(p.col, p.row));
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────
     CHARGEMENT INITIAL (HTTP)
     Utilisé si socket pas encore prêt OU comme fallback.
  ───────────────────────────────────────────────────────────── */
  async function _loadGrid() {
    if (!window.apiFetch) return;
    try {
      const data = await window.apiFetch('/api/pixelwar/grid', 'GET');
      if (!data || !Array.isArray(data.pixels)) return;
      data.pixels.forEach(({ col, row, color, user }) => {
        if (_inBounds(col, row)) _applyPixel(col, row, color, user, false);
      });
      // Indexer pixels du joueur courant pour la Sentinelle
      if (window.SENTINEL && window.piUsername) {
        data.pixels
          .filter(p => p.user === '@' + window.piUsername)
          .forEach(p => window.SENTINEL.registerMyPixel(p.col, p.row));
      }
    } catch (e) {
      console.error('[GP] loadGrid error:', e);
      window.showToast('⚠ Mode hors-ligne');
    }
  }

  /* ─────────────────────────────────────────────────────────────
     ÉVÉNEMENTS UTILISATEUR
  ───────────────────────────────────────────────────────────── */
  function _bindEvents() {
    // Touch
    container.addEventListener('touchstart', _onTouchStart, { passive: false });
    container.addEventListener('touchmove',  _onTouchMove,  { passive: false });
    container.addEventListener('touchend',   _onTouchEnd,   { passive: false });
    // Mouse
    container.addEventListener('mousedown', _onMouseDown);
    window.addEventListener('mousemove',    _onMouseMove);
    window.addEventListener('mouseup',      _onMouseUp);
    // Wheel
    container.addEventListener('wheel', _onWheel, { passive: false });
    // Resize
    window.addEventListener('resize', () => {
      clearTimeout(window._gpResizeT);
      window._gpResizeT = setTimeout(resetView, 80);
    });
  }

  function _onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      _tStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      _tMoved = false; _isPanning = false;
      _panOX = panX; _panOY = panY;
    } else if (e.touches.length === 2) {
      _pinchD = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      _pinchS = scale;
      _tMoved = true;
    }
  }

  function _onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      const dx = e.touches[0].clientX - _tStart.x;
      const dy = e.touches[0].clientY - _tStart.y;
      if (!_isPanning && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        _isPanning = true; _tMoved = true;
      }
      if (_isPanning) { panX = _panOX + dx; panY = _panOY + dy; _applyTransform(); }
      _updateCoords(e.touches[0].clientX, e.touches[0].clientY);
    } else if (e.touches.length === 2 && _pinchD) {
      _tMoved = true;
      const d   = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const cx  = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy  = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const ns  = Math.min(Math.max(_pinchS * (d / _pinchD), 0.02), 60);
      const r   = ns / scale;
      panX = cx - (cx - panX) * r;
      panY = cy - (cy - panY) * r;
      scale = ns;
      _applyTransform();
    }
  }

  function _onTouchEnd(e) {
    e.preventDefault();
    if (e.touches.length === 0 && !_tMoved) {
      const { col, row } = _screenToCell(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      placePixel(col, row);
    }
    if (e.touches.length < 2) _pinchD = null;
  }

  function _onMouseDown(e) {
    _mDown = true; _mPan = false;
    _mSX = e.clientX; _mSY = e.clientY; _mOX = panX; _mOY = panY;
  }
  function _onMouseMove(e) {
    if (!_mDown) return;
    const dx = e.clientX - _mSX, dy = e.clientY - _mSY;
    if (!_mPan && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) _mPan = true;
    if (_mPan) { panX = _mOX + dx; panY = _mOY + dy; _applyTransform(); }
    _updateCoords(e.clientX, e.clientY);
  }
  function _onMouseUp(e) {
    if (!_mPan && _mDown) {
      const { col, row } = _screenToCell(e.clientX, e.clientY);
      placePixel(col, row);
    }
    _mDown = false; _mPan = false;
  }
  function _onWheel(e) {
    e.preventDefault();
    _zoom(e.deltaY < 0 ? 1.2 : 0.83, e.clientX, e.clientY);
  }

  function _updateCoords(sx, sy) {
    const el = document.getElementById('px-coords');
    if (!el) return;
    const { col, row } = _screenToCell(sx, sy);
    el.textContent = _inBounds(col, row) ? `X:${col} Y:${row}` : '—';
  }

  /* ─────────────────────────────────────────────────────────────
     ZOOM TO CELL (pour Sentinelle)
  ───────────────────────────────────────────────────────────── */
  function zoomToCell(col, row) {
    if (!container) return;
    const vw = container.clientWidth, vh = container.clientHeight;
    const targetScale = Math.min(Math.max(scale, 6), 15);
    panX  = vw / 2 - col * targetScale;
    panY  = vh / 2 - row * targetScale;
    scale = targetScale;
    _applyTransform();
  }

  /* ─────────────────────────────────────────────────────────────
     START ENGINE — point d'entrée appelé par startGame()
  ───────────────────────────────────────────────────────────── */
  async function startEngine() {
    init();
    _initSocket();
    // Charger la grille via HTTP (socket prendra le relais pour le live)
    await _loadGrid();
  }

  /* ─────────────────────────────────────────────────────────────
     API PUBLIQUE
  ───────────────────────────────────────────────────────────── */
  return {
    startEngine,
    pick:       _pick,
    pickGold,
    zoomIn,
    zoomOut,
    resetView,
    undo,
    zoomToCell,
  };
})();
