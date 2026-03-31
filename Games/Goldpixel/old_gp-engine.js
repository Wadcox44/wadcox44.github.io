/* ═══════════════════════════════════════════════════════════════
   GP ENGINE v4 — Gold Pixel  (reset total Partie 2)
   Games/Goldpixel/gp-engine.js

   RÈGLES STRICTES :
   ─ Canvas 3000×3000  |  1 cellule = 1 px réel
   ─ fillRect(col, row, 1, 1) exclusivement en live
   ─ Fond : fillRect(0,0,W,H) uniquement dans init() et _expand()
   ─ Zoom : CSS transform uniquement, transform-origin:0 0
   ─ Coords : cv.getBoundingClientRect() + correction border
   ─ Polling : GET /api/pixelwar/grid?since=ts toutes les 3s
   ─ Socket.io : broadcast instantané (complète le polling)
   ─ 1 seul jeu de listeners, posé dans _bindEvents()
   ─ Cooldown : 30s côté client, 5 pixels max

   Interface window (injectée par goldpixel.html) :
     COLORS, GOLD_COLOR, activeColor, stock, goldStock
     rechargeLeft, pixelsPlaced, piUsername, piConnected
     STOCK_CAP, GOLD_MAX_ACTIVE, updateStockUI, saveLSState
     showToast, apiFetch, getRechargeS, SENTINEL
═══════════════════════════════════════════════════════════════ */

const GP = (() => {
  'use strict';

  /* ── CONFIG ────────────────────────────────────────────────── */
  const CANVAS_W_INIT = 3000;
  const CANVAS_H_INIT = 3000;
  const BG            = '#f5f0e8';
  const BORDER_PX     = 2;         // border CSS du canvas (px)
  const POLL_MS       = 3000;      // polling delta
  const UNDO_MS       = 30000;     // 30s pour annuler
  const STOCK_MAX     = 5;         // max pixels locaux
  const COOLDOWN_MS   = 30000;     // 30s entre pixels

  /* ── ÉTAT ──────────────────────────────────────────────────── */
  let CANVAS_W = CANVAS_W_INIT;
  let CANVAS_H = CANVAS_H_INIT;

  // DOM
  let cv, ctx, wrap;

  // Transform
  let scale = 1, panX = 0, panY = 0;

  // Touch
  let _t1       = null;   // { x, y, panX0, panY0 }
  let _tMoved   = false;
  let _isPan    = false;
  let _pinch0   = null;
  let _pinchS0  = 1;

  // Mouse
  let _mDown = false, _mPan = false;
  let _mX0 = 0, _mY0 = 0, _mPX0 = 0, _mPY0 = 0;

  // Pixels
  const _pix = new Map();   // "col,row" → { color, user }
  let _filled = 0;

  // Cooldown local (30s, 5 pixels max)
  let _localStock    = STOCK_MAX;
  let _cooldownTimer = null;
  let _cooldownLeft  = 0;

  // Undo
  let _undo     = null;   // { col, row, prevColor, prevUser, wasGold }
  let _undoT    = null;

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
    cv   = document.getElementById('gameCanvas');
    ctx  = cv.getContext('2d');
    wrap = document.getElementById('canvas-wrap');

    cv.width  = CANVAS_W;
    cv.height = CANVAS_H;

    _drawBg(0, 0, CANVAS_W, CANVAS_H);
    _buildPalette();
    _bindEvents();
    _startCooldownTick();
    requestAnimationFrame(resetView);
  }

  /* ── Fond pur ── */
  function _drawBg(x, y, w, h) {
    ctx.fillStyle = BG;
    ctx.fillRect(x, y, w, h);
  }

  /* ══════════════════════════════════════════════════════════════
     RESET VIEW — fit exact dans le container via rAF
  ══════════════════════════════════════════════════════════════ */
  function resetView() {
    if (!wrap) return;
    const vw = wrap.clientWidth  || wrap.offsetWidth  || 1;
    const vh = wrap.clientHeight || wrap.offsetHeight || 1;

    // Marge = border + 2px pour qu'elle soit visible
    const m  = BORDER_PX + 2;
    const s  = Math.min((vw - m * 2) / CANVAS_W, (vh - m * 2) / CANVAS_H);
    scale    = Math.max(s, 0.005);
    panX     = Math.round((vw - CANVAS_W * scale) / 2);
    panY     = Math.round((vh - CANVAS_H * scale) / 2);
    _applyT();
  }

  function _applyT() {
    if (cv) cv.style.transform = `translate(${panX}px,${panY}px) scale(${scale})`;
  }

  /* ══════════════════════════════════════════════════════════════
     ZOOM
  ══════════════════════════════════════════════════════════════ */
  function zoomIn()  { _zoom(1.35); }
  function zoomOut() { _zoom(0.75); }

  function _zoom(f, px, py) {
    if (!wrap) return;
    const vw = wrap.clientWidth, vh = wrap.clientHeight;
    if (px === undefined) px = vw / 2;
    if (py === undefined) py = vh / 2;
    const ns = Math.min(Math.max(scale * f, 0.005), 80);
    const r  = ns / scale;
    panX  = px - (px - panX) * r;
    panY  = py - (py - panY) * r;
    scale = ns;
    _applyT();
  }

  /* ══════════════════════════════════════════════════════════════
     COORDONNÉES  écran → cellule canvas
     getBoundingClientRect() du canvas après transform CSS
     = position réelle sans décalage quoi qu'il arrive
  ══════════════════════════════════════════════════════════════ */
  function _s2c(sx, sy) {
    const r  = cv.getBoundingClientRect();
    // ratio = taille visuelle CSS du buffer / taille buffer (= scale effectif)
    // on soustrait les borders pour tomber exactement sur la cellule
    const rx = (r.width  - BORDER_PX * 2) / CANVAS_W;
    const ry = (r.height - BORDER_PX * 2) / CANVAS_H;
    return {
      col: Math.floor((sx - r.left - BORDER_PX) / rx),
      row: Math.floor((sy - r.top  - BORDER_PX) / ry),
    };
  }

  function _ok(col, row) {
    return col >= 0 && col < CANVAS_W && row >= 0 && row < CANVAS_H;
  }

  /* ══════════════════════════════════════════════════════════════
     DESSIN  ─  fillRect(col, row, 1, 1) exclusivement
  ══════════════════════════════════════════════════════════════ */
  function _px(col, row, color) {
    ctx.fillStyle = color;
    ctx.fillRect(col, row, 1, 1);
  }

  function _erase(col, row) {
    ctx.fillStyle = BG;
    ctx.fillRect(col, row, 1, 1);
  }

  /* Pop-in : alpha 0→1 en 6 frames ≈ 100ms */
  function _pxAnim(col, row, color) {
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

  /* Flash de remplacement (overwrite) : bref éclair blanc puis couleur */
  function _pxOverwrite(col, row, color) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(col, row, 1, 1);
    setTimeout(() => { ctx.fillStyle = color; ctx.fillRect(col, row, 1, 1); }, 80);
  }

  function _applyPx(col, row, color, user, anim) {
    const key    = `${col},${row}`;
    const isNew  = !_pix.has(key);
    const wasOld = !isNew;
    _pix.set(key, { color, user });
    if (isNew) _filled++;
    if (anim) {
      if (wasOld) _pxOverwrite(col, row, color);
      else        _pxAnim(col, row, color);
    } else {
      _px(col, row, color);
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
    window.activeColor = c;
    document.querySelectorAll('.px-swatch').forEach(el =>
      el.classList.toggle('active',
        el.style.backgroundColor === c || el.style.background === c)
    );
    document.getElementById('btn-gold')?.classList.remove('active');
    _updatePreview(c);
  }

  function pickGold() {
    if ((window.goldStock || 0) <= 0) {
      window.showToast?.('✦ Stock Gold épuisé !'); return;
    }
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

  /* ══════════════════════════════════════════════════════════════
     COOLDOWN LOCAL  (30s, 5 pixels max)
     Gestion côté client uniquement — le serveur a ses propres règles.
     Affiche le compte à rebours dans #tb-cooldown.
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
     PLACE PIXEL
  ══════════════════════════════════════════════════════════════ */
  function placePixel(col, row) {
    if (!_ok(col, row)) return;

    const isGold = window.activeColor === window.GOLD_COLOR;

    // Vérification stock local
    if (!isGold && _localStock <= 0) {
      window.showToast?.(`⏳ +1 pixel dans ${_cooldownLeft}s`); return;
    }
    if (isGold && (window.goldStock || 0) <= 0) {
      window.showToast?.('✦ Stock Gold épuisé !'); return;
    }

    const color = window.activeColor;
    const key   = `${col},${row}`;
    const prev  = _pix.get(key) || null;

    // Sauvegarder pour undo
    _undo = { col, row, prevColor: prev?.color || null, prevUser: prev?.user || null, wasGold: isGold };
    _startUndoTimer();

    // Mise à jour optimiste
    _applyPx(col, row, color, '@' + (window.piUsername || 'anon'), true);

    // Décrémenter stock
    if (isGold) {
      window.goldStock = Math.max(0, (window.goldStock || 0) - 1);
      _syncGold();
    } else {
      _localStock = Math.max(0, _localStock - 1);
      if (_cooldownLeft <= 0) _cooldownLeft = COOLDOWN_MS / 1000;
    }
    _updateCooldownUI();
    window.pixelsPlaced = (window.pixelsPlaced || 0) + 1;
    window.updateStockUI?.();
    window.saveLSState?.();

    // Flash
    const fl = document.getElementById('px-flash');
    if (fl) { fl.classList.add('on'); setTimeout(() => fl.classList.remove('on'), 80); }

    // Envoi réseau
    _send(col, row, color, isGold, prev);
    _checkExpand();
  }

  function _send(col, row, color, isGold, prevPx) {
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
      _applyPx(col, row, prevPx.color, prevPx.user, false);
    } else {
      _pix.delete(`${col},${row}`);
      _filled = Math.max(0, _filled - 1);
      _erase(col, row);
    }
    if (wasGold) window.goldStock = Math.min(window.GOLD_MAX_ACTIVE || 12, (window.goldStock || 0) + 1);
    else         { _localStock = Math.min(STOCK_MAX, _localStock + 1); _updateCooldownUI(); }
    window.updateStockUI?.();
    window.showToast?.('❌ Pixel refusé');
  }

  /* ══════════════════════════════════════════════════════════════
     UNDO  (30s)
  ══════════════════════════════════════════════════════════════ */
  function undo() {
    if (!_undo) { window.showToast?.('Rien à annuler'); return; }
    const { col, row, prevColor, prevUser, wasGold } = _undo;
    clearTimeout(_undoT);
    _undo = null;
    document.getElementById('btn-undo')?.classList.remove('active');

    if (prevColor) {
      _applyPx(col, row, prevColor, prevUser, false);
      if (_sockReady && _sock)
        _sock.emit('pixel:place', { col, row, color: prevColor, username: window.piUsername || 'anonyme' });
      else if (window.apiFetch)
        window.apiFetch('/api/pixelwar/place', 'POST', { col, row, color: prevColor, username: window.piUsername }).catch(() => {});
    } else {
      _pix.delete(`${col},${row}`);
      _filled = Math.max(0, _filled - 1);
      _erase(col, row);
    }

    if (wasGold) window.goldStock = Math.min(window.GOLD_MAX_ACTIVE || 12, (window.goldStock || 0) + 1);
    else         { _localStock = Math.min(STOCK_MAX, _localStock + 1); _updateCooldownUI(); }
    window.updateStockUI?.();
    window.showToast?.('↩ Pixel annulé !');
    window.saveLSState?.();
  }

  function _startUndoTimer() {
    clearTimeout(_undoT);
    document.getElementById('btn-undo')?.classList.add('active');
    _undoT = setTimeout(() => {
      _undo = null;
      document.getElementById('btn-undo')?.classList.remove('active');
    }, UNDO_MS);
  }

  /* ══════════════════════════════════════════════════════════════
     EXPANSION CANVAS
  ══════════════════════════════════════════════════════════════ */
  function _checkExpand() {
    if (_filled / (CANVAS_W * CANVAS_H) < 0.65) return;
    if (_sockReady && _sock)
      _sock.emit('canvas:expand', { currentW: CANVAS_W, currentH: CANVAS_H });
  }

  function _expand(newW, newH) {
    if (newW <= CANVAS_W || newH <= CANVAS_H) return;

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

    // Conserver la vue si raisonnable, sinon fit
    const vw = wrap.clientWidth, vh = wrap.clientHeight;
    const m  = BORDER_PX + 2;
    const fs = Math.min((vw - m * 2) / newW, (vh - m * 2) / newH);
    if (scale < fs * 0.25) {
      scale = fs;
      panX  = Math.round((vw - newW * scale) / 2);
      panY  = Math.round((vh - newH * scale) / 2);
    }
    _applyT();

    cv.classList.add('expanding');
    setTimeout(() => cv.classList.remove('expanding'), 900);
    window.showToast?.(`📐 Canvas étendu : ${newW}×${newH}`);
  }

  /* ══════════════════════════════════════════════════════════════
     RÉSEAU  — polling HTTP delta + socket
  ══════════════════════════════════════════════════════════════ */
  async function _loadGrid() {
    if (!window.apiFetch) return;
    try {
      const d = await window.apiFetch('/api/pixelwar/grid', 'GET');
      if (!d?.pixels) return;
      if (d.canvasW && d.canvasH) _expand(d.canvasW, d.canvasH);
      d.pixels.forEach(({ col, row, color, user }) => {
        if (_ok(col, row)) _applyPx(col, row, color, user, false);
      });
      // Indexer pixels du joueur pour la Sentinelle
      if (window.SENTINEL && window.piUsername) {
        d.pixels
          .filter(p => p.user === '@' + window.piUsername)
          .forEach(p => window.SENTINEL.registerMyPixel(p.col, p.row));
      }
      if (d.ts) _lastTs = d.ts;
      _gridLoaded = true;
      requestAnimationFrame(resetView);
    } catch (e) {
      console.error('[GP] loadGrid:', e);
      window.showToast?.('⚠ Connexion en cours...');
    }
  }

  async function _poll() {
    if (!window.apiFetch || !_lastTs) return;
    try {
      const d = await window.apiFetch(`/api/pixelwar/grid?since=${_lastTs}`, 'GET');
      if (!d?.pixels?.length) { if (d?.ts) _lastTs = d.ts; return; }
      d.pixels.forEach(({ col, row, color, user }) => {
        if (!_ok(col, row)) return;
        // Ignorer ses propres pixels (déjà appliqués en optimiste)
        if (user === '@' + window.piUsername) return;
        window.SENTINEL?.checkIncoming(col, row, user || '?');
        _applyPx(col, row, color, user, true);
      });
      if (d.ts) _lastTs = d.ts;
    } catch (_) {}
  }

  /* ══════════════════════════════════════════════════════════════
     SOCKET.IO  — broadcast instantané (complète le polling)
  ══════════════════════════════════════════════════════════════ */
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
        if (_ok(col, row)) _applyPx(col, row, color, user, false);
      });
      if (window.SENTINEL && window.piUsername) {
        pixels
          .filter(p => p.user === '@' + window.piUsername)
          .forEach(p => window.SENTINEL.registerMyPixel(p.col, p.row));
      }
      _gridLoaded = true;
      requestAnimationFrame(resetView);
    });

    // Pixel entrant d'un autre joueur
    _sock.on('pixel:update', ({ col, row, color, user }) => {
      if (!_ok(col, row)) return;
      if (user === '@' + window.piUsername) return;
      window.SENTINEL?.checkIncoming(col, row, user || '?');
      _applyPx(col, row, color, user, true);
    });

    // ACK pixel posé par soi
    _sock.on('pixel:ack', ({ col, row, ok, error, stock }) => {
      if (!ok) {
        const wasGold = _undo?.wasGold ?? false;
        const prev    = _undo ? { color: _undo.prevColor, user: _undo.prevUser } : null;
        _rollback(col, row, prev, wasGold);
        window.showToast?.('❌ ' + (error || 'Refusé'));
      } else if (typeof stock === 'number') {
        // Synchroniser avec le stock serveur
        window.stock = stock;
        window.updateStockUI?.();
      }
    });

    // Expansion
    _sock.on('canvas:expanded', ({ newW, newH }) => _expand(newW, newH));

    // Reset mensuel
    _sock.on('canvas:reset', ({ msg }) => {
      _pix.clear();
      _filled = 0;
      CANVAS_W = CANVAS_W_INIT;
      CANVAS_H = CANVAS_H_INIT;
      cv.width  = CANVAS_W;
      cv.height = CANVAS_H;
      _drawBg(0, 0, CANVAS_W, CANVAS_H);
      _lastTs     = 0;
      _gridLoaded = false;
      requestAnimationFrame(resetView);
      window.showToast?.(msg || '🔄 Nouveau mois — canvas réinitialisé !');
    });
  }

  /* ══════════════════════════════════════════════════════════════
     ZOOM TO CELL  (Sentinelle)
  ══════════════════════════════════════════════════════════════ */
  function zoomToCell(col, row) {
    if (!wrap) return;
    const vw = wrap.clientWidth, vh = wrap.clientHeight;
    const ts = Math.min(Math.max(scale * 2, 6), 20);
    panX  = Math.round(vw / 2 - col * ts);
    panY  = Math.round(vh / 2 - row * ts);
    scale = ts;
    _applyT();
  }

  /* ══════════════════════════════════════════════════════════════
     EVENT LISTENERS  — UN seul jeu dans _bindEvents()
  ══════════════════════════════════════════════════════════════ */
  function _bindEvents() {
    // Touch
    wrap.addEventListener('touchstart', _onTS, { passive: false });
    wrap.addEventListener('touchmove',  _onTM, { passive: false });
    wrap.addEventListener('touchend',   _onTE, { passive: false });
    // Mouse
    wrap.addEventListener('mousedown', _onMD);
    window.addEventListener('mousemove', _onMM);
    window.addEventListener('mouseup',   _onMU);
    // Wheel
    wrap.addEventListener('wheel', _onW, { passive: false });
    // Resize
    window.addEventListener('resize', () => {
      clearTimeout(window._gpRT);
      window._gpRT = setTimeout(resetView, 80);
    });
  }

  /* ── Touch ── */
  function _onTS(e) {
    e.preventDefault();
    if (e.touches.length === 1) {
      _t1     = { x: e.touches[0].clientX, y: e.touches[0].clientY, panX0: panX, panY0: panY };
      _tMoved = false; _isPan = false;
    } else if (e.touches.length === 2) {
      _pinch0  = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY);
      _pinchS0 = scale;
      _tMoved  = true;
    }
  }

  function _onTM(e) {
    e.preventDefault();
    if (e.touches.length === 1 && _t1) {
      const dx = e.touches[0].clientX - _t1.x;
      const dy = e.touches[0].clientY - _t1.y;
      if (!_isPan && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) { _isPan = true; _tMoved = true; }
      if (_isPan) { panX = _t1.panX0 + dx; panY = _t1.panY0 + dy; _applyT(); }
      _coords(e.touches[0].clientX, e.touches[0].clientY);
    } else if (e.touches.length === 2 && _pinch0 !== null) {
      _tMoved = true;
      const d  = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                             e.touches[0].clientY - e.touches[1].clientY);
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const ns = Math.min(Math.max(_pinchS0 * (d / _pinch0), 0.005), 80);
      const r  = ns / scale;
      panX = cx - (cx - panX) * r; panY = cy - (cy - panY) * r; scale = ns;
      _applyT();
    }
  }

  function _onTE(e) {
    e.preventDefault();
    if (e.touches.length === 0 && !_tMoved && _t1) {
      const t = e.changedTouches[0];
      const { col, row } = _s2c(t.clientX, t.clientY);
      placePixel(col, row);
    }
    if (e.touches.length < 2) _pinch0 = null;
    if (e.touches.length === 0) _t1 = null;
  }

  /* ── Mouse ── */
  function _onMD(e) {
    _mDown = true; _mPan = false;
    _mX0 = e.clientX; _mY0 = e.clientY; _mPX0 = panX; _mPY0 = panY;
  }
  function _onMM(e) {
    if (!_mDown) return;
    const dx = e.clientX - _mX0, dy = e.clientY - _mY0;
    if (!_mPan && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) _mPan = true;
    if (_mPan) { panX = _mPX0 + dx; panY = _mPY0 + dy; _applyT(); }
    _coords(e.clientX, e.clientY);
  }
  function _onMU(e) {
    if (!_mPan && _mDown) {
      const { col, row } = _s2c(e.clientX, e.clientY);
      placePixel(col, row);
    }
    _mDown = false; _mPan = false;
  }

  /* ── Wheel ── */
  function _onW(e) {
    e.preventDefault();
    _zoom(e.deltaY < 0 ? 1.2 : 0.83, e.clientX, e.clientY);
  }

  /* ── Coords overlay ── */
  function _coords(sx, sy) {
    const el = document.getElementById('px-coords');
    if (!el) return;
    const { col, row } = _s2c(sx, sy);
    el.textContent = _ok(col, row) ? `X:${col}  Y:${row}` : '—';
  }

  /* ══════════════════════════════════════════════════════════════
     START ENGINE
  ══════════════════════════════════════════════════════════════ */
  async function startEngine() {
    init();
    _initSocket();
    await _loadGrid();
    _pollTimer = setInterval(_poll, POLL_MS);
  }

  /* ══════════════════════════════════════════════════════════════
     API PUBLIQUE
  ══════════════════════════════════════════════════════════════ */
  /* Exposer _localStock sur window pour que updateStockUI puisse le lire */
  Object.defineProperty(window, '_localStock', {
    get: () => _localStock,
    configurable: true,
  });

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
