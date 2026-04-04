const GP = (() => {
  'use strict';

  /* ── CONFIG ────────────────────────────────────────────────── */
  const DEV_MODE      = true;
  const STOCK_MAX     = DEV_MODE ? 999999 : 5;
  const COOLDOWN_MS   = DEV_MODE ? 0 : 30000;

  if (DEV_MODE) window.DEV_MODE = true;

  /* ── ÉTAT ──────────────────────────────────────────────────── */
  let _localStock   = STOCK_MAX;
  let _cooldownLeft = 0;

  // Undo
  let _undo  = null;
  let _undoT = null;

  /* ══════════════════════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════════════════════ */
  function init() {
    _buildPalette();
    _startCooldownTick();
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
      el.dataset.color = c;

      el.addEventListener('click', () => _pick(c));
      el.addEventListener('touchstart', e => {
        e.preventDefault();
        _pick(c);
      }, { passive: false });

      grid.appendChild(el);
    });

    _syncGold();
    _updatePreview(window.activeColor);
  }

  function _pick(c) {
    if (c === window.GOLD_COLOR) {
      pickGold();
      return;
    }

    window.activeColor = c;

    document.querySelectorAll('.px-swatch').forEach(el =>
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

          if (_localStock < STOCK_MAX) {
            _cooldownLeft = COOLDOWN_MS / 1000;
          }
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
     ACTIONS
  ══════════════════════════════════════════════════════════════ */
  function placePixel(col, row) {
    const isGold = window.activeColor === window.GOLD_COLOR;

    if (!isGold && _localStock <= 0) {
      window.showToast?.(`⏳ +1 pixel dans ${_cooldownLeft}s`);
      return;
    }

    if (!isGold) {
      _localStock = Math.max(0, _localStock - 1);

      if (_cooldownLeft <= 0) {
        _cooldownLeft = COOLDOWN_MS / 1000;
      }

      _updateCooldownUI();
    }

    window.pixelsPlaced = (window.pixelsPlaced || 0) + 1;
    window.updateStockUI?.();

    // 👉 futur canvas ici
    console.log('Pixel placé:', col, row, window.activeColor);
  }

  function undo() {
    if (!_undo) {
      window.showToast?.('Rien à annuler');
      return;
    }

    clearTimeout(_undoT);
    _undo = null;
    _updateUndoUI();

    if (_localStock < STOCK_MAX) {
      _localStock++;
      _updateCooldownUI();
    }
  }

  function _updateUndoUI() {
    const b = document.getElementById('btn-undo');
    if (!b) return;
    b.classList.toggle('active', !!_undo);
  }

  /* ══════════════════════════════════════════════════════════════
     START
  ══════════════════════════════════════════════════════════════ */
  async function startEngine() {
    init();
  }

  Object.defineProperty(window, '_localStock', {
    get: () => _localStock,
    configurable: true
  });

  return {
    startEngine,
    pick: _pick,
    pickGold,
    undo,
    placePixel
  };

})();
