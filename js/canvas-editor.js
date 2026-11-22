/**
 * Interactive Image Occlusion Canvas Editor (Pure ESM, HiDPI + Touch/Apple Pencil/Mouse).
 */

const MIN_BOX_SIZE = 0.012;
const MAX_UNDO_STEPS = 30;
const STYLE_ELEMENT_ID = 'ce-editor-default-styles';

const HANDLE_CURSORS = Object.freeze({
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
});

// Corner handles first so small boxes still prioritize corner resizing over edges
const HANDLE_ORDER = ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e'];

/**
 * Clamps a numeric value to [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Generates a unique occlusion box ID.
 * @returns {string}
 */
function createBoxId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `box_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Injects low-specificity (:where) fallback styles once into document.head
 * so the editor works cleanly standalone while remaining overridable by app CSS.
 */
function ensureDefaultStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ELEMENT_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
    :where(.ce-editor) {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      min-height: 360px;
      border: 1px solid var(--border-color, #d0d7de);
      border-radius: 12px;
      background: var(--bg-surface, #ffffff);
      overflow: hidden;
      user-select: none;
      -webkit-user-select: none;
    }
    :where(.ce-toolbar) {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border-color, #d0d7de);
      background: var(--bg-subtle, #f6f8fa);
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
    }
    :where(.ce-group) {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    :where(.ce-divider) {
      width: 1px;
      height: 20px;
      background: var(--border-color, #d0d7de);
      margin: 0 2px;
    }
    :where(.ce-btn) {
      appearance: none;
      border: 1px solid var(--border-color, #d0d7de);
      background: var(--bg-surface, #ffffff);
      color: var(--text-primary, #1f2328);
      border-radius: 7px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.25;
      cursor: pointer;
      transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    :where(.ce-btn:hover:not(:disabled)) {
      background: var(--bg-hover, #eaeef2);
    }
    :where(.ce-btn:disabled) {
      opacity: 0.45;
      cursor: not-allowed;
    }
    :where(.ce-btn.active) {
      background: var(--accent-color, #2563eb);
      border-color: var(--accent-color, #2563eb);
      color: #ffffff;
    }
    :where(.ce-btn-danger:hover:not(:disabled)) {
      background: #fee2e2;
      border-color: #ef4444;
      color: #b91c1c;
    }
    :where(.ce-zoom-label) {
      min-width: 44px;
      text-align: center;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary, #57606a);
      font-variant-numeric: tabular-nums;
    }
    :where(.ce-label-input) {
      flex: 1 1 140px;
      min-width: 120px;
      max-width: 260px;
      border: 1px solid var(--border-color, #d0d7de);
      border-radius: 7px;
      padding: 5px 9px;
      font-size: 12px;
      background: var(--bg-surface, #ffffff);
      color: var(--text-primary, #1f2328);
    }
    :where(.ce-label-input:disabled) {
      opacity: 0.55;
      background: var(--bg-subtle, #f1f5f9);
      cursor: not-allowed;
    }
    :where(.ce-count-badge) {
      margin-left: auto;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      background: var(--accent-soft, #dbeafe);
      color: var(--accent-text, #1d4ed8);
      white-space: nowrap;
    }
    :where(.ce-stage-wrap) {
      position: relative;
      flex: 1 1 420px;
      min-height: 280px;
      overflow: hidden;
      background: var(--bg-canvas, #e2e8f0);
    }
    :where(.ce-canvas) {
      display: block;
      width: 100%;
      height: 100%;
      touch-action: none;
      outline: none;
    }
    :where(.ce-empty-overlay) {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
      pointer-events: none;
      color: var(--text-secondary, #64748b);
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      font-weight: 500;
    }
    :where(.ce-empty-overlay[hidden]) {
      display: none;
    }
    :where([data-theme="dark"] .ce-editor) {
      background: #0f172a;
      border-color: #334155;
    }
    :where([data-theme="dark"] .ce-toolbar) {
      background: #1e293b;
      border-bottom-color: #334155;
    }
    :where([data-theme="dark"] .ce-btn),
    :where([data-theme="dark"] .ce-label-input) {
      background: #0f172a;
      border-color: #334155;
      color: #f1f5f9;
    }
    :where([data-theme="dark"] .ce-stage-wrap) {
      background: #0b1120;
    }
  `;

  document.head.prepend(style);
}

/**
 * Interactive HiDPI & Touch-capable Canvas Editor for Image Occlusion flashcards.
 */
export class OcclusionCanvasEditor {
  /**
   * @param {HTMLElement} containerEl
   * @param {{ onChange?: (boxes: Array<any>) => void, onSelectionChange?: (box: any|null) => void }} [callbacks]
   */
  constructor(containerEl, { onChange, onSelectionChange } = {}) {
    if (!containerEl) {
      throw new Error('OcclusionCanvasEditor requires a valid container element.');
    }

    ensureDefaultStyles();

    this.containerEl = containerEl;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.onSelectionChange = typeof onSelectionChange === 'function' ? onSelectionChange : null;

    this.imageDataUrl = null;
    this.image = null;
    this.imageLoadToken = 0;

    this.boxes = [];
    this.selectedId = null;
    this.mode = 'draw';

    this.scale = 1;
    this.fitScale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.pendingFit = false;

    this.undoStack = [];
    this.labelEditSnapshotPushed = false;

    this.pointers = new Map();
    this.pinchState = null;
    this.pinchCooldown = false;
    this.interaction = null;
    this.draftBox = null;
    this.spacePressed = false;
    this.rafId = null;

    this._buildDom();
    this._bindEvents();
    this._updateToolbarState();
    this._resizeCanvas();
  }

  /**
   * Builds the toolbar, stage wrapper, canvas, and empty placeholder inside containerEl.
   */
  _buildDom() {
    this.containerEl.innerHTML = '';

    this.rootEl = document.createElement('div');
    this.rootEl.className = 'ce-editor';
    if (this.containerEl.classList?.contains('canvas-editor-host')) {
      this.rootEl.style.border = 'none';
      this.rootEl.style.borderRadius = '0';
    }

    // Toolbar
    this.toolbarEl = document.createElement('div');
    this.toolbarEl.className = 'ce-toolbar';

    // Mode buttons group
    const modeGroup = document.createElement('div');
    modeGroup.className = 'ce-group';

    this.modeButtons = {};
    for (const [modeKey, label] of [['draw', 'Draw'], ['select', 'Select'], ['pan', 'Pan']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ce-btn';
      btn.dataset.mode = modeKey;
      btn.textContent = label;
      btn.setAttribute('aria-pressed', String(modeKey === this.mode));
      modeGroup.appendChild(btn);
      this.modeButtons[modeKey] = btn;
    }

    // Zoom group
    const zoomGroup = document.createElement('div');
    zoomGroup.className = 'ce-group';

    this.zoomOutBtn = document.createElement('button');
    this.zoomOutBtn.type = 'button';
    this.zoomOutBtn.className = 'ce-btn';
    this.zoomOutBtn.textContent = '-';
    this.zoomOutBtn.title = 'Zoom Out';

    this.zoomFitBtn = document.createElement('button');
    this.zoomFitBtn.type = 'button';
    this.zoomFitBtn.className = 'ce-btn';
    this.zoomFitBtn.textContent = 'Fit';
    this.zoomFitBtn.title = 'Fit Image to View';

    this.zoomInBtn = document.createElement('button');
    this.zoomInBtn.type = 'button';
    this.zoomInBtn.className = 'ce-btn';
    this.zoomInBtn.textContent = '+';
    this.zoomInBtn.title = 'Zoom In';

    this.zoomLabelEl = document.createElement('span');
    this.zoomLabelEl.className = 'ce-zoom-label';
    this.zoomLabelEl.textContent = '100%';

    zoomGroup.append(this.zoomOutBtn, this.zoomFitBtn, this.zoomInBtn, this.zoomLabelEl);

    // Action group
    const actionGroup = document.createElement('div');
    actionGroup.className = 'ce-group';

    this.undoBtn = document.createElement('button');
    this.undoBtn.type = 'button';
    this.undoBtn.className = 'ce-btn';
    this.undoBtn.textContent = 'Undo';
    this.undoBtn.title = 'Undo (Ctrl+Z)';

    this.deleteBtn = document.createElement('button');
    this.deleteBtn.type = 'button';
    this.deleteBtn.className = 'ce-btn ce-btn-danger';
    this.deleteBtn.textContent = 'Delete Selected';
    this.deleteBtn.title = 'Delete Selected Box (Delete / Backspace)';

    actionGroup.append(this.undoBtn, this.deleteBtn);

    // Label input
    this.labelInput = document.createElement('input');
    this.labelInput.type = 'text';
    this.labelInput.className = 'ce-label-input';
    this.labelInput.placeholder = 'Selected box label...';
    this.labelInput.disabled = true;
    this.labelInput.setAttribute('aria-label', 'Selected occlusion box label');

    // Box count badge
    this.countBadgeEl = document.createElement('span');
    this.countBadgeEl.className = 'ce-count ce-count-badge';
    this.countBadgeEl.textContent = '0 boxes';

    const div1 = document.createElement('span');
    div1.className = 'ce-divider';
    const div2 = document.createElement('span');
    div2.className = 'ce-divider';

    this.toolbarEl.append(
      modeGroup,
      div1,
      zoomGroup,
      div2,
      actionGroup,
      this.labelInput,
      this.countBadgeEl,
    );

    // Stage wrap & canvas
    this.stageWrap = document.createElement('div');
    this.stageWrap.className = 'ce-stage-wrap';
    this.stageWrap.style.position = 'relative';
    this.stageWrap.style.display = 'block';
    this.stageWrap.style.padding = '0';
    this.stageWrap.style.overflow = 'hidden';
    this.stageWrap.style.height = 'clamp(280px, 50vh, 520px)';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ce-canvas';
    this.canvas.tabIndex = 0;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.maxWidth = 'none';
    this.canvas.style.maxHeight = 'none';
    this.canvas.style.borderRadius = '0';
    this.canvas.style.boxShadow = 'none';
    this.canvas.style.touchAction = 'none';

    this.emptyOverlayEl = document.createElement('div');
    this.emptyOverlayEl.className = 'ce-empty ce-empty-overlay';
    this.emptyOverlayEl.style.position = 'absolute';
    this.emptyOverlayEl.style.inset = '0';
    this.emptyOverlayEl.style.display = 'flex';
    this.emptyOverlayEl.style.alignItems = 'center';
    this.emptyOverlayEl.style.justifyContent = 'center';
    this.emptyOverlayEl.style.pointerEvents = 'none';
    this.emptyOverlayEl.textContent = 'Upload an image or choose a PDF page to start drawing occlusion boxes';

    this.stageWrap.append(this.canvas, this.emptyOverlayEl);
    this.rootEl.append(this.toolbarEl, this.stageWrap);
    this.containerEl.appendChild(this.rootEl);

    this.ctx = this.canvas.getContext('2d');
  }

  /**
   * Attaches pointer, wheel, keyboard, toolbar, and ResizeObserver listeners.
   */
  _bindEvents() {
    this._onModeClick = (e) => {
      const mode = e.currentTarget?.dataset?.mode;
      if (mode) {
        this.setMode(mode);
      }
    };
    for (const btn of Object.values(this.modeButtons)) {
      btn.addEventListener('click', this._onModeClick);
    }

    this._onZoomOut = () => this._zoomByFactor(1 / 1.25);
    this._onZoomIn = () => this._zoomByFactor(1.25);
    this._onZoomFit = () => this.fitToView();
    this._onUndoClick = () => this.undo();
    this._onDeleteClick = () => this.deleteSelected();

    this.zoomOutBtn.addEventListener('click', this._onZoomOut);
    this.zoomInBtn.addEventListener('click', this._onZoomIn);
    this.zoomFitBtn.addEventListener('click', this._onZoomFit);
    this.undoBtn.addEventListener('click', this._onUndoClick);
    this.deleteBtn.addEventListener('click', this._onDeleteClick);

    this._onLabelInput = () => {
      const box = this._getSelectedBox();
      if (!box) {
        return;
      }
      const nextLabel = this.labelInput.value;
      if (!this.labelEditSnapshotPushed) {
        this._pushUndoSnapshot();
        this.labelEditSnapshotPushed = true;
      }
      box.label = nextLabel;
      this._updateToolbarState();
      this._requestRender();
      this._emitChange();
    };
    this._onLabelBlur = () => {
      this.labelEditSnapshotPushed = false;
    };

    this.labelInput.addEventListener('input', this._onLabelInput);
    this.labelInput.addEventListener('blur', this._onLabelBlur);

    this._onPointerDown = (e) => this._handlePointerDown(e);
    this._onPointerMove = (e) => this._handlePointerMove(e);
    this._onPointerUp = (e) => this._handlePointerUp(e, false);
    this._onPointerCancel = (e) => this._handlePointerUp(e, true);
    this._onWheel = (e) => this._handleWheel(e);

    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('pointercancel', this._onPointerCancel);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });

    this._onKeyDown = (e) => this._handleKeyDown(e);
    this._onKeyUp = (e) => {
      if (e.code === 'Space' && this.spacePressed) {
        this.spacePressed = false;
        this._updateCursor();
      }
    };

    this.rootEl.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this._resizeCanvas();
      });
      this.resizeObserver.observe(this.stageWrap);
    } else {
      this._onWindowResize = () => this._resizeCanvas();
      window.addEventListener('resize', this._onWindowResize);
    }
  }

  _setEmptyOverlayVisible(visible) {
    this.emptyOverlayEl.hidden = !visible;
    this.emptyOverlayEl.style.display = visible ? 'flex' : 'none';
  }

  /**
   * Resizes the HiDPI backing canvas to match the CSS dimensions of stageWrap.
   */
  _resizeCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(0, rect.width);
    const height = Math.max(0, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);

    const targetW = Math.max(1, Math.round(width * dpr));
    const targetH = Math.max(1, Math.round(height * dpr));

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }

    if (this.image && width > 0 && height > 0 && this.pendingFit) {
      this.fitToView();
      return;
    }

    this._requestRender();
  }

  /**
   * Loads an image Data URL into the editor.
   *
   * @param {string|null} dataUrl
   * @param {{ keepBoxes?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async loadImage(dataUrl, { keepBoxes = false } = {}) {
    const token = ++this.imageLoadToken;

    if (!dataUrl) {
      const hadBoxes = !keepBoxes && this.boxes.length > 0;
      const hadSelection = !keepBoxes && this.selectedId !== null;

      this.imageDataUrl = null;
      this.image = null;
      this.pendingFit = false;
      this.interaction = null;
      this.draftBox = null;

      if (!keepBoxes) {
        this.boxes = [];
        this.selectedId = null;
        this.undoStack = [];
      }

      this._setEmptyOverlayVisible(true);
      this._updateToolbarState();
      this._requestRender();

      if (hadSelection) {
        this._emitSelectionChange();
      }
      if (hadBoxes) {
        this._emitChange();
      }
      return;
    }

    const img = await new Promise((resolve, reject) => {
      const loader = new Image();
      loader.onload = () => resolve(loader);
      loader.onerror = () => reject(new Error('Failed to load image into OcclusionCanvasEditor.'));
      loader.src = dataUrl;
    });

    // Guard against stale async image loads
    if (token !== this.imageLoadToken) {
      return;
    }

    const hadBoxes = !keepBoxes && this.boxes.length > 0;
    const hadSelection = !keepBoxes && this.selectedId !== null;

    this.imageDataUrl = dataUrl;
    this.image = img;
    this.interaction = null;
    this.draftBox = null;
    this.labelEditSnapshotPushed = false;

    if (!keepBoxes) {
      this.boxes = [];
      this.selectedId = null;
      this.undoStack = [];
    }

    this._setEmptyOverlayVisible(false);
    this.fitToView();
    this._updateToolbarState();

    if (hadSelection) {
      this._emitSelectionChange();
    }
    if (hadBoxes) {
      this._emitChange();
    }
  }

  /**
   * Replaces all occlusion boxes with a sanitized deep clone of `boxes`.
   *
   * @param {Array<{ id?: string, x: number, y: number, w: number, h: number, label?: string }>} boxes
   */
  setOcclusions(boxes) {
    const prevSelected = this.selectedId;
    const list = Array.isArray(boxes) ? boxes : [];

    this.boxes = list.map((b) => this._sanitizeBox(b));
    this.selectedId = null;
    this.labelEditSnapshotPushed = false;
    this.interaction = null;
    this.draftBox = null;

    this._updateToolbarState();
    this._requestRender();

    if (prevSelected !== null) {
      this._emitSelectionChange();
    }
  }

  /**
   * Returns a deep clone of the normalized occlusion boxes (`0..1`).
   * @returns {Array<{ id: string, x: number, y: number, w: number, h: number, label: string }>}
   */
  getOcclusions() {
    return this._cloneBoxes();
  }

  /**
   * Returns the currently loaded image Data URL, or null.
   * @returns {string|null}
   */
  getImageDataUrl() {
    return this.imageDataUrl;
  }

  /**
   * Switches the active interaction mode ('draw' | 'select' | 'pan').
   * @param {'draw'|'select'|'pan'} mode
   */
  setMode(mode) {
    if (mode !== 'draw' && mode !== 'select' && mode !== 'pan') {
      return;
    }
    this.mode = mode;
    this._updateToolbarState();
    this._updateCursor();
  }

  /**
   * Fits and centers the loaded image inside the canvas viewport.
   */
  fitToView() {
    if (!this.image) {
      this.scale = 1;
      this.fitScale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this._updateToolbarState();
      this._requestRender();
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      this.pendingFit = true;
      return;
    }

    this.pendingFit = false;
    const pad = 20;
    const availW = Math.max(24, rect.width - pad * 2);
    const availH = Math.max(24, rect.height - pad * 2);

    const imgW = this.image.naturalWidth || this.image.width || 1;
    const imgH = this.image.naturalHeight || this.image.height || 1;

    this.fitScale = Math.min(availW / imgW, availH / imgH);
    this.scale = this.fitScale;
    this.offsetX = (rect.width - imgW * this.scale) / 2;
    this.offsetY = (rect.height - imgH * this.scale) / 2;

    this._updateToolbarState();
    this._requestRender();
  }

  /**
   * Clears the loaded image, all boxes, selection, and undo history.
   */
  clear() {
    const hadBoxes = this.boxes.length > 0;
    const hadSelection = this.selectedId !== null;

    this.imageLoadToken += 1;
    this.imageDataUrl = null;
    this.image = null;
    this.boxes = [];
    this.selectedId = null;
    this.undoStack = [];
    this.pendingFit = false;
    this.interaction = null;
    this.draftBox = null;
    this.labelEditSnapshotPushed = false;

    this.scale = 1;
    this.fitScale = 1;
    this.offsetX = 0;
    this.offsetY = 0;

    this._setEmptyOverlayVisible(true);
    this._updateToolbarState();
    this._requestRender();

    if (hadSelection) {
      this._emitSelectionChange();
    }
    if (hadBoxes) {
      this._emitChange();
    }
  }

  /**
   * Reverts the most recent draw, move, resize, delete, or label edit.
   */
  undo() {
    if (this.undoStack.length === 0) {
      return;
    }

    const snapshot = this.undoStack.pop();
    const prevSelected = this.selectedId;

    this.boxes = snapshot.boxes.map((b) => ({ ...b }));
    this.selectedId = this.boxes.some((b) => b.id === snapshot.selectedId)
      ? snapshot.selectedId
      : null;
    this.labelEditSnapshotPushed = false;

    this._updateToolbarState();
    this._requestRender();

    if (prevSelected !== this.selectedId || this.selectedId !== null) {
      this._emitSelectionChange();
    }
    this._emitChange();
  }

  /**
   * Deletes the currently selected occlusion box, pushing an undo snapshot first.
   */
  deleteSelected() {
    if (!this.selectedId) {
      return;
    }

    this._pushUndoSnapshot();
    this.boxes = this.boxes.filter((b) => b.id !== this.selectedId);
    this.selectedId = null;
    this.labelEditSnapshotPushed = false;

    this._updateToolbarState();
    this._requestRender();
    this._emitSelectionChange();
    this._emitChange();
  }

  /**
   * Disconnects observers, detaches all event listeners, and clears container DOM.
   */
  destroy() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this._onWindowResize) {
      window.removeEventListener('resize', this._onWindowResize);
      this._onWindowResize = null;
    }

    for (const btn of Object.values(this.modeButtons)) {
      btn.removeEventListener('click', this._onModeClick);
    }

    this.zoomOutBtn.removeEventListener('click', this._onZoomOut);
    this.zoomInBtn.removeEventListener('click', this._onZoomIn);
    this.zoomFitBtn.removeEventListener('click', this._onZoomFit);
    this.undoBtn.removeEventListener('click', this._onUndoClick);
    this.deleteBtn.removeEventListener('click', this._onDeleteClick);

    this.labelInput.removeEventListener('input', this._onLabelInput);
    this.labelInput.removeEventListener('blur', this._onLabelBlur);

    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerCancel);
    this.canvas.removeEventListener('wheel', this._onWheel);

    this.rootEl.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);

    this.containerEl.innerHTML = '';
  }

  /* ------------------------------------------------------------------------ */
  /* Internal helpers                                                         */
  /* ------------------------------------------------------------------------ */

  _sanitizeBox(raw) {
    const x = clamp(Number(raw?.x) || 0, 0, 1 - MIN_BOX_SIZE);
    const y = clamp(Number(raw?.y) || 0, 0, 1 - MIN_BOX_SIZE);
    const w = clamp(Number(raw?.w) || MIN_BOX_SIZE, MIN_BOX_SIZE, 1 - x);
    const h = clamp(Number(raw?.h) || MIN_BOX_SIZE, MIN_BOX_SIZE, 1 - y);
    return {
      id: typeof raw?.id === 'string' && raw.id ? raw.id : createBoxId(),
      x,
      y,
      w,
      h,
      label: typeof raw?.label === 'string' ? raw.label : '',
    };
  }

  _cloneBoxes(source = this.boxes) {
    return source.map((b) => ({
      id: b.id,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      label: b.label,
    }));
  }

  _getSelectedBox() {
    if (!this.selectedId) {
      return null;
    }
    return this.boxes.find((b) => b.id === this.selectedId) || null;
  }

  _selectBox(id) {
    const nextId = id || null;
    if (this.selectedId === nextId) {
      return;
    }
    this.selectedId = nextId;
    this.labelEditSnapshotPushed = false;
    this._updateToolbarState();
    this._requestRender();
    this._emitSelectionChange();
  }

  _pushUndoSnapshot(customBoxes = null, customSelectedId = this.selectedId) {
    this.undoStack.push({
      boxes: this._cloneBoxes(customBoxes || this.boxes),
      selectedId: customSelectedId,
    });
    if (this.undoStack.length > MAX_UNDO_STEPS) {
      this.undoStack.shift();
    }
    this.undoBtn.disabled = this.undoStack.length === 0;
  }

  _emitChange() {
    if (this.onChange) {
      this.onChange(this.getOcclusions());
    }
  }

  _emitSelectionChange() {
    if (this.onSelectionChange) {
      const box = this._getSelectedBox();
      this.onSelectionChange(box ? { ...box } : null);
    }
  }

  _updateToolbarState() {
    for (const [key, btn] of Object.entries(this.modeButtons)) {
      const isActive = key === this.mode;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    }

    const selected = this._getSelectedBox();
    this.deleteBtn.disabled = !selected;
    this.undoBtn.disabled = this.undoStack.length === 0;

    this.zoomOutBtn.disabled = !this.image;
    this.zoomFitBtn.disabled = !this.image;
    this.zoomInBtn.disabled = !this.image;

    if (selected) {
      this.labelInput.disabled = false;
      if (this.labelInput.value !== selected.label) {
        this.labelInput.value = selected.label;
      }
    } else {
      this.labelInput.disabled = true;
      this.labelInput.value = '';
    }

    const count = this.boxes.length;
    this.countBadgeEl.textContent = `${count} ${count === 1 ? 'box' : 'boxes'}`;

    const zoomPct = this.image ? Math.round(this.scale * 100) : 100;
    this.zoomLabelEl.textContent = `${zoomPct}%`;
  }

  _getStagePoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  _stageToImageNorm(sx, sy) {
    const imgW = this.image.naturalWidth || this.image.width || 1;
    const imgH = this.image.naturalHeight || this.image.height || 1;
    return {
      x: (sx - this.offsetX) / (imgW * this.scale),
      y: (sy - this.offsetY) / (imgH * this.scale),
    };
  }

  _getBoxStageRect(box) {
    const imgW = this.image.naturalWidth || this.image.width || 1;
    const imgH = this.image.naturalHeight || this.image.height || 1;
    return {
      x: this.offsetX + box.x * imgW * this.scale,
      y: this.offsetY + box.y * imgH * this.scale,
      w: box.w * imgW * this.scale,
      h: box.h * imgH * this.scale,
    };
  }

  _getHandlePositions(rect) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const right = rect.x + rect.w;
    const bottom = rect.y + rect.h;
    return {
      nw: { x: rect.x, y: rect.y },
      n: { x: cx, y: rect.y },
      ne: { x: right, y: rect.y },
      w: { x: rect.x, y: cy },
      e: { x: right, y: cy },
      sw: { x: rect.x, y: bottom },
      s: { x: cx, y: bottom },
      se: { x: right, y: bottom },
    };
  }

  _hitTestHandle(box, sx, sy, radius = 12) {
    const rect = this._getBoxStageRect(box);
    const handles = this._getHandlePositions(rect);
    let bestHandle = null;
    let bestDist = radius;

    for (const key of HANDLE_ORDER) {
      const pt = handles[key];
      const dist = Math.hypot(sx - pt.x, sy - pt.y);
      if (dist <= bestDist) {
        bestDist = dist;
        bestHandle = key;
      }
    }
    return bestHandle;
  }

  _hitTestBox(sx, sy, padding = 2) {
    for (let i = this.boxes.length - 1; i >= 0; i -= 1) {
      const box = this.boxes[i];
      const rect = this._getBoxStageRect(box);
      if (
        sx >= rect.x - padding &&
        sx <= rect.x + rect.w + padding &&
        sy >= rect.y - padding &&
        sy <= rect.y + rect.h + padding
      ) {
        return box;
      }
    }
    return null;
  }

  _zoomAt(sx, sy, nextScale) {
    if (!this.image) {
      return;
    }
    const minScale = Math.min(0.1, (this.fitScale || 1) * 0.25);
    const maxScale = Math.max(8, (this.fitScale || 1) * 10);
    const clamped = clamp(nextScale, minScale, maxScale);
    const ratio = clamped / this.scale;

    this.offsetX = sx - (sx - this.offsetX) * ratio;
    this.offsetY = sy - (sy - this.offsetY) * ratio;
    this.scale = clamped;

    this._updateToolbarState();
    this._requestRender();
  }

  _zoomByFactor(factor) {
    if (!this.image) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    this._zoomAt(rect.width / 2, rect.height / 2, this.scale * factor);
  }

  _cancelActiveInteraction() {
    if (!this.interaction) {
      this.draftBox = null;
      return;
    }

    if ((this.interaction.type === 'move' || this.interaction.type === 'resize') && this.interaction.origBox) {
      const box = this.boxes.find((b) => b.id === this.interaction.boxId);
      if (box) {
        Object.assign(box, this.interaction.origBox);
      }
    }

    this.interaction = null;
    this.draftBox = null;
  }

  _handlePointerDown(e) {
    if (!this.image) {
      return;
    }

    if (document.activeElement !== this.canvas) {
      this.canvas.focus({ preventScroll: true });
    }

    const pt = this._getStagePoint(e);
    this.pointers.set(e.pointerId, { x: pt.x, y: pt.y, pointerType: e.pointerType });

    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic events that cannot capture
    }

    // Two-finger pinch/pan transitions immediately regardless of active mode
    if (this.pointers.size >= 2) {
      this._cancelActiveInteraction();
      if (this.pointers.size === 2) {
        const [p1, p2] = Array.from(this.pointers.values());
        this.pinchState = {
          prevDist: Math.hypot(p2.x - p1.x, p2.y - p1.y),
          prevMidX: (p1.x + p2.x) / 2,
          prevMidY: (p1.y + p2.y) / 2,
        };
      }
      this._requestRender();
      return;
    }

    if (this.pinchCooldown) {
      return;
    }

    const isPanGesture = e.button === 1 || this.spacePressed || this.mode === 'pan';
    if (isPanGesture) {
      if (e.button === 1) {
        e.preventDefault();
      }
      this.interaction = {
        type: 'pan',
        pointerId: e.pointerId,
        startX: pt.x,
        startY: pt.y,
        startOffsetX: this.offsetX,
        startOffsetY: this.offsetY,
      };
      this._updateCursor();
      return;
    }

    if (e.pointerType === 'mouse' && e.button !== 0) {
      return;
    }

    if (this.mode === 'draw') {
      const norm = this._stageToImageNorm(pt.x, pt.y);
      const startX = clamp(norm.x, 0, 1);
      const startY = clamp(norm.y, 0, 1);

      this.interaction = {
        type: 'draw',
        pointerId: e.pointerId,
        startX,
        startY,
      };
      this.draftBox = { x: startX, y: startY, w: 0, h: 0 };
      this._requestRender();
      return;
    }

    if (this.mode === 'select') {
      const isTouch = e.pointerType === 'touch';
      const handleRadius = isTouch ? 20 : 12;
      const boxPadding = isTouch ? 6 : 2;

      const selected = this._getSelectedBox();
      if (selected) {
        const handle = this._hitTestHandle(selected, pt.x, pt.y, handleRadius);
        if (handle) {
          this.interaction = {
            type: 'resize',
            pointerId: e.pointerId,
            boxId: selected.id,
            handle,
            startSx: pt.x,
            startSy: pt.y,
            origBox: { ...selected },
            snapshot: this._cloneBoxes(),
            moved: false,
          };
          this._updateCursor(pt.x, pt.y);
          return;
        }
      }

      const hitBox = this._hitTestBox(pt.x, pt.y, boxPadding);
      if (hitBox) {
        this._selectBox(hitBox.id);
        this.interaction = {
          type: 'move',
          pointerId: e.pointerId,
          boxId: hitBox.id,
          startSx: pt.x,
          startSy: pt.y,
          origBox: { ...hitBox },
          snapshot: this._cloneBoxes(),
          moved: false,
        };
        this._updateCursor(pt.x, pt.y);
      } else {
        this._selectBox(null);
      }
    }
  }

  _handlePointerMove(e) {
    if (!this.image) {
      return;
    }

    const pt = this._getStagePoint(e);
    if (this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, { x: pt.x, y: pt.y, pointerType: e.pointerType });
    }

    // Two-finger pinch zoom & pan
    if (this.pointers.size >= 2 && this.pinchState) {
      const [p1, p2] = Array.from(this.pointers.values());
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;

      this.offsetX += midX - this.pinchState.prevMidX;
      this.offsetY += midY - this.pinchState.prevMidY;

      if (this.pinchState.prevDist > 6 && dist > 6) {
        const factor = dist / this.pinchState.prevDist;
        this._zoomAt(midX, midY, this.scale * factor);
      } else {
        this._requestRender();
      }

      this.pinchState.prevDist = dist;
      this.pinchState.prevMidX = midX;
      this.pinchState.prevMidY = midY;
      return;
    }

    if (!this.interaction || this.interaction.pointerId !== e.pointerId) {
      this._updateCursor(pt.x, pt.y);
      return;
    }

    if (this.interaction.type === 'pan') {
      this.offsetX = this.interaction.startOffsetX + (pt.x - this.interaction.startX);
      this.offsetY = this.interaction.startOffsetY + (pt.y - this.interaction.startY);
      this._requestRender();
      return;
    }

    if (this.interaction.type === 'draw') {
      const norm = this._stageToImageNorm(pt.x, pt.y);
      const currX = clamp(norm.x, 0, 1);
      const currY = clamp(norm.y, 0, 1);

      this.draftBox = {
        x: Math.min(this.interaction.startX, currX),
        y: Math.min(this.interaction.startY, currY),
        w: Math.abs(currX - this.interaction.startX),
        h: Math.abs(currY - this.interaction.startY),
      };
      this._requestRender();
      return;
    }

    const imgW = this.image.naturalWidth || this.image.width || 1;
    const imgH = this.image.naturalHeight || this.image.height || 1;

    if (this.interaction.type === 'move') {
      const dxPx = pt.x - this.interaction.startSx;
      const dyPx = pt.y - this.interaction.startSy;
      if (!this.interaction.moved && Math.hypot(dxPx, dyPx) > 2) {
        this.interaction.moved = true;
      }
      if (!this.interaction.moved) {
        return;
      }

      const box = this.boxes.find((b) => b.id === this.interaction.boxId);
      if (!box) {
        return;
      }

      const dxNorm = dxPx / (imgW * this.scale);
      const dyNorm = dyPx / (imgH * this.scale);
      box.x = clamp(this.interaction.origBox.x + dxNorm, 0, 1 - box.w);
      box.y = clamp(this.interaction.origBox.y + dyNorm, 0, 1 - box.h);

      this._requestRender();
      return;
    }

    if (this.interaction.type === 'resize') {
      const dxPx = pt.x - this.interaction.startSx;
      const dyPx = pt.y - this.interaction.startSy;
      if (!this.interaction.moved && Math.hypot(dxPx, dyPx) > 2) {
        this.interaction.moved = true;
      }
      if (!this.interaction.moved) {
        return;
      }

      const box = this.boxes.find((b) => b.id === this.interaction.boxId);
      if (!box) {
        return;
      }

      const dxNorm = dxPx / (imgW * this.scale);
      const dyNorm = dyPx / (imgH * this.scale);
      const orig = this.interaction.origBox;
      const origRight = orig.x + orig.w;
      const origBottom = orig.y + orig.h;

      let left = orig.x;
      let top = orig.y;
      let right = origRight;
      let bottom = origBottom;

      const h = this.interaction.handle;
      if (h.includes('w')) {
        left = clamp(orig.x + dxNorm, 0, origRight - MIN_BOX_SIZE);
      }
      if (h.includes('e')) {
        right = clamp(origRight + dxNorm, orig.x + MIN_BOX_SIZE, 1);
      }
      if (h.includes('n')) {
        top = clamp(orig.y + dyNorm, 0, origBottom - MIN_BOX_SIZE);
      }
      if (h.includes('s')) {
        bottom = clamp(origBottom + dyNorm, orig.y + MIN_BOX_SIZE, 1);
      }

      box.x = left;
      box.y = top;
      box.w = right - left;
      box.h = bottom - top;

      this._requestRender();
    }
  }

  _handlePointerUp(e, cancelled) {
    this.pointers.delete(e.pointerId);

    try {
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore if capture was already released
    }

    if (this.pinchState) {
      if (this.pointers.size < 2) {
        this.pinchState = null;
        this.pinchCooldown = this.pointers.size > 0;
      }
      this._updateCursor();
      return;
    }

    if (this.pointers.size === 0) {
      this.pinchCooldown = false;
    }

    if (!this.interaction || this.interaction.pointerId !== e.pointerId) {
      return;
    }

    const current = this.interaction;
    this.interaction = null;

    if (cancelled) {
      if ((current.type === 'move' || current.type === 'resize') && current.origBox) {
        const box = this.boxes.find((b) => b.id === current.boxId);
        if (box) {
          Object.assign(box, current.origBox);
        }
      }
      this.draftBox = null;
      this._updateCursor();
      this._requestRender();
      return;
    }

    if (current.type === 'draw') {
      const draft = this.draftBox;
      this.draftBox = null;

      if (draft && draft.w >= MIN_BOX_SIZE && draft.h >= MIN_BOX_SIZE) {
        this._pushUndoSnapshot();
        const newBox = {
          id: createBoxId(),
          x: draft.x,
          y: draft.y,
          w: draft.w,
          h: draft.h,
          label: '',
        };
        this.boxes.push(newBox);
        this.selectedId = newBox.id;
        this.labelEditSnapshotPushed = false;
        this._updateToolbarState();
        this._emitSelectionChange();
        this._emitChange();
      }
      this._requestRender();
      this._updateCursor();
      return;
    }

    if ((current.type === 'move' || current.type === 'resize') && current.moved) {
      this._pushUndoSnapshot(current.snapshot, current.boxId);
      this._emitChange();
    }

    this._updateCursor();
    this._requestRender();
  }

  _handleWheel(e) {
    if (!this.image) {
      return;
    }
    e.preventDefault();

    const pt = this._getStagePoint(e);
    const intensity = e.ctrlKey ? 0.01 : 0.0022;
    const delta = clamp(e.deltaY, -120, 120);
    const factor = Math.exp(-delta * intensity);

    this._zoomAt(pt.x, pt.y, this.scale * factor);
  }

  _handleKeyDown(e) {
    const active = document.activeElement;
    const isTypingInInput = active === this.labelInput
      || active?.tagName === 'INPUT'
      || active?.tagName === 'TEXTAREA';

    if (isTypingInInput) {
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
      return;
    }

    if (active === this.canvas && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      this.deleteSelected();
      return;
    }

    if (active === this.canvas && e.code === 'Space') {
      e.preventDefault();
      if (!this.spacePressed) {
        this.spacePressed = true;
        this._updateCursor();
      }
    }
  }

  _updateCursor(sx = null, sy = null) {
    if (!this.image) {
      this.canvas.style.cursor = 'default';
      return;
    }

    if (this.interaction?.type === 'pan') {
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    if (this.spacePressed || this.mode === 'pan') {
      this.canvas.style.cursor = 'grab';
      return;
    }

    if (this.mode === 'draw') {
      this.canvas.style.cursor = 'crosshair';
      return;
    }

    if (this.interaction?.type === 'resize') {
      this.canvas.style.cursor = HANDLE_CURSORS[this.interaction.handle] || 'default';
      return;
    }

    if (this.interaction?.type === 'move') {
      this.canvas.style.cursor = 'move';
      return;
    }

    if (this.mode === 'select' && sx !== null && sy !== null) {
      const selected = this._getSelectedBox();
      if (selected) {
        const handle = this._hitTestHandle(selected, sx, sy, 12);
        if (handle) {
          this.canvas.style.cursor = HANDLE_CURSORS[handle];
          return;
        }
      }
      if (this._hitTestBox(sx, sy, 2)) {
        this.canvas.style.cursor = 'move';
        return;
      }
    }

    this.canvas.style.cursor = 'default';
  }

  _requestRender() {
    if (this.rafId !== null) {
      return;
    }
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this._render();
    });
  }

  _render() {
    if (!this.ctx) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const viewW = rect.width;
    const viewH = rect.height;
    if (viewW <= 0 || viewH <= 0) {
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const ctx = this.ctx;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);

    if (!this.image) {
      return;
    }

    const imgW = (this.image.naturalWidth || this.image.width) * this.scale;
    const imgH = (this.image.naturalHeight || this.image.height) * this.scale;

    // Subtle paper card backdrop behind image
    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.16)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(this.offsetX, this.offsetY, imgW, imgH);
    ctx.restore();

    ctx.drawImage(this.image, this.offsetX, this.offsetY, imgW, imgH);

    // Draw saved occlusion boxes
    for (let i = 0; i < this.boxes.length; i += 1) {
      const box = this.boxes[i];
      const isSelected = box.id === this.selectedId;
      this._drawBox(ctx, box, i + 1, isSelected);
    }

    // Draw active drag-to-create preview box
    if (this.draftBox && this.draftBox.w > 0 && this.draftBox.h > 0) {
      const r = this._getBoxStageRect(this.draftBox);
      ctx.save();
      ctx.fillStyle = 'rgba(37, 99, 235, 0.22)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#2563eb';
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.restore();
    }
  }

  _drawBox(ctx, box, index, isSelected) {
    const r = this._getBoxStageRect(box);

    ctx.save();

    // Box fill
    ctx.fillStyle = isSelected ? 'rgba(37, 99, 235, 0.28)' : 'rgba(245, 158, 11, 0.34)';
    ctx.fillRect(r.x, r.y, r.w, r.h);

    // White outer halo for contrast on dark diagrams
    ctx.lineWidth = isSelected ? 4 : 3;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // Primary crisp border
    ctx.lineWidth = isSelected ? 2.5 : 2;
    ctx.strokeStyle = isSelected ? '#2563eb' : '#d97706';
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // Index & label pill badge
    const badgeText = box.label ? `#${index}: ${box.label}` : `#${index}`;
    ctx.font = '600 11px system-ui, -apple-system, sans-serif';
    const maxBadgeWidth = Math.max(36, r.w - 6);
    let displayText = badgeText;
    if (ctx.measureText(displayText).width > maxBadgeWidth - 10 && r.w >= 54) {
      while (displayText.length > 3 && ctx.measureText(`${displayText}...`).width > maxBadgeWidth - 10) {
        displayText = displayText.slice(0, -1);
      }
      displayText = `${displayText}...`;
    } else if (r.w < 54 && box.label) {
      displayText = `#${index}`;
    }

    const textW = ctx.measureText(displayText).width;
    const pillW = textW + 10;
    const pillH = 18;
    const pillX = r.x + 3;
    // Place pill above the box if the box itself is very short
    const pillY = r.h >= 24 ? r.y + 3 : Math.max(2, r.y - pillH - 3);

    ctx.fillStyle = isSelected ? 'rgba(37, 99, 235, 0.95)' : 'rgba(15, 23, 42, 0.84)';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(pillX, pillY, pillW, pillH, 4);
    } else {
      ctx.rect(pillX, pillY, pillW, pillH);
    }
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayText, pillX + 5, pillY + pillH / 2 + 0.5);

    // 8 Resize handles when selected
    if (isSelected) {
      const handles = this._getHandlePositions(r);
      const handleRadius = 5;
      for (const key of HANDLE_ORDER) {
        const pt = handles[key];
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, handleRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#2563eb';
        ctx.stroke();
      }
    }

    ctx.restore();
  }
}
