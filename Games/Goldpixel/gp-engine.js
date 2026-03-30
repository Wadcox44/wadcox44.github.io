/* ═══════════════════════════════════════════════════════════════
   GP ENGINE v2 — Gold Pixel Canvas
   Fichier : Games/Goldpixel/gp-engine.js

   RÈGLES STRICTES :
   ─ canvas 3000×3000, 1 cellule = 1 px réel
   ─ fillRect(col, row, 1, 1) exclusivement
   ─ AUCUNE grille, AUCUN redraw global en live
   ─ Zoom CSS transform uniquement
   ─ Un seul jeu d'event listeners (bindEvents appelé 1 fois)
   ─ Zoom adaptatif au remplissage (fillRatio)

   Dépendances (exposées sur window par goldpixel.html) :
     window.COLORS, window.GOLD_COLOR, window.activeColor
     window.stock, window.goldStock, window.rechargeLeft
     window.pixelsPlaced, window.piUsername, window.piConnected
     window.STOCK_CAP, window.GOLD_MAX_ACTIVE
     window.updateStockUI(), window.saveLSState()
     window.showToast(), window.apiFetch(), window.getRechargeS()
     window.SENTINEL
═══════════════════════════════════════════════════════════════ */

const GP = (() => {
  'use strict';

  /* ── Config ─────────────────────────────────────────────── */
  let CANVAS_W = 3000;
  let CANVAS_H = 3000;
  const BG     = '#f5f0e8';
  const EXPAND_THRESHOLD = 0.65;
  const EXPAND_FACTOR    = 1.5;    // +50% surface → dim × √1.5

  /* ── DOM ─────────────────────────────────────────────────── */
  let cv, ctx, container;

  /* ── Pan / Zoom ──────────────────────────────────────────── */
  let scale = 1, panX = 0, panY = 0;
  let _panOX = 0, _panOY = 0;
  let _tStart = { x: 0, y: 0 }, _tMoved = false, _isPanning = false;
  let _pinchD0 = null, _pinchS0 = 1;
  let _mDown = false, _mPan = false, _mSX = 0, _mSY = 0, _mOX = 0, _mOY = 0;

  /* ── État ────────────────────────────────────────────────── */
  const pixelMap = new Map();   // "col,row" → { color, user }
  let filledCount = 0;
  let _lastPixel  = null;       // pour undo
  let _undoTimer  = null;

  /* ── Socket.io ───────────────────────────────────────────── */
  let _socket     = null;
  let _socketReady = false;

  /* ═══════════════════════════════════════════════════════════
     INIT
  ═══════════════════════════════════════════════════════════ */
  function init() {
    cv        = document.getElementById('gameCanvas');
    ctx       = cv.getContext('2d');
    container = document.getElementById('canvasContainer');

    cv.width  = CANVAS_W;
    cv.height = CANVAS_H;

    /* Fond uni — SEUL fillRect plein canvas, jamais en live */
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    _buildPaletteUI();
    resetView();
    _bindEvents();
  }

  /* ═══════════════════════════════════════════════════════════
     RESET VIEW — zoom adaptatif au remplissage
  ═══════════════════════════════════════════════════════════ */
  function resetView() {
    if (!container) return;
    const vw = container.clientWidth;
    const vh = container.clientHeight;

    /* Zoom adaptatif selon le taux de remplissage */
    const fillRatio = filledCount / (CANVAS_W * CANVAS_H);
    let zoomFactor = 0.85;
    if (fillRatio > 0.1) zoomFactor = 0.7;
    if (fillRatio > 0.3) zoomFactor = 0.6;
    if (fillRatio > 0.6) zoomFactor = 0.4;

    /* Scale = canvas tient dans le viewport × zoomFactor */
    scale = Math.min(vw / CANVAS_W, vh / CANVAS_H) * zoomFactor;
    scale = Math.max(scale, 0.02);

    /* Centrer */
    panX = (vw - CANVAS_W * scale) / 2;
    panY = (vh - CANVAS_H * scale) / 2;

    _applyTransform();
  }

  /* ═══════════════════════════════════════════════════════════
     ZOOM
  ═══════════════════════════════════════════════════════════ */
  function zoomIn()  { _zoom(1.35); }
  function zoomOut() { _zoom(0.75); }

  function _zoom(f, cx, cy) {
    if (!container) return;
    const vw = container.clientWidth, vh = container.clientHeight;
    if (cx === undefined) cx = vw / 2;
    if (cy === undefined) cy = vh / 2;
    const ns = Math.min(Math.max(scale * f, 0.015), 80);
    const r  = ns / scale;
    panX  = cx - (cx - panX) * r;
    panY  = cy - (cy - panY) * r;
    scale = ns;
    _applyTransform();
  }

  function _applyTransform() {
    if (cv) cv.style.transform = `translate(${panX}px,${panY}px) scale(${scale})`;
  }

  /* ═══════════════════════════════════════════════════════════
     DESSIN — pixel perfect, 1 cellule = 1 px
  ═══════════════════════════════════════════════════════════ */
  function _drawPixel(col, row, color) {
    ctx.fillStyle = color;
    ctx.fillRect(col, row, 1, 1);
  }

  function _erasePixel(col, row) {
    ctx.fillStyle = BG;
    ctx.fillRect(col, row, 1, 1);
  }

  /* Pop-in : alpha 0 → 1 en ~8 frames rAF */
  function _drawPixelAnimated(col, row, color) {
    let step = 0;
    const totalSteps = 8;
    const tick = () => {
      step++;
      ctx.globalAlpha = step / totalSteps;
      ctx.fillStyle   = color;
      ctx.fillRect(col, row, 1, 1);
      ctx.globalAlpha = 1;
      if (step < totalSteps) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* Appliquer un pixel dans la Map + sur le canvas */
  function _applyPixel(col, row, color, user, animate) {
    const key    = `${col},${row}`;
    const isNew  = !pixelMap.has(key);
    pixelMap.set(key, { color, user });
    if (isNew) filledCount++;
    if (animate) _drawPixelAnimated(col, row, color);
    else         _drawPixel(col, row, color);
  }

  /* ═══════════════════════════════════════════════════════════
     PALETTE UI
  ═══════════════════════════════════════════════════════════ */
  function _buildPaletteUI() {
    const grid = document.getElementById('palette-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const colors = (window.COLORS || []).filter(c => c !== window.GOLD_COLOR);
    colors.forEach(c => {
      const el = document.createElement('div');
      el.className = 'px-swatch' + (c === window.activeColor ? ' active' : '');
      el.style.background = c;
      el.addEventListener('click', () => _selectColor(c));
      el.addEventListener('touchstart', e => {
        e.preventDefault();
        _selectColor(c);
      }, { passive: false });
      grid.appendChild(el);
    });
    _syncGoldBtn();
  }

  function _selectColor(c) {
    if (c === window.GOLD_COLOR) { pickGold(); return; }
    if ((window.stock || 0) <= 0) { window.showToast('📦 Stock vide !'); return; }
    window.activeColor = c;
    document.querySelectorAll('.px-swatch').forEach(el =>
      el.classList.toggle('active', el.style.backgroundColor === c || el.style.background === c)
    );
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
    gb.classList.toggle('empty',  (window.goldStock || 0) <= 0);
  }

  /* ═══════════════════════════════════════════════════════════
     COORDONNÉES écran → cellule canvas
  ═══════════════════════════════════════════════════════════ */
  function _screenToCell(sx, sy) {
    const rect = container.getBoundingClientRect();
    return {
      col: Math.floor((sx - rect.left  - panX) / scale),
      row: Math.floor((sy - rect.top   - panY) / scale),
    };
  }

  function _inBounds(col, row) {
    return col >= 0 && col < CANVAS_W && row >= 0 && row < CANVAS_H;
  }

  /* ═══════════════════════════════════════════════════════════
     PLACE PIXEL
  ═══════════════════════════════════════════════════════════ */
  function placePixel(col, row) {
    if (!_inBounds(col, row)) return;

    const isGold = window.activeColor === window.GOLD_COLOR;
    if (isGold  && (window.goldStock || 0) <= 0) { window.showToast('✦ Stock Gold épuisé !'); return; }
    if (!isGold && (window.stock     || 0) <= 0) { window.showToast('📦 Stock vide !');       return; }

    const color  = window.activeColor;
    const key    = `${col},${row}`;
    const prevPx = pixelMap.get(key) || null;

    /* Sauvegarder pour undo */
    _lastPixel = { col, row, prevColor: prevPx?.color || null, prevUser: prevPx?.user || null };
    _startUndoTimer();

    /* Mise à jour optimiste */
    _applyPixel(col, row, color, '@' + (window.piUsername || 'anon'), true);

    /* Décrémenter stock */
    if (isGold) {
      window.goldStock = Math.max(0, (window.goldStock || 0) - 1);
    } else {
      window.stock--;
      if ((window.rechargeLeft || 0) <= 0 && window.getRechargeS)
        window.rechargeLeft = window.getRechargeS();
    }
    window.pixelsPlaced = (window.pixelsPlaced || 0) + 1;
    if (window.updateStockUI) window.updateStockUI();
    _syncGoldBtn();
    if (window.saveLSState) window.saveLSState();

    /* Flash */
    const fl = document.getElementById('px-flash');
    if (fl) { fl.classList.add('on'); setTimeout(() => fl.classList.remove('on'), 80); }

    /* Envoi Socket (prioritaire) ou fallback HTTP */
    if (_socketReady && _socket) {
      _socket.emit('pixel:place', {
        col, row, color,
        username: window.piUsername || 'anonyme',
      });
    } else if (window.apiFetch) {
      window.apiFetch('/api/pixelwar/place', 'POST', {
        col, row, color, username: window.piUsername,
      }).then(d => {
        if (d && !d.ok) _rollback(col, row, prevPx, isGold);
      }).catch(() => {});
    }

    /* Vérifier expansion */
    _checkExpand();
  }

  function _rollback(col, row, prevPx, wasGold) {
    if (prevPx) {
      _applyPixel(col, row, prevPx.color, prevPx.user, false);
    } else {
      pixelMap.delete(`${col},${row}`);
      filledCount = Math.max(0, filledCount - 1);
      _erasePixel(col, row);
    }
    if (wasGold) window.goldStock = Math.min(window.GOLD_MAX_ACTIVE || 12, (window.goldStock || 0) + 1);
    else         window.stock     = Math.min(window.STOCK_CAP        || 60, (window.stock     || 0) + 1);
    if (window.updateStockUI) window.updateStockUI();
    window.showToast('❌ Pixel refusé');
  }

  /* ═══════════════════════════════════════════════════════════
     UNDO (30 secondes)
  ═══════════════════════════════════════════════════════════ */
  function undo() {
    if (!_lastPixel) { window.showToast('Rien à annuler'); return; }
    const { col, row, prevColor, prevUser } = _lastPixel;
    clearTimeout(_undoTimer);
    _lastPixel = null;
    document.getElementById('btn-undo')?.classList.remove('active');

    if (prevColor) {
      _applyPixel(col, row, prevColor, prevUser, false);
      /* Resynchroniser avec le serveur */
      if (_socketReady && _socket) {
        _socket.emit('pixel:place', { col, row, color: prevColor, username: window.piUsername || 'anonyme' });
      } else if (window.apiFetch) {
        window.apiFetch('/api/pixelwar/place', 'POST', { col, row, color: prevColor, username: window.piUsername }).catch(() => {});
      }
    } else {
      pixelMap.delete(`${col},${row}`);
      filledCount = Math.max(0, filledCount - 1);
      _erasePixel(col, row);
    }

    const wasGold = window.activeColor === window.GOLD_COLOR;
    if (wasGold) window.goldStock = Math.min(window.GOLD_MAX_ACTIVE || 12, (window.goldStock || 0) + 1);
    else         window.stock     = Math.min(window.STOCK_CAP        || 60, (window.stock     || 0) + 1);
    if (window.updateStockUI) window.updateStockUI();
    window.showToast('↩ Pixel annulé !');
    if (window.saveLSState) window.saveLSState();
  }

  function _startUndoTimer() {
    clearTimeout(_undoTimer);
    document.getElementById('btn-undo')?.classList.add('active');
    _undoTimer = setTimeout(() => {
      _lastPixel = null;
      document.getElementById('btn-undo')?.classList.remove('active');
    }, 30000);
  }

  /* ═══════════════════════════════════════════════════════════
     EXPANSION CANVAS
  ═══════════════════════════════════════════════════════════ */
  function _checkExpand() {
    if (filledCount / (CANVAS_W * CANVAS_H) < EXPAND_THRESHOLD) return;
    if (_socketReady && _socket) {
      _socket.emit('canvas:expand', { currentW: CANVAS_W, currentH: CANVAS_H });
    }
  }

  function _doExpand(newW, newH) {
    if (newW <= CANVAS_W || newH <= CANVAS_H) return;

    /* Copier le contenu existant */
    const tmp = document.createElement('canvas');
    tmp.width  = CANVAS_W;
    tmp.height = CANVAS_H;
    tmp.getContext('2d').drawImage(cv, 0, 0);

    CANVAS_W = newW;
    CANVAS_H = newH;
    cv.width  = newW;
    cv.height = newH;

    /* Fond du nouveau canvas */
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, newW, newH);

    /* Recopier les pixels existants */
    ctx.drawImage(tmp, 0, 0);

    /* Animation glow */
    cv.classList.add('expanding');
    setTimeout(() => cv.classList.remove('expanding'), 900);

    window.showToast(`📐 Canvas agrandi : ${newW}×${newH} !`);
    resetView();
  }

  /* ═══════════════════════════════════════════════════════════
     SOCKET.IO CLIENT
  ═══════════════════════════════════════════════════════════ */
  function _initSocket() {
    if (typeof io === 'undefined') {
      console.warn('[GP] Socket.io indisponible — fallback HTTP');
      return;
    }

    _socket = io({ transports: ['websocket', 'polling'], reconnectionAttempts: 10 });

    _socket.on('connect', () => {
      _socketReady = true;
      console.log('[GP] Socket connecté :', _socket.id);
    });

    _socket.on('disconnect', () => {
      _socketReady = false;
      console.warn('[GP] Socket déconnecté');
    });

    /* État initial envoyé par le serveur à la connexion */
    _socket.on('canvas:state', ({ pixels, canvasW, canvasH }) => {
      if (canvasW && canvasH && (canvasW > CANVAS_W || canvasH > CANVAS_H)) {
        _doExpand(canvasW, canvasH);
      }
      if (!Array.isArray(pixels)) return;
      pixels.forEach(({ col, row, color, user }) => {
        if (_inBounds(col, row)) _applyPixel(col, row, color, user, false);
      });
      /* Indexer ses propres pixels pour la Sentinelle */
      if (window.SENTINEL && window.piUsername) {
        pixels
          .filter(p => p.user === '@' + window.piUsername)
          .forEach(p => window.SENTINEL.registerMyPixel(p.col, p.row));
      }
    });

    /* Pixel entrant d'un autre joueur */
    _socket.on('pixel:update', ({ col, row, color, user }) => {
      if (!_inBounds(col, row)) return;
      if (user === '@' + window.piUsername) return;   // déjà appliqué en optimiste
      if (window.SENTINEL) window.SENTINEL.checkIncoming(col, row, user || '?');
      _applyPixel(col, row, color, user, true);
    });

    /* ACK du serveur pour le pixel posé */
    _socket.on('pixel:ack', ({ col, row, ok, error, stock }) => {
      if (!ok) {
        const wasGold = window.activeColor === window.GOLD_COLOR;
        _rollback(col, row, _lastPixel ? { color: _lastPixel.prevColor, user: _lastPixel.prevUser } : null, wasGold);
        window.showToast('❌ ' + (error || 'Refusé'));
      } else if (typeof stock === 'number') {
        window.stock = stock;
        if (window.updateStockUI) window.updateStockUI();
      }
    });

    /* Expansion reçue */
    _socket.on('canvas:expanded', ({ newW, newH }) => _doExpand(newW, newH));
  }

  /* ═══════════════════════════════════════════════════════════
     CHARGEMENT INITIAL (HTTP — avant que socket soit prêt)
  ═══════════════════════════════════════════════════════════ */
  async function _loadGrid() {
    if (!window.apiFetch) return;
    try {
      const data = await window.apiFetch('/api/pixelwar/grid', 'GET');
      if (!data || !Array.isArray(data.pixels)) return;
      if (data.canvasW && data.canvasH) _doExpand(data.canvasW, data.canvasH);
      data.pixels.forEach(({ col, row, color, user }) => {
        if (_inBounds(col, row)) _applyPixel(col, row, color, user, false);
      });
      if (window.SENTINEL && window.piUsername) {
        data.pixels
          .filter(p => p.user === '@' + window.piUsername)
          .forEach(p => window.SENTINEL.registerMyPixel(p.col, p.row));
      }
      /* Recalculer le zoom après chargement */
      resetView();
    } catch (e) {
      console.error('[GP] loadGrid:', e);
      window.showToast('⚠ Mode hors-ligne');
    }
  }

  /* ═══════════════════════════════════════════════════════════
     EVENT LISTENERS — UN SEUL jeu, appelé 1 fois dans init()
  ═══════════════════════════════════════════════════════════ */
  function _bindEvents() {
    /* Touch */
    container.addEventListener('touchstart', _onTouchStart, { passive: false });
    container.addEventListener('touchmove',  _onTouchMove,  { passive: false });
    container.addEventListener('touchend',   _onTouchEnd,   { passive: false });
    /* Mouse */
    container.addEventListener('mousedown', _onMouseDown);
    window.addEventListener('mousemove',    _onMouseMove);
    window.addEventListener('mouseup',      _onMouseUp);
    /* Wheel */
    container.addEventListener('wheel', _onWheel, { passive: false });
    /* Resize */
    window.addEventListener('resize', _onResize);
  }

  /* ── Touch handlers ── */
  function _onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      _tStart  = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      _tMoved  = false;
      _isPanning = false;
      _panOX   = panX;
      _panOY   = panY;
    } else if (e.touches.length === 2) {
      _pinchD0 = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      _pinchS0 = scale;
      _tMoved  = true;
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
    } else if (e.touches.length === 2 && _pinchD0) {
      _tMoved = true;
      const d  = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      _zoom(d / _pinchD0 * _pinchS0 / scale, cx, cy);
      _pinchD0 = d;
      _pinchS0 = scale;
    }
  }

  function _onTouchEnd(e) {
    e.preventDefault();
    if (e.touches.length === 0 && !_tMoved) {
      const t = e.changedTouches[0];
      const { col, row } = _screenToCell(t.clientX, t.clientY);
      placePixel(col, row);
    }
    if (e.touches.length < 2) _pinchD0 = null;
  }

  /* ── Mouse handlers ── */
  function _onMouseDown(e) {
    _mDown = true; _mPan = false;
    _mSX = e.clientX; _mSY = e.clientY;
    _mOX = panX;      _mOY = panY;
  }
  function _onMouseMove(e) {
    if (!_mDown) return;
    const dx = e.clientX - _mSX, dy = e.clientY - _mSY;
    if (!_mPan && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) _mPan = true;
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
  function _onResize() {
    clearTimeout(window._gpResizeT);
    window._gpResizeT = setTimeout(resetView, 80);
  }

  /* ── Coords overlay ── */
  function _updateCoords(sx, sy) {
    const el = document.getElementById('px-coords');
    if (!el) return;
    const { col, row } = _screenToCell(sx, sy);
    el.textContent = _inBounds(col, row) ? `X:${col} Y:${row}` : '—';
  }

  /* ═══════════════════════════════════════════════════════════
     ZOOM TO CELL — pour la Sentinelle
  ═══════════════════════════════════════════════════════════ */
  function zoomToCell(col, row) {
    if (!container) return;
    const vw = container.clientWidth, vh = container.clientHeight;
    const targetScale = Math.min(Math.max(scale * 2, 6), 20);
    panX  = vw / 2 - col * targetScale;
    panY  = vh / 2 - row * targetScale;
    scale = targetScale;
    _applyTransform();
  }

  /* ═══════════════════════════════════════════════════════════
     START ENGINE — appelé par startGame() dans goldpixel.html
  ═══════════════════════════════════════════════════════════ */
  async function startEngine() {
    init();            // canvas + palette + events (1 seul appel)
    _initSocket();     // socket.io
    await _loadGrid(); // chargement initial HTTP
  }

  /* ═══════════════════════════════════════════════════════════
     API PUBLIQUE
  ═══════════════════════════════════════════════════════════ */
  return {
    startEngine,
    pick:       _selectColor,
    pickGold,
    zoomIn,
    zoomOut,
    resetView,
    undo,
    zoomToCell,
  };

})();
