/* ═══════════════════════════════════════════════════════════════════
   GP ENGINE v3 — Gold Pixel
   Games/Goldpixel/gp-engine.js

   Architecture :
   ─ Canvas 3000×3000 px, 1 cellule = 1 px réel (fillRect col,row,1,1)
   ─ Zoom CSS transform uniquement, transform-origin:0 0
   ─ Coordonnées via cv.getBoundingClientRect() → aucun décalage
   ─ Polling HTTP /api/pixelwar/grid toutes les 3s (delta depuis lastTs)
   ─ Socket.io pour broadcast instantané (si disponible)
   ─ Sentinelle : détection adjacente + écrasement, radar CSS
   ─ Un seul jeu d'event listeners

   Dépendances window (injectées par goldpixel.html) :
     COLORS, GOLD_COLOR, activeColor, stock, goldStock
     rechargeLeft, pixelsPlaced, piUsername, piConnected
     STOCK_CAP, GOLD_MAX_ACTIVE, updateStockUI, saveLSState
     showToast, apiFetch, getRechargeS, SENTINEL
═══════════════════════════════════════════════════════════════════ */

const GP = (() => {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     CONFIG
  ───────────────────────────────────────────────────────────── */
  const CANVAS_W_INIT    = 3000;
  const CANVAS_H_INIT    = 3000;
  const BG               = '#f5f0e8';
  const BORDER_PX        = 2;      // border CSS du canvas (doit correspondre au CSS)
  const POLL_MS          = 3000;   // polling delta toutes les 3s
  const UNDO_TIMEOUT_MS  = 30000;  // 30s pour annuler

  /* ─────────────────────────────────────────────────────────────
     ÉTAT INTERNE
  ───────────────────────────────────────────────────────────── */
  let CANVAS_W = CANVAS_W_INIT;
  let CANVAS_H = CANVAS_H_INIT;

  // DOM
  let cv, ctx, container;

  // Pan / Zoom
  let scale = 1;
  let panX  = 0;
  let panY  = 0;

  // Touch
  let _touch1    = null;   // { x, y, panX, panY } — 1 doigt
  let _tMoved    = false;
  let _isPanning = false;
  let _pinch0    = null;   // distance initiale pinch
  let _pinchS0   = 1;      // scale au début du pinch

  // Mouse
  let _mDown = false;
  let _mPan  = false;
  let _mX0 = 0, _mY0 = 0, _mPanX0 = 0, _mPanY0 = 0;

  // Pixels
  const _pixMap = new Map();  // "col,row" → { color, user }
  let _filledCount = 0;

  // Undo
  let _undo     = null;   // { col, row, prevColor, prevUser, wasGold }
  let _undoT    = null;

  // Polling
  let _pollTimer  = null;
  let _lastTs     = 0;
  let _gridLoaded = false;

  // Socket.io (optionnel)
  let _sock      = null;
  let _sockReady = false;

  /* ─────────────────────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────────────────────── */
  function init() {
    cv        = document.getElementById('gameCanvas');
    ctx       = cv.getContext('2d');
    container = document.getElementById('canvasContainer');

    cv.width  = CANVAS_W;
    cv.height = CANVAS_H;

    // Fond initial — seul redraw complet autorisé
    _drawBg(0, 0, CANVAS_W, CANVAS_H);

    _buildPalette();
    _bindEvents();
    requestAnimationFrame(resetView);
  }

  /* ─────────────────────────────────────────────────────────────
     BACKGROUND — appelé uniquement dans init() et _expand()
  ───────────────────────────────────────────────────────────── */
  function _drawBg(x, y, w, h) {
    ctx.fillStyle = BG;
    ctx.fillRect(x, y, w, h);
  }

  /* ─────────────────────────────────────────────────────────────
     RESET VIEW — fit canvas dans le container, via rAF
  ───────────────────────────────────────────────────────────── */
  function resetView() {
    if (!container) return;
    const vw = container.clientWidth  || container.offsetWidth  || 1;
    const vh = container.clientHeight || container.offsetHeight || 1;

    // Scale "fit" avec marge pour que la border soit visible
    const m  = BORDER_PX + 2;
    const s  = Math.min((vw - m * 2) / CANVAS_W, (vh - m * 2) / CANVAS_H);
    scale    = Math.max(s, 0.01);

    // Centrer
    panX = Math.round((vw - CANVAS_W * scale) / 2);
    panY = Math.round((vh - CANVAS_H * scale) / 2);

    _applyTransform();
  }

  /* ─────────────────────────────────────────────────────────────
     TRANSFORM — applique panX/panY/scale au canvas CSS
  ───────────────────────────────────────────────────────────── */
  function _applyTransform() {
    if (cv) cv.style.transform = `translate(${panX}px,${panY}px) scale(${scale})`;
  }

  /* ─────────────────────────────────────────────────────────────
     ZOOM
  ───────────────────────────────────────────────────────────── */
  function zoomIn()  { _zoom(1.35); }
  function zoomOut() { _zoom(0.75); }

  function _zoom(factor, pivotX, pivotY) {
    if (!container) return;
    const vw = container.clientWidth;
    const vh = container.clientHeight;
    if (pivotX === undefined) pivotX = vw / 2;
    if (pivotY === undefined) pivotY = vh / 2;

    const newScale = Math.min(Math.max(scale * factor, 0.01), 80);
    const r        = newScale / scale;
    panX  = pivotX - (pivotX - panX) * r;
    panY  = pivotY - (pivotY - panY) * r;
    scale = newScale;
    _applyTransform();
  }

  /* ─────────────────────────────────────────────────────────────
     COORDONNÉES — écran → cellule canvas
     Utilise getBoundingClientRect() du canvas (après transform CSS)
     pour une précision pixel-perfect quelle que soit la transformation.
  ───────────────────────────────────────────────────────────── */
  function _screenToCell(sx, sy) {
    const r     = cv.getBoundingClientRect();
    const ratioX = (r.width  - BORDER_PX * 2) / CANVAS_W;
    const ratioY = (r.height - BORDER_PX * 2) / CANVAS_H;
    return {
      col: Math.floor((sx - r.left - BORDER_PX) / ratioX),
      row: Math.floor((sy - r.top  - BORDER_PX) / ratioY),
    };
  }

  function _inBounds(col, row) {
    return col >= 0 && col < CANVAS_W && row >= 0 && row < CANVAS_H;
  }

  /* ─────────────────────────────────────────────────────────────
     DESSIN PIXEL — fillRect(col, row, 1, 1) exclusivement
  ───────────────────────────────────────────────────────────── */
  function _drawPixel(col, row, color) {
    ctx.fillStyle = color;
    ctx.fillRect(col, row, 1, 1);
  }

  function _erasePixel(col, row) {
    ctx.fillStyle = BG;
    ctx.fillRect(col, row, 1, 1);
  }

  /* Pop-in : alpha 0→1 en 6 frames rAF */
  function _drawPixelAnimated(col, row, color) {
    let step = 0;
    const run = () => {
      step++;
      ctx.globalAlpha = step / 6;
      ctx.fillStyle   = color;
      ctx.fillRect(col, row, 1, 1);
      ctx.globalAlpha = 1;
      if (step < 6) requestAnimationFrame(run);
    };
    requestAnimationFrame(run);
  }

  /* Appliquer un pixel dans la Map + canvas */
  function _applyPixel(col, row, color, user, animate) {
    const key   = `${col},${row}`;
    const isNew = !_pixMap.has(key);
    _pixMap.set(key, { color, user });
    if (isNew) _filledCount++;
    if (animate) _drawPixelAnimated(col, row, color);
    else         _drawPixel(col, row, color);
  }

  /* ─────────────────────────────────────────────────────────────
     PALETTE UI — construite à partir de window.COLORS
  ───────────────────────────────────────────────────────────── */
  function _buildPalette() {
    const grid = document.getElementById('palette-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const colors = (window.COLORS || []).filter(c => c !== window.GOLD_COLOR);
    colors.forEach(c => {
      const el = document.createElement('div');
      el.className        = 'px-swatch' + (c === window.activeColor ? ' active' : '');
      el.style.background = c;
      el.addEventListener('click', () => _pick(c));
      el.addEventListener('touchstart', e => { e.preventDefault(); _pick(c); }, { passive: false });
      grid.appendChild(el);
    });
    _syncGold();
    _updatePreview(window.activeColor);
  }

  function _pick(c) {
    if (c === window.GOLD_COLOR) { pickGold(); return; }
    if ((window.stock || 0) <= 0) { window.showToast('📦 Stock vide !'); return; }
    window.activeColor = c;
    document.querySelectorAll('.px-swatch').forEach(el =>
      el.classList.toggle('active',
        el.style.backgroundColor === c || el.style.background === c)
    );
    document.getElementById('btn-gold')?.classList.remove('active');
    _updatePreview(c);
  }

  function pickGold() {
    if ((window.goldStock || 0) <= 0) { window.showToast('✦ Stock Gold épuisé !'); return; }
    window.activeColor = window.GOLD_COLOR;
    document.querySelectorAll('.px-swatch').forEach(el => el.classList.remove('active'));
    _syncGold();
    _updatePreview(window.GOLD_COLOR);
  }

  function _syncGold() {
    const gb = document.getElementById('btn-gold');
    if (!gb) return;
    gb.classList.toggle('active', window.activeColor === window.GOLD_COLOR);
    gb.classList.toggle('empty',  (window.goldStock || 0) <= 0);
  }

  function _updatePreview(color) {
    const el = document.getElementById('color-preview');
    if (el) el.style.background = color || '#3690ea';
  }

  /* ─────────────────────────────────────────────────────────────
     PLACE PIXEL
  ───────────────────────────────────────────────────────────── */
  function placePixel(col, row) {
    if (!_inBounds(col, row)) return;

    const isGold = window.activeColor === window.GOLD_COLOR;
    if (isGold  && (window.goldStock || 0) <= 0) { window.showToast('✦ Stock Gold épuisé !'); return; }
    if (!isGold && (window.stock     || 0) <= 0) { window.showToast('📦 Stock vide !');       return; }

    const color = window.activeColor;
    const key   = `${col},${row}`;
    const prev  = _pixMap.get(key) || null;

    // Sauvegarder pour undo — capturer isGold au moment du clic
    _undo = { col, row, prevColor: prev?.color || null, prevUser: prev?.user || null, wasGold: isGold };
    _startUndoTimer();

    // Mise à jour optimiste
    _applyPixel(col, row, color, '@' + (window.piUsername || 'anon'), true);

    // Décrémenter stock
    if (isGold) {
      window.goldStock = Math.max(0, (window.goldStock || 0) - 1);
    } else {
      window.stock--;
      if ((window.rechargeLeft || 0) <= 0 && window.getRechargeS)
        window.rechargeLeft = window.getRechargeS();
    }
    window.pixelsPlaced = (window.pixelsPlaced || 0) + 1;
    window.updateStockUI?.();
    _syncGold();
    window.saveLSState?.();

    // Flash visuel
    const fl = document.getElementById('px-flash');
    if (fl) { fl.classList.add('on'); setTimeout(() => fl.classList.remove('on'), 80); }

    // Envoi
    _sendPixel(col, row, color, isGold, prev);

    // Vérifier expansion
    _checkExpand();
  }

  function _sendPixel(col, row, color, isGold, prevPx) {
    if (_sockReady && _sock) {
      _sock.emit('pixel:place', { col, row, color, username: window.piUsername || 'anonyme' });
    } else if (window.apiFetch) {
      window.apiFetch('/api/pixelwar/place', 'POST', {
        col, row, color, username: window.piUsername,
      }).then(d => {
        if (d && !d.ok) _rollback(col, row, prevPx, isGold);
      }).catch(() => {});
    }
  }

  function _rollback(col, row, prevPx, wasGold) {
    if (prevPx) {
      _applyPixel(col, row, prevPx.color, prevPx.user, false);
    } else {
      _pixMap.delete(`${col},${row}`);
      _filledCount = Math.max(0, _filledCount - 1);
      _erasePixel(col, row);
    }
    if (wasGold) window.goldStock = Math.min(window.GOLD_MAX_ACTIVE || 12, (window.goldStock || 0) + 1);
    else         window.stock     = Math.min(window.STOCK_CAP        || 60, (window.stock     || 0) + 1);
    window.updateStockUI?.();
    window.showToast('❌ Pixel refusé');
  }

  /* ─────────────────────────────────────────────────────────────
     UNDO
  ───────────────────────────────────────────────────────────── */
  function undo() {
    if (!_undo) { window.showToast('Rien à annuler'); return; }
    const { col, row, prevColor, prevUser, wasGold } = _undo;
    clearTimeout(_undoT);
    _undo = null;
    document.getElementById('btn-undo')?.classList.remove('active');

    if (prevColor) {
      _applyPixel(col, row, prevColor, prevUser, false);
      if (_sockReady && _sock) {
        _sock.emit('pixel:place', { col, row, color: prevColor, username: window.piUsername || 'anonyme' });
      } else if (window.apiFetch) {
        window.apiFetch('/api/pixelwar/place', 'POST',
          { col, row, color: prevColor, username: window.piUsername }).catch(() => {});
      }
    } else {
      _pixMap.delete(`${col},${row}`);
      _filledCount = Math.max(0, _filledCount - 1);
      _erasePixel(col, row);
    }

    if (wasGold) window.goldStock = Math.min(window.GOLD_MAX_ACTIVE || 12, (window.goldStock || 0) + 1);
    else         window.stock     = Math.min(window.STOCK_CAP        || 60, (window.stock     || 0) + 1);
    window.updateStockUI?.();
    window.showToast('↩ Pixel annulé !');
    window.saveLSState?.();
  }

  function _startUndoTimer() {
    clearTimeout(_undoT);
    document.getElementById('btn-undo')?.classList.add('active');
    _undoT = setTimeout(() => {
      _undo = null;
      document.getElementById('btn-undo')?.classList.remove('active');
    }, UNDO_TIMEOUT_MS);
  }

  /* ─────────────────────────────────────────────────────────────
     EXPANSION CANVAS
  ───────────────────────────────────────────────────────────── */
  function _checkExpand() {
    if (_filledCount / (CANVAS_W * CANVAS_H) < 0.65) return;
    if (_sockReady && _sock) {
      _sock.emit('canvas:expand', { currentW: CANVAS_W, currentH: CANVAS_H });
    }
  }

  function _expand(newW, newH) {
    if (newW <= CANVAS_W || newH <= CANVAS_H) return;

    // Sauvegarder le contenu
    const tmp = document.createElement('canvas');
    tmp.width  = CANVAS_W;
    tmp.height = CANVAS_H;
    tmp.getContext('2d').drawImage(cv, 0, 0);

    CANVAS_W = newW;
    CANVAS_H = newH;
    cv.width  = newW;
    cv.height = newH;

    _drawBg(0, 0, newW, newH);
    ctx.drawImage(tmp, 0, 0);

    // Garder le centre visuel
    const vw = container.clientWidth;
    const vh = container.clientHeight;
    const m  = BORDER_PX + 2;
    const fitScale = Math.min((vw - m * 2) / newW, (vh - m * 2) / newH);
    if (scale < fitScale * 0.3) {
      scale = fitScale;
      panX  = Math.round((vw - newW * scale) / 2);
      panY  = Math.round((vh - newH * scale) / 2);
    }
    _applyTransform();

    cv.classList.add('expanding');
    setTimeout(() => cv.classList.remove('expanding'), 900);
    window.showToast(`📐 Canvas agrandi : ${newW}×${newH}`);
  }

  /* ─────────────────────────────────────────────────────────────
     POLLING HTTP — delta toutes les 3s
  ───────────────────────────────────────────────────────────── */
  async function _loadGrid() {
    if (!window.apiFetch) return;
    try {
      const data = await window.apiFetch('/api/pixelwar/grid', 'GET');
      if (!data?.pixels) return;
      if (data.canvasW && data.canvasH) _expand(data.canvasW, data.canvasH);
      data.pixels.forEach(({ col, row, color, user }) => {
        if (_inBounds(col, row)) _applyPixel(col, row, color, user, false);
      });
      // Indexer les pixels du joueur pour la Sentinelle
      if (window.SENTINEL && window.piUsername) {
        data.pixels
          .filter(p => p.user === '@' + window.piUsername)
          .forEach(p => window.SENTINEL.registerMyPixel(p.col, p.row));
      }
      if (data.ts) _lastTs = data.ts;
      _gridLoaded = true;
      resetView();
    } catch (e) {
      console.error('[GP] loadGrid:', e);
      window.showToast('⚠ Hors-ligne — tentative...');
    }
  }

  async function _poll() {
    if (!window.apiFetch || !_lastTs) return;
    try {
      const data = await window.apiFetch(`/api/pixelwar/grid?since=${_lastTs}`, 'GET');
      if (!data?.pixels?.length) {
        if (data?.ts) _lastTs = data.ts;
        return;
      }
      data.pixels.forEach(({ col, row, color, user }) => {
        if (!_inBounds(col, row)) return;
        if (user === '@' + window.piUsername) return; // déjà appliqué en optimiste
        // Sentinelle
        if (window.SENTINEL) window.SENTINEL.checkIncoming(col, row, user || '?');
        _applyPixel(col, row, color, user, true);
      });
      if (data.ts) _lastTs = data.ts;
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────
     SOCKET.IO — broadcast instantané (complète le polling)
  ───────────────────────────────────────────────────────────── */
  function _initSocket() {
    if (typeof io === 'undefined') return;

    _sock = io({ transports: ['websocket', 'polling'], reconnectionAttempts: 8 });

    _sock.on('connect',    () => { _sockReady = true; });
    _sock.on('disconnect', () => { _sockReady = false; });

    // État initial via socket (ignoré si HTTP déjà fait)
    _sock.on('canvas:state', ({ pixels, canvasW, canvasH }) => {
      if (_gridLoaded) {
        if (canvasW > CANVAS_W || canvasH > CANVAS_H) _expand(canvasW, canvasH);
        return;
      }
      if (canvasW && canvasH) _expand(canvasW, canvasH);
      if (!Array.isArray(pixels)) return;
      pixels.forEach(({ col, row, color, user }) => {
        if (_inBounds(col, row)) _applyPixel(col, row, color, user, false);
      });
      if (window.SENTINEL && window.piUsername) {
        pixels.filter(p => p.user === '@' + window.piUsername)
              .forEach(p => window.SENTINEL.registerMyPixel(p.col, p.row));
      }
      _gridLoaded = true;
      resetView();
    });

    // Pixel entrant en temps réel
    _sock.on('pixel:update', ({ col, row, color, user }) => {
      if (!_inBounds(col, row)) return;
      if (user === '@' + window.piUsername) return;
      if (window.SENTINEL) window.SENTINEL.checkIncoming(col, row, user || '?');
      _applyPixel(col, row, color, user, true);
    });

    // ACK pixel posé
    _sock.on('pixel:ack', ({ col, row, ok, error, stock }) => {
      if (!ok) {
        const wasGold = _undo?.wasGold ?? (window.activeColor === window.GOLD_COLOR);
        const prev    = _undo ? { color: _undo.prevColor, user: _undo.prevUser } : null;
        _rollback(col, row, prev, wasGold);
        window.showToast('❌ ' + (error || 'Refusé'));
      } else if (typeof stock === 'number') {
        window.stock = stock;
        window.updateStockUI?.();
      }
    });

    // Expansion
    _sock.on('canvas:expanded', ({ newW, newH }) => _expand(newW, newH));

    // Reset mensuel — vider le canvas local et recharger
    _sock.on('canvas:reset', ({ msg }) => {
      // Vider la Map locale
      _pixMap.clear();
      _filledCount = 0;
      // Redessiner le fond
      CANVAS_W = CANVAS_W_INIT;
      CANVAS_H = CANVAS_H_INIT;
      cv.width  = CANVAS_W;
      cv.height = CANVAS_H;
      _drawBg(0, 0, CANVAS_W, CANVAS_H);
      _lastTs = 0;
      _gridLoaded = false;
      requestAnimationFrame(resetView);
      if (window.showToast) window.showToast(msg || '🔄 Canvas réinitialisé !');
    });
  }

  /* ─────────────────────────────────────────────────────────────
     ZOOM TO CELL — Sentinelle
  ───────────────────────────────────────────────────────────── */
  function zoomToCell(col, row) {
    if (!container) return;
    const vw = container.clientWidth;
    const vh = container.clientHeight;
    const targetScale = Math.min(Math.max(scale * 2, 6), 20);
    panX  = Math.round(vw / 2 - col * targetScale);
    panY  = Math.round(vh / 2 - row * targetScale);
    scale = targetScale;
    _applyTransform();
  }

  /* ─────────────────────────────────────────────────────────────
     EVENT LISTENERS — UN seul jeu, posé dans init()
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

  /* ── Touch ── */
  function _onTouchStart(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      _touch1    = { x: e.touches[0].clientX, y: e.touches[0].clientY, panX, panY };
      _tMoved    = false;
      _isPanning = false;
    } else if (e.touches.length === 2) {
      _pinch0  = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      _pinchS0 = scale;
      _tMoved  = true;
    }
  }

  function _onTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1 && _touch1) {
      const dx = e.touches[0].clientX - _touch1.x;
      const dy = e.touches[0].clientY - _touch1.y;
      if (!_isPanning && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        _isPanning = true; _tMoved = true;
      }
      if (_isPanning) {
        panX = _touch1.panX + dx;
        panY = _touch1.panY + dy;
        _applyTransform();
      }
      _updateCoords(e.touches[0].clientX, e.touches[0].clientY);
    } else if (e.touches.length === 2 && _pinch0 !== null) {
      _tMoved = true;
      const d   = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const cx  = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy  = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const ns  = Math.min(Math.max(_pinchS0 * (d / _pinch0), 0.01), 80);
      const r   = ns / scale;
      panX  = cx - (cx - panX) * r;
      panY  = cy - (cy - panY) * r;
      scale = ns;
      _applyTransform();
    }
  }

  function _onTouchEnd(e) {
    e.preventDefault();
    if (e.touches.length === 0 && !_tMoved && _touch1) {
      const t = e.changedTouches[0];
      const { col, row } = _screenToCell(t.clientX, t.clientY);
      placePixel(col, row);
    }
    if (e.touches.length < 2) _pinch0 = null;
    if (e.touches.length === 0) _touch1 = null;
  }

  /* ── Mouse ── */
  function _onMouseDown(e) {
    _mDown = true; _mPan = false;
    _mX0 = e.clientX; _mY0 = e.clientY;
    _mPanX0 = panX;   _mPanY0 = panY;
  }
  function _onMouseMove(e) {
    if (!_mDown) return;
    const dx = e.clientX - _mX0;
    const dy = e.clientY - _mY0;
    if (!_mPan && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) _mPan = true;
    if (_mPan) { panX = _mPanX0 + dx; panY = _mPanY0 + dy; _applyTransform(); }
    _updateCoords(e.clientX, e.clientY);
  }
  function _onMouseUp(e) {
    if (!_mPan && _mDown) {
      const { col, row } = _screenToCell(e.clientX, e.clientY);
      placePixel(col, row);
    }
    _mDown = false; _mPan = false;
  }

  /* ── Wheel ── */
  function _onWheel(e) {
    e.preventDefault();
    _zoom(e.deltaY < 0 ? 1.2 : 0.83, e.clientX, e.clientY);
  }

  /* ── Coords overlay ── */
  function _updateCoords(sx, sy) {
    const el = document.getElementById('px-coords');
    if (!el) return;
    const { col, row } = _screenToCell(sx, sy);
    el.textContent = _inBounds(col, row) ? `X:${col} Y:${row}` : '—';
  }

  /* ─────────────────────────────────────────────────────────────
     START ENGINE
  ───────────────────────────────────────────────────────────── */
  async function startEngine() {
    init();
    _initSocket();
    await _loadGrid();
    _pollTimer = setInterval(_poll, POLL_MS);
  }

  /* ─────────────────────────────────────────────────────────────
     API PUBLIQUE
  ───────────────────────────────────────────────────────────── */
  return {
    startEngine,
    pick:              _pick,
    pickGold,
    zoomIn,
    zoomOut,
    resetView,
    undo,
    zoomToCell,
  };

})();
