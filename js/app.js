import {
  openDB,
  generateId,
  createDeckObject,
  createCardObject,
  createReviewLogObject,
  getAllDecks,
  saveDeck,
  deleteDeck,
  getAllCards,
  saveCard,
  saveCardsBatch,
  deleteCard,
  getAllReviewLogs,
  addReviewLog,
  exportAllData,
  importAllData,
  clearAllData,
  loadSampleData,
} from './db.js';
import { isCardDue, previewAllRatings, scheduleCard } from './fsrs.js';
import {
  compressImageToJpeg,
  loadPdfDocument,
  renderPageThumbnail,
  extractPagesText,
  renderPageHighRes,
} from './pdf-handler.js';
import {
  DEFAULT_MODEL,
  PRESET_MODELS,
  getSettings,
  saveSettings,
  getEffectiveModel,
  generateTextAndClozeCards,
  generateImageOcclusionBoxes,
} from './gemini-api.js';
import { OcclusionCanvasEditor } from './canvas-editor.js';
import { renderHistoryDashboard, computeAnalytics, formatDuration } from './history.js';

/**
 * Application state held in memory and synchronized with IndexedDB / localStorage.
 */
const state = {
  currentView: 'dashboard',
  decks: [],
  cards: [],
  reviewLogs: [],
  selectedDeckId: null,
  cardFilterSource: 'all', // 'all' | 'manual' | 'ai'
  cardSearchQuery: '',

  createMode: 'manual', // 'manual' | 'ai'
  manualType: 'basic', // 'basic' | 'cloze' | 'occlusion'
  aiSource: 'pdf', // 'pdf' | 'text'
  aiType: 'text-cloze', // 'text-cloze' | 'occlusion'

  // PDF state for AI Mode
  aiPdfDoc: null,
  aiPdfFileName: '',
  aiPdfNumPages: 0,
  aiPdfSelectedPages: new Set(),
  aiVisionImageDataUrl: null,
  aiVisionImageName: '',
  aiPreviewItems: [], // [{ tempId, selected, type, front, back, imageDataUrl, occlusions }]

  // PDF state for Manual Occlusion Page Picker
  manualPdfDoc: null,

  // Active Study Session
  studySession: null,

  // Modal editing context
  editingDeckId: null,
  editingCardId: null,
  editingAiPreviewTempId: null,
  confirmResolve: null,
};

let manualCanvasEditor = null;
let editCardCanvasEditor = null;
let aiModalCanvasEditor = null;

/**
 * Shorthand DOM query by ID.
 * @param {string} id
 * @returns {HTMLElement|null}
 */
function $(id) {
  return document.getElementById(id);
}

/**
 * Escapes HTML special characters to prevent injection in dynamic templates.
 * @param {unknown} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Formats a timestamp into a readable local date string.
 * @param {number} ts
 * @returns {string}
 */
function formatDate(ts) {
  if (!ts) return '-';
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

/**
 * Displays a non-blocking toast notification.
 * @param {string} message
 * @param {'info'|'success'|'warning'|'error'} [type='info']
 */
function showToast(message, type = 'info') {
  const container = $('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  window.setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(6px)';
    toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    window.setTimeout(() => toast.remove(), 220);
  }, 3400);
}

/**
 * Opens the reusable confirmation modal and returns a Promise<boolean>.
 * @param {string} title
 * @param {string} message
 * @param {string} [okLabel='Confirm']
 * @returns {Promise<boolean>}
 */
function confirmAction(title, message, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
    $('confirm-modal-title').textContent = title;
    $('confirm-modal-message').textContent = message;
    $('btn-confirm-ok').textContent = okLabel;
    $('modal-confirm').hidden = false;
  });
}

function closeConfirmModal(result) {
  const modal = $('modal-confirm');
  if (modal) modal.hidden = true;
  if (typeof state.confirmResolve === 'function') {
    const fn = state.confirmResolve;
    state.confirmResolve = null;
    fn(Boolean(result));
  }
}

/* ==========================================================================
   Cloze Helpers
   ========================================================================== */

const CLOZE_REGEX = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

/**
 * Renders cloze syntax `{{c1::term}}` safely as HTML blanks or revealed highlights.
 * @param {string} text
 * @param {boolean} reveal
 * @returns {string}
 */
function renderClozeHtml(text, reveal = false) {
  const raw = String(text ?? '');
  let result = '';
  let lastIndex = 0;

  CLOZE_REGEX.lastIndex = 0;
  let match;
  while ((match = CLOZE_REGEX.exec(raw)) !== null) {
    result += escapeHtml(raw.slice(lastIndex, match.index));
    const answer = match[2] ?? '';
    const hint = match[3] ?? '';
    if (reveal) {
      result += `<span class="cloze-revealed">${escapeHtml(answer)}</span>`;
    } else {
      const placeholder = hint ? `[${hint}]` : '[ ... ]';
      result += `<span class="cloze-blank">${escapeHtml(placeholder)}</span>`;
    }
    lastIndex = match.index + match[0].length;
  }

  result += escapeHtml(raw.slice(lastIndex));
  return result.replaceAll('\n', '<br>');
}

/**
 * Renders plain text safely with line breaks.
 * @param {string} text
 * @returns {string}
 */
function renderPlainMultiline(text) {
  return escapeHtml(text).replaceAll('\n', '<br>');
}

/**
 * Wraps the current text selection inside a textarea with `{{cN::selected}}`.
 * @param {HTMLTextAreaElement} textarea
 * @returns {boolean}
 */
function wrapSelectionAsCloze(textarea) {
  if (!textarea) return false;
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? 0;
  const value = textarea.value;

  if (start === end) {
    showToast('Highlight the word or phrase you want to turn into a blank first.', 'warning');
    textarea.focus();
    return false;
  }

  const selected = value.slice(start, end);
  if (!selected.trim()) {
    showToast('Selected text cannot be empty.', 'warning');
    return false;
  }

  // Find highest existing cloze number so multiple clozes increment c1, c2, ...
  let maxIndex = 0;
  const matches = value.matchAll(/\{\{c(\d+)::/g);
  for (const m of matches) {
    const num = Number(m[1]);
    if (Number.isFinite(num) && num > maxIndex) {
      maxIndex = num;
    }
  }
  const nextIdx = maxIndex + 1;
  const wrapped = `{{c${nextIdx}::${selected}}}`;

  textarea.value = value.slice(0, start) + wrapped + value.slice(end);
  textarea.focus();
  const cursorPos = start + wrapped.length;
  textarea.setSelectionRange(cursorPos, cursorPos);
  return true;
}

/* ==========================================================================
   Theme & Settings Sync
   ========================================================================== */

const SUN_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
const MOON_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;

function applyTheme(theme) {
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', normalized);

  const toggleBtn = $('theme-toggle-btn');
  if (toggleBtn) {
    toggleBtn.innerHTML = normalized === 'dark' ? SUN_ICON : MOON_ICON;
    toggleBtn.title = normalized === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
  }

  const lightBtn = $('btn-theme-light');
  const darkBtn = $('btn-theme-dark');
  if (lightBtn && darkBtn) {
    lightBtn.classList.toggle('active', normalized === 'light');
    darkBtn.classList.toggle('active', normalized === 'dark');
  }
}

function hydrateSettingsUI() {
  const settings = getSettings();
  applyTheme(settings.theme);

  const apiKeyInput = $('setting-api-key');
  const modelSelect = $('setting-model-select');
  const customRow = $('setting-custom-model-row');
  const customInput = $('setting-custom-model');

  if (apiKeyInput) apiKeyInput.value = settings.apiKey || '';

  if (modelSelect) {
    const model = settings.model || DEFAULT_MODEL;
    if (PRESET_MODELS.includes(model)) {
      modelSelect.value = model;
      if (customRow) customRow.hidden = true;
    } else if (model === '__custom__' || !PRESET_MODELS.includes(model)) {
      modelSelect.value = '__custom__';
      if (customRow) customRow.hidden = false;
      if (customInput) {
        customInput.value = model === '__custom__' ? settings.customModel || '' : model;
      }
    }
  }
}

/* ==========================================================================
   Data Reload & View Switching
   ========================================================================== */

async function reloadAllData() {
  const [decks, cards, reviewLogs] = await Promise.all([
    getAllDecks(),
    getAllCards(),
    getAllReviewLogs(),
  ]);
  state.decks = decks;
  state.cards = cards;
  state.reviewLogs = reviewLogs;

  if (state.selectedDeckId && !state.decks.some((d) => d.id === state.selectedDeckId)) {
    state.selectedDeckId = null;
  }

  renderDashboard();
  syncCreateDeckDropdown();
  if (state.currentView === 'history') {
    renderHistoryView();
  }
}

function switchView(viewName) {
  state.currentView = viewName;

  const views = ['dashboard', 'create', 'history', 'settings', 'study'];
  for (const name of views) {
    const el = $(`view-${name}`);
    if (!el) continue;
    const active = name === viewName;
    el.hidden = !active;
    el.classList.toggle('active', active);
  }

  document.querySelectorAll('.nav-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === viewName);
  });

  if (viewName === 'dashboard') {
    renderDashboard();
  } else if (viewName === 'create') {
    syncCreateDeckDropdown();
    if (state.createMode === 'manual' && state.manualType === 'occlusion' && manualCanvasEditor) {
      requestAnimationFrame(() => manualCanvasEditor.fitToView());
    }
  } else if (viewName === 'history') {
    renderHistoryView();
  } else if (viewName === 'settings') {
    hydrateSettingsUI();
  }
}

/* ==========================================================================
   Dashboard & Deck Library Rendering
   ========================================================================== */

function getDeckCards(deckId) {
  return state.cards.filter((c) => c.deckId === deckId);
}

function renderDashboard() {
  const now = Date.now();
  const totalDecks = state.decks.length;
  const totalCards = state.cards.length;
  const dueCards = state.cards.filter((c) => isCardDue(c, now)).length;
  const analytics = computeAnalytics(state.reviewLogs, state.decks, now);

  $('stat-total-decks').textContent = String(totalDecks);
  $('stat-total-cards').textContent = String(totalCards);
  $('stat-due-cards').textContent = String(dueCards);
  $('stat-reviewed-today').textContent = String(analytics.reviewedToday);

  const listPanel = $('deck-list-panel');
  const detailPanel = $('deck-detail-panel');

  if (state.selectedDeckId) {
    listPanel.hidden = true;
    detailPanel.hidden = false;
    renderDeckDetail();
  } else {
    listPanel.hidden = false;
    detailPanel.hidden = true;
    renderDeckGrid(now);
  }
}

function renderDeckGrid(now = Date.now()) {
  const grid = $('decks-grid');
  const empty = $('decks-empty');
  if (!grid || !empty) return;

  if (state.decks.length === 0) {
    grid.innerHTML = '';
    empty.hidden = false;
    return;
  }

  empty.hidden = true;
  grid.innerHTML = state.decks
    .map((deck) => {
      const deckCards = getDeckCards(deck.id);
      const dueCount = deckCards.filter((c) => isCardDue(c, now)).length;
      const manualCount = deckCards.filter((c) => c.source === 'manual').length;
      const aiCount = deckCards.filter((c) => c.source === 'ai').length;

      return `
        <article class="deck-card" data-deck-id="${escapeHtml(deck.id)}" tabindex="0" role="button" aria-label="Open deck ${escapeHtml(deck.name)}">
          <div class="deck-card-header">
            <h3 class="deck-card-title">${escapeHtml(deck.name)}</h3>
            <p class="deck-card-desc">${escapeHtml(deck.description || 'No description')}</p>
          </div>

          <div class="deck-card-stats">
            <span class="badge">${deckCards.length} card${deckCards.length === 1 ? '' : 's'}</span>
            <span class="badge badge-due">${dueCount} due</span>
            ${manualCount > 0 ? `<span class="badge badge-manual">${manualCount} Manual</span>` : ''}
            ${aiCount > 0 ? `<span class="badge badge-ai">${aiCount} AI</span>` : ''}
          </div>

          <div class="deck-card-actions">
            <button type="button" class="btn btn-primary btn-sm" data-action="study-due" data-deck-id="${escapeHtml(deck.id)}" ${deckCards.length === 0 ? 'disabled' : ''}>
              ${dueCount > 0 ? `Study (${dueCount})` : 'Study'}
            </button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="open-deck" data-deck-id="${escapeHtml(deck.id)}">
              View Cards
            </button>
            <span class="hint-text" style="margin-left:auto;font-size:0.78rem;">${escapeHtml(formatDate(deck.createdAt))}</span>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderDeckDetail() {
  const deck = state.decks.find((d) => d.id === state.selectedDeckId);
  if (!deck) {
    state.selectedDeckId = null;
    renderDashboard();
    return;
  }

  const now = Date.now();
  const deckCards = getDeckCards(deck.id).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const dueCount = deckCards.filter((c) => isCardDue(c, now)).length;

  $('detail-deck-name').textContent = deck.name;
  $('detail-deck-desc').textContent = deck.description || 'No description provided.';
  $('detail-deck-meta').innerHTML = `
    <span class="badge">${deckCards.length} total card${deckCards.length === 1 ? '' : 's'}</span>
    <span class="badge badge-due">${dueCount} due now</span>
    <span class="badge">Created ${escapeHtml(formatDate(deck.createdAt))}</span>
  `;

  $('btn-study-deck').disabled = dueCount === 0;
  $('btn-study-deck').textContent = dueCount > 0 ? `Study Due (${dueCount})` : 'No Cards Due';
  $('btn-study-all-deck').disabled = deckCards.length === 0;

  const query = state.cardSearchQuery.trim().toLowerCase();
  const filtered = deckCards.filter((card) => {
    if (state.cardFilterSource !== 'all' && card.source !== state.cardFilterSource) {
      return false;
    }
    if (!query) return true;
    const occLabels = (card.occlusions || []).map((o) => o.label || '').join(' ');
    const hay = `${card.front || ''} ${card.back || ''} ${occLabels}`.toLowerCase();
    return hay.includes(query);
  });

  const listEl = $('deck-cards-list');
  const emptyEl = $('deck-cards-empty');

  if (filtered.length === 0) {
    listEl.innerHTML = '';
    emptyEl.hidden = false;
    return;
  }

  emptyEl.hidden = true;
  listEl.innerHTML = filtered
    .map((card) => {
      const due = isCardDue(card, now);
      const typeLabel =
        card.type === 'cloze' ? 'Cloze' : card.type === 'occlusion' ? 'Image Occlusion' : 'Basic';
      const typeClass =
        card.type === 'cloze' ? 'badge-cloze' : card.type === 'occlusion' ? 'badge-occlusion' : 'badge-basic';
      const sourceLabel = card.source === 'ai' ? 'AI' : 'Manual';
      const sourceClass = card.source === 'ai' ? 'badge-ai' : 'badge-manual';

      const frontMarkup =
        card.type === 'cloze'
          ? renderClozeHtml(card.front, false)
          : renderPlainMultiline(card.front || '(No front prompt)');

      const backText =
        card.type === 'occlusion'
          ? `${(card.occlusions || []).length} occlusion box${(card.occlusions || []).length === 1 ? '' : 'es'}${
              card.back ? ` — ${card.back}` : ''
            }`
          : card.back || '';

      return `
        <article class="card-item" data-card-id="${escapeHtml(card.id)}">
          <div class="card-item-header">
            <div class="card-item-badges">
              <span class="badge ${typeClass}">${typeLabel}</span>
              <span class="badge ${sourceClass}">${sourceLabel}</span>
              <span class="badge ${due ? 'badge-due' : ''}">${due ? 'Due Now' : `Due ${escapeHtml(formatDate(card.fsrs?.dueDate))}`}</span>
            </div>
            <div class="card-item-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-card-action="edit" data-card-id="${escapeHtml(card.id)}">Edit</button>
              <button type="button" class="btn btn-danger-ghost btn-sm" data-card-action="delete" data-card-id="${escapeHtml(card.id)}">Delete</button>
            </div>
          </div>

          <div class="card-item-body">
            <div class="card-item-text">
              <div class="card-item-front">${frontMarkup}</div>
              ${backText ? `<div class="card-item-back">${renderPlainMultiline(backText)}</div>` : ''}
            </div>
            ${
              card.imageDataUrl
                ? `<img class="card-item-thumb" src="${card.imageDataUrl}" alt="Card diagram thumbnail" loading="lazy">`
                : ''
            }
          </div>
        </article>
      `;
    })
    .join('');
}

/* ==========================================================================
   Deck Create / Edit Modal
   ========================================================================== */

function openDeckModal(deck = null) {
  state.editingDeckId = deck ? deck.id : null;
  $('deck-modal-title').textContent = deck ? 'Edit Deck' : 'Create New Deck';
  $('deck-name-input').value = deck ? deck.name : '';
  $('deck-desc-input').value = deck ? deck.description || '' : '';
  $('modal-deck').hidden = false;
  window.setTimeout(() => $('deck-name-input')?.focus(), 40);
}

function closeDeckModal() {
  $('modal-deck').hidden = true;
  state.editingDeckId = null;
}

async function handleDeckFormSubmit(e) {
  e.preventDefault();
  const name = $('deck-name-input').value.trim();
  const description = $('deck-desc-input').value.trim();
  if (!name) {
    showToast('Please enter a deck name.', 'warning');
    return;
  }

  const existing = state.editingDeckId
    ? state.decks.find((d) => d.id === state.editingDeckId)
    : null;

  const saved = await saveDeck(
    createDeckObject({
      id: existing?.id,
      name,
      description,
      createdAt: existing?.createdAt,
    })
  );

  closeDeckModal();
  await reloadAllData();

  const select = $('create-deck-select');
  if (select) {
    select.value = saved.id;
  }

  showToast(existing ? 'Deck updated.' : `Created deck "${saved.name}".`, 'success');
}

/* ==========================================================================
   Create View: Shared Deck Selector, Manual Mode & Canvas
   ========================================================================== */

function syncCreateDeckDropdown() {
  const select = $('create-deck-select');
  if (!select) return;

  const previous = select.value || state.selectedDeckId || '';
  if (state.decks.length === 0) {
    select.innerHTML = '<option value="">-- Create a deck first --</option>';
    return;
  }

  select.innerHTML = state.decks
    .map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`)
    .join('');

  if (previous && state.decks.some((d) => d.id === previous)) {
    select.value = previous;
  } else {
    select.value = state.decks[0].id;
  }
}

function setCreateMode(mode) {
  state.createMode = mode === 'ai' ? 'ai' : 'manual';
  document.querySelectorAll('[data-create-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.createMode === state.createMode);
  });

  $('create-manual-panel').hidden = state.createMode !== 'manual';
  $('create-ai-panel').hidden = state.createMode !== 'ai';

  if (state.createMode === 'manual' && state.manualType === 'occlusion' && manualCanvasEditor) {
    requestAnimationFrame(() => manualCanvasEditor.fitToView());
  }
}

function setManualCardType(type) {
  state.manualType = type;
  document.querySelectorAll('[data-manual-type]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.manualType === type);
  });

  $('manual-basic-fields').hidden = type !== 'basic';
  $('manual-cloze-fields').hidden = type !== 'cloze';
  $('manual-occlusion-fields').hidden = type !== 'occlusion';

  if (type === 'occlusion' && manualCanvasEditor) {
    requestAnimationFrame(() => manualCanvasEditor.fitToView());
  }
}

function updateManualClozePreview() {
  const text = $('manual-cloze-text').value;
  const preview = $('manual-cloze-preview');
  if (!preview) return;
  preview.innerHTML = text.trim()
    ? renderClozeHtml(text, false)
    : '<span class="hint-text">Cloze preview will appear here...</span>';
}

async function handleManualImageUpload(file) {
  if (!file) return;
  try {
    const compressedUrl = await compressImageToJpeg(file, { maxWidth: 1600, quality: 0.82 });
    await manualCanvasEditor.loadImage(compressedUrl);
    manualCanvasEditor.setMode('draw');
    showToast('Image compressed & loaded into Canvas Editor.', 'success');
  } catch (err) {
    showToast(err?.message || 'Failed to load image.', 'error');
  }
}

async function handleManualPdfUpload(file) {
  if (!file) return;
  try {
    showToast('Loading PDF pages...', 'info');
    const { pdfDoc, numPages } = await loadPdfDocument(file);
    state.manualPdfDoc = pdfDoc;

    const grid = $('manual-pdf-thumbnails');
    grid.innerHTML = '';
    $('modal-pdf-picker').hidden = false;

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const thumbUrl = await renderPageThumbnail(pdfDoc, pageNum, 220);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'pdf-thumb-card';
      card.innerHTML = `
        <img src="${thumbUrl}" alt="Page ${pageNum}">
        <span class="pdf-thumb-page">Page ${pageNum}</span>
      `;
      card.addEventListener('click', async () => {
        try {
          const highRes = await renderPageHighRes(pdfDoc, pageNum, {
            maxWidth: 1600,
            quality: 0.82,
          });
          await manualCanvasEditor.loadImage(highRes);
          manualCanvasEditor.setMode('draw');
          $('modal-pdf-picker').hidden = true;
          showToast(`Loaded PDF page ${pageNum} into Canvas Editor.`, 'success');
        } catch (err) {
          showToast(err?.message || 'Failed to render PDF page.', 'error');
        }
      });
      grid.appendChild(card);
    }
  } catch (err) {
    showToast(err?.message || 'Failed to load PDF file.', 'error');
  }
}

async function handleSaveManualCard() {
  const deckId = $('create-deck-select').value;
  if (!deckId || !state.decks.some((d) => d.id === deckId)) {
    showToast('Please select or create a target deck first.', 'warning');
    openDeckModal();
    return;
  }

  let newCard = null;

  if (state.manualType === 'basic') {
    const front = $('manual-basic-front').value.trim();
    const back = $('manual-basic-back').value.trim();
    if (!front || !back) {
      showToast('Please enter both Front and Back text.', 'warning');
      return;
    }
    newCard = createCardObject({
      deckId,
      type: 'basic',
      source: 'manual',
      front,
      back,
    });
    $('manual-basic-front').value = '';
    $('manual-basic-back').value = '';
  } else if (state.manualType === 'cloze') {
    const front = $('manual-cloze-text').value.trim();
    const back = $('manual-cloze-extra').value.trim();
    if (!front) {
      showToast('Please enter a Cloze sentence.', 'warning');
      return;
    }
    if (!/\{\{c\d+::[\s\S]+?\}\}/.test(front)) {
      showToast('Highlight at least one keyword and wrap it as {{c1::...}}.', 'warning');
      return;
    }
    newCard = createCardObject({
      deckId,
      type: 'cloze',
      source: 'manual',
      front,
      back,
    });
    $('manual-cloze-text').value = '';
    $('manual-cloze-extra').value = '';
    updateManualClozePreview();
  } else if (state.manualType === 'occlusion') {
    const imageDataUrl = manualCanvasEditor?.getImageDataUrl();
    const occlusions = manualCanvasEditor?.getOcclusions() || [];
    const front = $('manual-occlusion-title').value.trim() || 'Identify the occluded labels';
    const back = $('manual-occlusion-note').value.trim();

    if (!imageDataUrl) {
      showToast('Please upload an image or pick a PDF page first.', 'warning');
      return;
    }
    if (occlusions.length === 0) {
      showToast('Please draw at least one occlusion box on the image.', 'warning');
      return;
    }

    newCard = createCardObject({
      deckId,
      type: 'occlusion',
      source: 'manual',
      front,
      back,
      imageDataUrl,
      occlusions,
    });

    $('manual-occlusion-title').value = '';
    $('manual-occlusion-note').value = '';
    manualCanvasEditor.clear();
  }

  if (newCard) {
    await saveCard(newCard);
    await reloadAllData();
    showToast('Card saved to deck!', 'success');
  }
}

/* ==========================================================================
   Create View: AI Generator Mode & Preview Staging
   ========================================================================== */

function setAiSource(source) {
  state.aiSource = source === 'text' ? 'text' : 'pdf';
  document.querySelectorAll('[data-ai-source]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.aiSource === state.aiSource);
  });

  $('ai-source-pdf-box').hidden = state.aiSource !== 'pdf';
  $('ai-source-text-box').hidden = state.aiSource !== 'text';
}

function setAiType(type) {
  state.aiType = type === 'occlusion' ? 'occlusion' : 'text-cloze';
  document.querySelectorAll('[data-ai-type]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.aiType === state.aiType);
  });

  $('ai-vision-extra-row').hidden = state.aiType !== 'occlusion';
}

function updateAiPdfSelectionCount() {
  const count = state.aiPdfSelectedPages.size;
  $('ai-pdf-selected-count').textContent = `${count} page${count === 1 ? '' : 's'} selected`;
}

async function handleAiPdfUpload(file) {
  if (!file) return;
  const thumbGrid = $('ai-pdf-thumbnails');
  const controls = $('ai-pdf-controls');

  try {
    $('ai-pdf-filename').textContent = `Loading ${file.name}...`;
    const { pdfDoc, numPages, fileName } = await loadPdfDocument(file);
    state.aiPdfDoc = pdfDoc;
    state.aiPdfFileName = fileName;
    state.aiPdfNumPages = numPages;
    state.aiPdfSelectedPages.clear();

    $('ai-pdf-filename').textContent = `${fileName} (${numPages} pages)`;
    controls.hidden = false;
    thumbGrid.innerHTML = '';
    updateAiPdfSelectionCount();

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const thumbUrl = await renderPageThumbnail(pdfDoc, pageNum, 200);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'pdf-thumb-card';
      card.dataset.page = String(pageNum);
      card.innerHTML = `
        <img src="${thumbUrl}" alt="Page ${pageNum}">
        <span class="pdf-thumb-page">Page ${pageNum}</span>
      `;
      card.addEventListener('click', () => {
        if (state.aiPdfSelectedPages.has(pageNum)) {
          state.aiPdfSelectedPages.delete(pageNum);
          card.classList.remove('selected');
        } else {
          state.aiPdfSelectedPages.add(pageNum);
          card.classList.add('selected');
        }
        updateAiPdfSelectionCount();
      });
      thumbGrid.appendChild(card);
    }
  } catch (err) {
    $('ai-pdf-filename').textContent = 'Failed to load PDF';
    showToast(err?.message || 'Could not parse PDF.', 'error');
  }
}

function selectAllAiPdfPages(select) {
  const cards = $('ai-pdf-thumbnails')?.querySelectorAll('.pdf-thumb-card') || [];
  state.aiPdfSelectedPages.clear();
  cards.forEach((card) => {
    const pageNum = Number(card.dataset.page);
    if (select && Number.isFinite(pageNum)) {
      state.aiPdfSelectedPages.add(pageNum);
      card.classList.add('selected');
    } else {
      card.classList.remove('selected');
    }
  });
  updateAiPdfSelectionCount();
}

async function handleAiVisionImageUpload(file) {
  if (!file) return;
  try {
    const compressedUrl = await compressImageToJpeg(file, { maxWidth: 1600, quality: 0.82 });
    state.aiVisionImageDataUrl = compressedUrl;
    state.aiVisionImageName = file.name || 'image.jpg';
    $('ai-vision-image-name').textContent = `Uploaded: ${state.aiVisionImageName}`;
    showToast('Vision image ready for AI Occlusion.', 'success');
  } catch (err) {
    showToast(err?.message || 'Failed to compress image.', 'error');
  }
}

function showAiError(message) {
  const errBox = $('ai-error-box');
  if (!errBox) return;
  errBox.textContent = message;
  errBox.hidden = false;
}

function hideAiError() {
  const errBox = $('ai-error-box');
  if (!errBox) return;
  errBox.hidden = true;
  errBox.textContent = '';
}

async function handleAiGenerate() {
  hideAiError();

  const settings = getSettings();
  const apiKey = settings.apiKey?.trim();
  const model = getEffectiveModel(settings);
  const customInstruction = $('ai-custom-instruction').value.trim();
  const count = Math.max(1, Math.min(30, Number($('ai-card-count').value) || 6));
  const language = $('ai-language').value || 'Thai';

  const loadingEl = $('ai-loading');
  const loadingTextEl = $('ai-loading-text');
  const generateBtn = $('btn-ai-generate');

  try {
    generateBtn.disabled = true;
    loadingEl.hidden = false;

    if (state.aiType === 'text-cloze') {
      let sourceText = '';
      if (state.aiSource === 'pdf') {
        const selectedPages = Array.from(state.aiPdfSelectedPages).sort((a, b) => a - b);
        if (!state.aiPdfDoc || selectedPages.length === 0) {
          throw new Error('Please upload a PDF and select at least one page.');
        }
        loadingTextEl.textContent = `Extracting text from ${selectedPages.length} PDF page(s)...`;
        sourceText = await extractPagesText(state.aiPdfDoc, selectedPages);
        if (!sourceText.trim()) {
          throw new Error(
            'Selected PDF pages contain no selectable text. Try AI Auto Image Occlusion for scanned slides.'
          );
        }
      } else {
        sourceText = $('ai-raw-text').value.trim();
        if (!sourceText) {
          throw new Error('Please paste study text before generating.');
        }
      }

      loadingTextEl.textContent = `Generating ${count} flashcards with ${model}...`;
      const cards = await generateTextAndClozeCards({
        text: sourceText,
        customInstruction,
        count,
        language,
        apiKey,
        model,
      });

      state.aiPreviewItems = cards.map((c) => ({
        tempId: generateId(),
        selected: true,
        type: c.type,
        front: c.front,
        back: c.back,
        imageDataUrl: null,
        occlusions: [],
      }));
    } else {
      // AI Auto Image Occlusion (Vision)
      const imagesToAnalyze = [];

      const selectedPages = Array.from(state.aiPdfSelectedPages).sort((a, b) => a - b);
      if (state.aiSource === 'pdf' && state.aiPdfDoc && selectedPages.length > 0) {
        for (let i = 0; i < selectedPages.length; i++) {
          const pageNum = selectedPages[i];
          loadingTextEl.textContent = `Rendering PDF page ${pageNum} (${i + 1}/${selectedPages.length})...`;
          const pageImageUrl = await renderPageHighRes(state.aiPdfDoc, pageNum, {
            maxWidth: 1600,
            quality: 0.82,
          });
          imagesToAnalyze.push({
            label: `${state.aiPdfFileName} — Page ${pageNum}`,
            imageDataUrl: pageImageUrl,
          });
        }
      } else if (state.aiVisionImageDataUrl) {
        imagesToAnalyze.push({
          label: state.aiVisionImageName || 'Uploaded Diagram',
          imageDataUrl: state.aiVisionImageDataUrl,
        });
      } else {
        throw new Error(
          'Please select at least one PDF page or upload an image for AI Auto Image Occlusion.'
        );
      }

      const generated = new Array(imagesToAnalyze.length);
      const concurrency = Math.min(3, imagesToAnalyze.length);
      let nextIdx = 0;
      let completed = 0;

      loadingTextEl.textContent = `Detecting occlusion labels (0/${imagesToAnalyze.length}) with ${model}...`;

      const worker = async () => {
        while (nextIdx < imagesToAnalyze.length) {
          const i = nextIdx++;
          const item = imagesToAnalyze[i];
          const res = await generateImageOcclusionBoxes({
            imageDataUrl: item.imageDataUrl,
            customInstruction,
            language,
            apiKey,
            model,
          });
          generated[i] = {
            tempId: generateId(),
            selected: true,
            type: 'occlusion',
            front: res.title || item.label,
            back: '',
            imageDataUrl: item.imageDataUrl,
            occlusions: res.occlusions || [],
          };
          completed += 1;
          loadingTextEl.textContent = `Detecting occlusion labels (${completed}/${imagesToAnalyze.length}) with ${model}...`;
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      state.aiPreviewItems = generated;
    }

    renderAiPreviewList();
    showToast(`Generated ${state.aiPreviewItems.length} preview card(s).`, 'success');
  } catch (err) {
    // Show raw error.message verbatim from Gemini API or validation
    showAiError(err?.message || String(err));
  } finally {
    generateBtn.disabled = false;
    loadingEl.hidden = true;
  }
}

function renderAiPreviewList() {
  const section = $('ai-preview-section');
  const listEl = $('ai-preview-list');
  const countEl = $('ai-preview-count');

  if (!section || !listEl) return;

  if (state.aiPreviewItems.length === 0) {
    section.hidden = true;
    listEl.innerHTML = '';
    return;
  }

  section.hidden = false;
  const selectedCount = state.aiPreviewItems.filter((item) => item.selected).length;
  countEl.textContent = `${selectedCount} / ${state.aiPreviewItems.length} selected`;

  listEl.innerHTML = state.aiPreviewItems
    .map((item, idx) => {
      const isOcc = item.type === 'occlusion';
      const badgeClass =
        item.type === 'cloze' ? 'badge-cloze' : isOcc ? 'badge-occlusion' : 'badge-basic';
      const badgeText =
        item.type === 'cloze' ? 'Cloze' : isOcc ? 'Image Occlusion' : 'Basic';

      return `
        <div class="preview-card ${item.selected ? 'selected' : ''}" data-temp-id="${escapeHtml(item.tempId)}">
          <div class="preview-card-header">
            <label class="preview-card-check">
              <input type="checkbox" class="preview-checkbox" data-temp-id="${escapeHtml(item.tempId)}" ${item.selected ? 'checked' : ''}>
              <span>Card #${idx + 1}</span>
              <span class="badge ${badgeClass}">${badgeText}</span>
            </label>
            <div class="preview-card-actions">
              ${
                !isOcc
                  ? `<select class="input select preview-type-select" data-temp-id="${escapeHtml(item.tempId)}" style="width:auto;padding:0.25rem 0.55rem;font-size:0.8rem;">
                      <option value="basic" ${item.type === 'basic' ? 'selected' : ''}>Basic</option>
                      <option value="cloze" ${item.type === 'cloze' ? 'selected' : ''}>Cloze</option>
                    </select>`
                  : `<button type="button" class="btn btn-secondary btn-sm" data-preview-action="edit-canvas" data-temp-id="${escapeHtml(item.tempId)}">
                      Edit Boxes in Canvas (${item.occlusions.length})
                    </button>`
              }
              <button type="button" class="btn btn-danger-ghost btn-sm" data-preview-action="remove" data-temp-id="${escapeHtml(item.tempId)}">Remove</button>
            </div>
          </div>

          <div class="preview-card-body">
            <div class="field-group">
              <label class="field-label">${isOcc ? 'Card Title / Prompt' : 'Front'}</label>
              <textarea class="input preview-front-input" rows="2" data-temp-id="${escapeHtml(item.tempId)}">${escapeHtml(item.front)}</textarea>
            </div>

            ${
              isOcc
                ? `<div class="field-group">
                    <label class="field-label">Extra Note (Optional)</label>
                    <input type="text" class="input preview-back-input" data-temp-id="${escapeHtml(item.tempId)}" value="${escapeHtml(item.back)}">
                  </div>
                  ${renderAiOcclusionMiniPreview(item)}`
                : `<div class="field-group">
                    <label class="field-label">${item.type === 'cloze' ? 'Extra Note / Explanation' : 'Back'}</label>
                    <textarea class="input preview-back-input" rows="2" data-temp-id="${escapeHtml(item.tempId)}">${escapeHtml(item.back)}</textarea>
                  </div>`
            }
          </div>
        </div>
      `;
    })
    .join('');
}

function renderAiOcclusionMiniPreview(item) {
  if (!item.imageDataUrl) return '';
  const boxesHtml = (item.occlusions || [])
    .map(
      (b, i) => `
      <div style="position:absolute;left:${(b.x * 100).toFixed(2)}%;top:${(b.y * 100).toFixed(2)}%;width:${(b.w * 100).toFixed(2)}%;height:${(b.h * 100).toFixed(2)}%;background:rgba(37,99,235,0.72);border:1.5px solid #fff;border-radius:3px;color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;overflow:hidden;">
        ${escapeHtml(b.label || `#${i + 1}`)}
      </div>`
    )
    .join('');

  return `
    <div style="margin-top:0.35rem;text-align:center;">
      <div class="occlusion-study-stage" style="max-height:240px;">
        <img src="${item.imageDataUrl}" alt="AI Occlusion Preview" style="max-height:240px;">
        ${boxesHtml}
      </div>
    </div>
  `;
}

async function openAiCanvasModal(tempId) {
  const item = state.aiPreviewItems.find((p) => p.tempId === tempId);
  if (!item || !item.imageDataUrl) return;

  state.editingAiPreviewTempId = tempId;
  $('ai-modal-title').textContent = `Edit Occlusion Boxes: ${item.front || 'Diagram'}`;
  $('modal-ai-canvas').hidden = false;

  await aiModalCanvasEditor.loadImage(item.imageDataUrl);
  aiModalCanvasEditor.setOcclusions(item.occlusions || []);
  aiModalCanvasEditor.setMode('select');
  requestAnimationFrame(() => aiModalCanvasEditor.fitToView());
}

async function handleSaveAiSelected() {
  const deckId = $('create-deck-select').value;
  if (!deckId || !state.decks.some((d) => d.id === deckId)) {
    showToast('Please select or create a target deck first.', 'warning');
    openDeckModal();
    return;
  }

  const selected = state.aiPreviewItems.filter((item) => item.selected);
  if (selected.length === 0) {
    showToast('Select at least one preview card to save.', 'warning');
    return;
  }

  const cardsToInsert = selected.map((item) =>
    createCardObject({
      deckId,
      type: item.type,
      source: 'ai',
      front: item.front.trim(),
      back: item.back.trim(),
      imageDataUrl: item.imageDataUrl || null,
      occlusions: item.occlusions || [],
    })
  );

  await saveCardsBatch(cardsToInsert);
  state.aiPreviewItems = state.aiPreviewItems.filter((item) => !item.selected);
  renderAiPreviewList();
  await reloadAllData();
  showToast(`Saved ${cardsToInsert.length} AI card(s) to deck!`, 'success');
}

/* ==========================================================================
   Edit Existing Card Modal
   ========================================================================== */

async function openEditCardModal(cardId) {
  const card = state.cards.find((c) => c.id === cardId);
  if (!card) return;

  state.editingCardId = card.id;
  const typeLabel =
    card.type === 'cloze' ? 'Cloze' : card.type === 'occlusion' ? 'Image Occlusion' : 'Basic';
  $('edit-card-type-badge').textContent = typeLabel;

  $('edit-card-basic-fields').hidden = card.type !== 'basic';
  $('edit-card-cloze-fields').hidden = card.type !== 'cloze';
  $('edit-card-occlusion-fields').hidden = card.type !== 'occlusion';

  if (card.type === 'basic') {
    $('edit-card-front').value = card.front || '';
    $('edit-card-back').value = card.back || '';
  } else if (card.type === 'cloze') {
    $('edit-card-cloze-text').value = card.front || '';
    $('edit-card-cloze-extra').value = card.back || '';
  } else if (card.type === 'occlusion') {
    $('edit-card-occlusion-title').value = card.front || '';
    $('edit-card-occlusion-note').value = card.back || '';
  }

  $('modal-edit-card').hidden = false;

  if (card.type === 'occlusion') {
    await editCardCanvasEditor.loadImage(card.imageDataUrl || null);
    editCardCanvasEditor.setOcclusions(card.occlusions || []);
    editCardCanvasEditor.setMode('select');
    requestAnimationFrame(() => editCardCanvasEditor.fitToView());
  }
}

function closeEditCardModal() {
  $('modal-edit-card').hidden = true;
  state.editingCardId = null;
}

async function handleSaveEditedCard() {
  const card = state.cards.find((c) => c.id === state.editingCardId);
  if (!card) return;

  let updated = { ...card };

  if (card.type === 'basic') {
    const front = $('edit-card-front').value.trim();
    const back = $('edit-card-back').value.trim();
    if (!front || !back) {
      showToast('Front and Back cannot be empty.', 'warning');
      return;
    }
    updated.front = front;
    updated.back = back;
  } else if (card.type === 'cloze') {
    const front = $('edit-card-cloze-text').value.trim();
    const back = $('edit-card-cloze-extra').value.trim();
    if (!front || !/\{\{c\d+::[\s\S]+?\}\}/.test(front)) {
      showToast('Cloze text must contain at least one {{c1::...}} blank.', 'warning');
      return;
    }
    updated.front = front;
    updated.back = back;
  } else if (card.type === 'occlusion') {
    const front = $('edit-card-occlusion-title').value.trim() || 'Image Occlusion';
    const back = $('edit-card-occlusion-note').value.trim();
    const occlusions = editCardCanvasEditor.getOcclusions();
    if (occlusions.length === 0) {
      showToast('Occlusion card must have at least one occlusion box.', 'warning');
      return;
    }
    updated.front = front;
    updated.back = back;
    updated.occlusions = occlusions;
  }

  await saveCard(updated);
  closeEditCardModal();
  await reloadAllData();
  showToast('Card changes saved.', 'success');
}

/* ==========================================================================
   Study Mode (FSRS)
   ========================================================================== */

function startStudySession(deckId, dueOnly = true) {
  const deck = state.decks.find((d) => d.id === deckId);
  if (!deck) return;

  const now = Date.now();
  const deckCards = getDeckCards(deckId);
  const queue = dueOnly ? deckCards.filter((c) => isCardDue(c, now)) : [...deckCards];

  if (queue.length === 0) {
    showToast(dueOnly ? 'No due cards in this deck right now!' : 'This deck has no cards yet.', 'info');
    return;
  }

  // Sort due cards oldest-due first
  queue.sort((a, b) => (a.fsrs?.dueDate || 0) - (b.fsrs?.dueDate || 0));

  state.studySession = {
    deck,
    queue,
    currentIndex: 0,
    revealed: false,
    revealedBoxIds: new Set(),
    cardStartTime: Date.now(),
    reviewedCount: 0,
    passCount: 0,
    totalDurationMs: 0,
  };

  $('study-card-stage').hidden = false;
  $('study-complete-panel').hidden = true;
  switchView('study');
  renderStudyCard();
}

function renderStudyCard() {
  const session = state.studySession;
  if (!session) return;

  if (session.currentIndex >= session.queue.length) {
    renderStudyComplete();
    return;
  }

  const card = session.queue[session.currentIndex];
  session.revealed = false;
  session.revealedBoxIds = new Set();
  session.cardStartTime = Date.now();

  $('study-deck-title').textContent = session.deck.name;
  $('study-progress-text').textContent = `${session.currentIndex + 1} / ${session.queue.length}`;
  const pct = Math.round((session.currentIndex / session.queue.length) * 100);
  $('study-progress-fill').style.width = `${pct}%`;

  const typeBadge = $('study-card-type-badge');
  const sourceBadge = $('study-card-source-badge');
  typeBadge.className = `badge ${
    card.type === 'cloze' ? 'badge-cloze' : card.type === 'occlusion' ? 'badge-occlusion' : 'badge-basic'
  }`;
  typeBadge.textContent =
    card.type === 'cloze' ? 'Cloze' : card.type === 'occlusion' ? 'Image Occlusion' : 'Basic';

  sourceBadge.className = `badge ${card.source === 'ai' ? 'badge-ai' : 'badge-manual'}`;
  sourceBadge.textContent = card.source === 'ai' ? 'AI Generated' : 'Manual';

  updateStudyBodyAndControls(card);
}

function updateStudyBodyAndControls(card) {
  const session = state.studySession;
  const contentEl = $('study-card-content');
  const showAnswerBtn = $('btn-show-answer');
  const occControls = $('study-occlusion-controls');
  const ratingButtons = $('study-rating-buttons');

  if (card.type === 'basic') {
    contentEl.innerHTML = `
      <div class="study-question">${renderPlainMultiline(card.front)}</div>
      ${
        session.revealed
          ? `<hr class="study-divider"><div class="study-answer">${renderPlainMultiline(card.back)}</div>`
          : ''
      }
    `;
    occControls.hidden = true;
    showAnswerBtn.hidden = session.revealed;
    ratingButtons.hidden = !session.revealed;
  } else if (card.type === 'cloze') {
    contentEl.innerHTML = `
      <div class="study-question">${renderClozeHtml(card.front, session.revealed)}</div>
      ${
        session.revealed && card.back
          ? `<div class="study-extra">${renderPlainMultiline(card.back)}</div>`
          : ''
      }
    `;
    occControls.hidden = true;
    showAnswerBtn.hidden = session.revealed;
    ratingButtons.hidden = !session.revealed;
  } else if (card.type === 'occlusion') {
    const boxes = card.occlusions || [];
    const allBoxesRevealed =
      boxes.length === 0 || boxes.every((b) => session.revealedBoxIds.has(b.id));
    if (allBoxesRevealed && !session.revealed) {
      session.revealed = true;
    }

    const masksHtml = boxes
      .map((box, idx) => {
        const isRev = session.revealed || session.revealedBoxIds.has(box.id);
        const label = box.label ? box.label : `#${idx + 1}`;
        return `
          <button
            type="button"
            class="study-occlusion-mask${isRev ? ' revealed' : ''}"
            data-box-id="${escapeHtml(box.id)}"
            data-revealed="${isRev ? 'true' : 'false'}"
            style="left:${(box.x * 100).toFixed(3)}%;top:${(box.y * 100).toFixed(3)}%;width:${(box.w * 100).toFixed(3)}%;height:${(box.h * 100).toFixed(3)}%;"
            title="${isRev ? escapeHtml(label) : 'Click to reveal'}"
          >
            <span>${isRev ? escapeHtml(label) : `${idx + 1}`}</span>
          </button>
        `;
      })
      .join('');

    contentEl.innerHTML = `
      ${card.front ? `<div class="study-occlusion-title">${escapeHtml(card.front)}</div>` : ''}
      <div class="occlusion-study-stage">
        <img src="${card.imageDataUrl || ''}" alt="${escapeHtml(card.front || 'Image Occlusion')}">
        ${masksHtml}
      </div>
      ${
        session.revealed && card.back
          ? `<div class="study-extra">${renderPlainMultiline(card.back)}</div>`
          : ''
      }
    `;

    showAnswerBtn.hidden = true;
    occControls.hidden = session.revealed;
    ratingButtons.hidden = !session.revealed;
  }

  if (session.revealed) {
    const previews = previewAllRatings(card.fsrs);
    for (const r of [1, 2, 3, 4]) {
      const intervalEl = $(`interval-${r}`);
      if (intervalEl) {
        intervalEl.textContent = previews[r]?.label || '-';
      }
    }
  }
}

function revealCurrentStudyAnswer() {
  const session = state.studySession;
  if (!session) return;
  const card = session.queue[session.currentIndex];
  if (!card) return;

  session.revealed = true;
  if (card.type === 'occlusion') {
    for (const box of card.occlusions || []) {
      session.revealedBoxIds.add(box.id);
    }
  }
  updateStudyBodyAndControls(card);
}

function revealNextOcclusionBox() {
  const session = state.studySession;
  if (!session) return;
  const card = session.queue[session.currentIndex];
  if (!card || card.type !== 'occlusion') return;

  const nextBox = (card.occlusions || []).find((b) => !session.revealedBoxIds.has(b.id));
  if (nextBox) {
    session.revealedBoxIds.add(nextBox.id);
  }
  if ((card.occlusions || []).every((b) => session.revealedBoxIds.has(b.id))) {
    session.revealed = true;
  }
  updateStudyBodyAndControls(card);
}

async function handleStudyRating(ratingNum) {
  const session = state.studySession;
  if (!session) return;
  const card = session.queue[session.currentIndex];
  if (!card) return;

  const now = Date.now();
  const durationMs = Math.max(200, now - (session.cardStartTime || now));
  const { nextFsrs } = scheduleCard(card.fsrs, ratingNum, now);

  const updatedCard = {
    ...card,
    fsrs: nextFsrs,
  };
  await saveCard(updatedCard);

  const log = createReviewLogObject({
    cardId: card.id,
    deckId: card.deckId,
    rating: ratingNum,
    timestamp: now,
    durationMs,
  });
  await addReviewLog(log);

  // Update in-memory copies immediately
  const cardIdx = state.cards.findIndex((c) => c.id === card.id);
  if (cardIdx >= 0) {
    state.cards[cardIdx] = updatedCard;
  }
  state.reviewLogs.push(log);

  session.reviewedCount += 1;
  if (ratingNum >= 2) session.passCount += 1;
  session.totalDurationMs += durationMs;

  session.currentIndex += 1;
  renderStudyCard();
}

function renderStudyComplete() {
  const session = state.studySession;
  if (!session) return;

  $('study-progress-fill').style.width = '100%';
  $('study-progress-text').textContent = `${session.queue.length} / ${session.queue.length}`;
  $('study-card-stage').hidden = true;
  $('study-complete-panel').hidden = false;

  const acc =
    session.reviewedCount > 0
      ? Math.round((session.passCount / session.reviewedCount) * 100)
      : 100;

  $('study-complete-summary').innerHTML = `
    <h2 style="font-size:1.5rem;font-weight:700;">Session Complete!</h2>
    <p class="hint-text">Great work reviewing <strong>${escapeHtml(session.deck.name)}</strong>.</p>
    <div class="kpi-grid" style="margin-top:0.5rem;">
      <div class="kpi-card">
        <span class="kpi-label">Cards Studied</span>
        <strong class="kpi-value">${session.reviewedCount}</strong>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Accuracy</span>
        <strong class="kpi-value">${acc}%</strong>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Total Time</span>
        <strong class="kpi-value">${escapeHtml(formatDuration(session.totalDurationMs))}</strong>
      </div>
    </div>
  `;
}

/* ==========================================================================
   History, Export & Import
   ========================================================================== */

function renderHistoryView() {
  const mount = $('history-dashboard-mount');
  if (mount) {
    renderHistoryDashboard(mount, state.reviewLogs, state.decks);
  }
}

async function handleExportJson() {
  try {
    const bundle = await exportAllData();
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `flashcard-studio-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);

    showToast(
      `Exported ${bundle.decks.length} deck(s), ${bundle.cards.length} card(s), and ${bundle.reviewLogs.length} log(s).`,
      'success'
    );
  } catch (err) {
    showToast(err?.message || 'Failed to export backup.', 'error');
  }
}

async function handleImportJsonFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);

    const ok = await confirmAction(
      'Import Backup (.json)',
      `Replace current database with ${payload.decks?.length ?? 0} deck(s), ${payload.cards?.length ?? 0} card(s), and ${payload.reviewLogs?.length ?? 0} review log(s)?`,
      'Import & Replace'
    );
    if (!ok) return;

    const counts = await importAllData(payload, 'replace');
    await reloadAllData();
    showToast(
      `Imported ${counts.decksCount} deck(s), ${counts.cardsCount} card(s), ${counts.logsCount} log(s).`,
      'success'
    );
  } catch (err) {
    showToast(err?.message || 'Invalid JSON backup file.', 'error');
  }
}

async function handleLoadSampleData() {
  try {
    const res = await loadSampleData();
    await reloadAllData();
    showToast(
      `Loaded sample data (${res.decksCount} decks, ${res.cardsCount} cards, ${res.logsCount} review logs).`,
      'success'
    );
  } catch (err) {
    showToast(err?.message || 'Failed to load sample data.', 'error');
  }
}

/* ==========================================================================
   Event Wiring & Bootstrap
   ========================================================================== */

function bindEvents() {
  // Navigation Tabs
  document.querySelectorAll('.nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      switchView(tab.dataset.view);
    });
  });

  // Theme Toggle in Header
  $('theme-toggle-btn')?.addEventListener('click', () => {
    const current = getSettings().theme === 'dark' ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    saveSettings({ theme: next });
    applyTheme(next);
  });

  // Dashboard Actions
  $('btn-new-deck')?.addEventListener('click', () => openDeckModal(null));
  $('btn-load-sample-dash')?.addEventListener('click', handleLoadSampleData);

  $('decks-grid')?.addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      e.stopPropagation();
      const deckId = actionBtn.dataset.deckId;
      if (actionBtn.dataset.action === 'study-due') {
        startStudySession(deckId, true);
      } else if (actionBtn.dataset.action === 'open-deck') {
        state.selectedDeckId = deckId;
        state.cardSearchQuery = '';
        state.cardFilterSource = 'all';
        $('card-search-input').value = '';
        document.querySelectorAll('.filter-pill').forEach((p) => {
          p.classList.toggle('active', p.dataset.filter === 'all');
        });
        renderDashboard();
      }
      return;
    }

    const card = e.target.closest('.deck-card');
    if (card) {
      state.selectedDeckId = card.dataset.deckId;
      state.cardSearchQuery = '';
      state.cardFilterSource = 'all';
      $('card-search-input').value = '';
      document.querySelectorAll('.filter-pill').forEach((p) => {
        p.classList.toggle('active', p.dataset.filter === 'all');
      });
      renderDashboard();
    }
  });

  // Deck Detail Actions
  $('btn-back-to-decks')?.addEventListener('click', () => {
    state.selectedDeckId = null;
    renderDashboard();
  });

  $('btn-study-deck')?.addEventListener('click', () => {
    if (state.selectedDeckId) startStudySession(state.selectedDeckId, true);
  });

  $('btn-study-all-deck')?.addEventListener('click', () => {
    if (state.selectedDeckId) startStudySession(state.selectedDeckId, false);
  });

  $('btn-add-card-to-deck')?.addEventListener('click', () => {
    switchView('create');
    if (state.selectedDeckId && $('create-deck-select')) {
      $('create-deck-select').value = state.selectedDeckId;
    }
  });

  $('btn-edit-deck')?.addEventListener('click', () => {
    const deck = state.decks.find((d) => d.id === state.selectedDeckId);
    if (deck) openDeckModal(deck);
  });

  $('btn-delete-deck')?.addEventListener('click', async () => {
    const deck = state.decks.find((d) => d.id === state.selectedDeckId);
    if (!deck) return;
    const ok = await confirmAction(
      'Delete Deck',
      `Delete "${deck.name}" and all cards inside it? This cannot be undone.`,
      'Delete Deck'
    );
    if (!ok) return;

    await deleteDeck(deck.id);
    state.selectedDeckId = null;
    await reloadAllData();
    showToast(`Deleted deck "${deck.name}".`, 'info');
  });

  $('card-search-input')?.addEventListener('input', (e) => {
    state.cardSearchQuery = e.target.value;
    renderDeckDetail();
  });

  document.querySelectorAll('.filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      state.cardFilterSource = pill.dataset.filter || 'all';
      document.querySelectorAll('.filter-pill').forEach((p) => {
        p.classList.toggle('active', p === pill);
      });
      renderDeckDetail();
    });
  });

  $('deck-cards-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-card-action]');
    if (!btn) return;
    const cardId = btn.dataset.cardId;
    if (btn.dataset.cardAction === 'edit') {
      openEditCardModal(cardId);
    } else if (btn.dataset.cardAction === 'delete') {
      const ok = await confirmAction(
        'Delete Card',
        'Are you sure you want to delete this flashcard?',
        'Delete'
      );
      if (!ok) return;
      await deleteCard(cardId);
      await reloadAllData();
      showToast('Card deleted.', 'info');
    }
  });

  // Deck Modal
  $('deck-modal-form')?.addEventListener('submit', handleDeckFormSubmit);
  $('btn-deck-modal-cancel')?.addEventListener('click', closeDeckModal);

  // Edit Card Modal
  $('btn-edit-wrap-cloze')?.addEventListener('click', () => {
    wrapSelectionAsCloze($('edit-card-cloze-text'));
  });
  $('btn-edit-card-save')?.addEventListener('click', handleSaveEditedCard);
  $('btn-edit-card-cancel')?.addEventListener('click', closeEditCardModal);

  // Create View Switching
  document.querySelectorAll('[data-create-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setCreateMode(btn.dataset.createMode));
  });
  $('btn-quick-new-deck')?.addEventListener('click', () => openDeckModal(null));

  // Manual Creation
  document.querySelectorAll('[data-manual-type]').forEach((btn) => {
    btn.addEventListener('click', () => setManualCardType(btn.dataset.manualType));
  });

  $('btn-wrap-cloze')?.addEventListener('click', () => {
    if (wrapSelectionAsCloze($('manual-cloze-text'))) {
      updateManualClozePreview();
    }
  });
  $('manual-cloze-text')?.addEventListener('input', updateManualClozePreview);

  $('manual-image-upload')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleManualImageUpload(file);
    e.target.value = '';
  });

  $('manual-pdf-upload')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleManualPdfUpload(file);
    e.target.value = '';
  });

  $('btn-pdf-picker-close')?.addEventListener('click', () => {
    $('modal-pdf-picker').hidden = true;
  });

  $('btn-save-manual-card')?.addEventListener('click', handleSaveManualCard);

  // AI Creation
  document.querySelectorAll('[data-ai-source]').forEach((btn) => {
    btn.addEventListener('click', () => setAiSource(btn.dataset.aiSource));
  });

  document.querySelectorAll('[data-ai-type]').forEach((btn) => {
    btn.addEventListener('click', () => setAiType(btn.dataset.aiType));
  });

  $('ai-pdf-upload')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleAiPdfUpload(file);
    e.target.value = '';
  });

  $('btn-ai-pdf-select-all')?.addEventListener('click', () => selectAllAiPdfPages(true));
  $('btn-ai-pdf-deselect-all')?.addEventListener('click', () => selectAllAiPdfPages(false));

  $('ai-vision-image-upload')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleAiVisionImageUpload(file);
    e.target.value = '';
  });

  $('btn-ai-generate')?.addEventListener('click', handleAiGenerate);

  $('btn-ai-select-all-preview')?.addEventListener('click', () => {
    const allSelected = state.aiPreviewItems.every((i) => i.selected);
    state.aiPreviewItems.forEach((i) => {
      i.selected = !allSelected;
    });
    renderAiPreviewList();
  });

  $('btn-ai-clear-preview')?.addEventListener('click', () => {
    state.aiPreviewItems = [];
    renderAiPreviewList();
  });

  $('btn-ai-save-selected')?.addEventListener('click', handleSaveAiSelected);

  $('ai-preview-list')?.addEventListener('input', (e) => {
    const target = e.target;
    const tempId = target.dataset?.tempId;
    if (!tempId) return;
    const item = state.aiPreviewItems.find((i) => i.tempId === tempId);
    if (!item) return;

    if (target.classList.contains('preview-front-input')) {
      item.front = target.value;
    } else if (target.classList.contains('preview-back-input')) {
      item.back = target.value;
    }
  });

  $('ai-preview-list')?.addEventListener('change', (e) => {
    const target = e.target;
    const tempId = target.dataset?.tempId;
    if (!tempId) return;
    const item = state.aiPreviewItems.find((i) => i.tempId === tempId);
    if (!item) return;

    if (target.classList.contains('preview-checkbox')) {
      item.selected = target.checked;
      renderAiPreviewList();
    } else if (target.classList.contains('preview-type-select')) {
      item.type = target.value === 'cloze' ? 'cloze' : 'basic';
      renderAiPreviewList();
    }
  });

  $('ai-preview-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preview-action]');
    if (!btn) return;
    const tempId = btn.dataset.tempId;
    if (btn.dataset.previewAction === 'remove') {
      state.aiPreviewItems = state.aiPreviewItems.filter((i) => i.tempId !== tempId);
      renderAiPreviewList();
    } else if (btn.dataset.previewAction === 'edit-canvas') {
      openAiCanvasModal(tempId);
    }
  });

  // AI Canvas Modal
  $('btn-ai-canvas-cancel')?.addEventListener('click', () => {
    $('modal-ai-canvas').hidden = true;
    state.editingAiPreviewTempId = null;
  });

  $('btn-ai-canvas-save')?.addEventListener('click', () => {
    const item = state.aiPreviewItems.find((i) => i.tempId === state.editingAiPreviewTempId);
    if (item) {
      item.occlusions = aiModalCanvasEditor.getOcclusions();
      renderAiPreviewList();
    }
    $('modal-ai-canvas').hidden = true;
    state.editingAiPreviewTempId = null;
  });

  // Study Mode Events
  $('btn-exit-study')?.addEventListener('click', async () => {
    state.studySession = null;
    await reloadAllData();
    switchView('dashboard');
  });

  $('btn-study-finish')?.addEventListener('click', async () => {
    state.studySession = null;
    await reloadAllData();
    switchView('dashboard');
  });

  $('btn-show-answer')?.addEventListener('click', revealCurrentStudyAnswer);
  $('btn-study-reveal-next')?.addEventListener('click', revealNextOcclusionBox);
  $('btn-study-reveal-all')?.addEventListener('click', revealCurrentStudyAnswer);

  $('study-card-content')?.addEventListener('click', (e) => {
    const mask = e.target.closest('.study-occlusion-mask');
    if (!mask || !state.studySession) return;
    const boxId = mask.dataset.boxId;
    const card = state.studySession.queue[state.studySession.currentIndex];
    if (!card || card.type !== 'occlusion') return;

    state.studySession.revealedBoxIds.add(boxId);
    updateStudyBodyAndControls(card);
  });

  $('study-rating-buttons')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rating]');
    if (!btn) return;
    const rating = Number(btn.dataset.rating);
    if (rating >= 1 && rating <= 4) {
      handleStudyRating(rating);
    }
  });

  // History & Backup
  $('btn-export-json')?.addEventListener('click', handleExportJson);
  $('btn-export-json-settings')?.addEventListener('click', handleExportJson);

  $('import-json-input')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleImportJsonFile(file);
    e.target.value = '';
  });

  $('btn-import-json-settings')?.addEventListener('click', () => {
    $('import-json-input')?.click();
  });

  // Settings View
  $('btn-toggle-api-key')?.addEventListener('click', () => {
    const input = $('setting-api-key');
    const btn = $('btn-toggle-api-key');
    if (!input || !btn) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    btn.textContent = isPassword ? 'Hide' : 'Show';
  });

  $('setting-model-select')?.addEventListener('change', (e) => {
    $('setting-custom-model-row').hidden = e.target.value !== '__custom__';
  });

  $('btn-save-settings')?.addEventListener('click', () => {
    const apiKey = $('setting-api-key').value.trim();
    const selectedModel = $('setting-model-select').value;
    const customModel = $('setting-custom-model').value.trim();

    if (selectedModel === '__custom__' && !customModel) {
      showToast('Please enter a custom Gemini model ID.', 'warning');
      return;
    }

    saveSettings({
      apiKey,
      model: selectedModel === '__custom__' ? customModel : selectedModel,
      customModel,
    });
    showToast(`Settings saved (model: ${getEffectiveModel()}).`, 'success');
  });

  $('btn-theme-light')?.addEventListener('click', () => {
    saveSettings({ theme: 'light' });
    applyTheme('light');
  });

  $('btn-theme-dark')?.addEventListener('click', () => {
    saveSettings({ theme: 'dark' });
    applyTheme('dark');
  });

  $('btn-load-sample-settings')?.addEventListener('click', handleLoadSampleData);

  $('btn-clear-all-data')?.addEventListener('click', async () => {
    const ok = await confirmAction(
      'Clear All Data',
      'Delete ALL decks, flashcards, and study history from your browser? This cannot be undone.',
      'Clear Everything'
    );
    if (!ok) return;

    await clearAllData();
    state.selectedDeckId = null;
    await reloadAllData();
    showToast('All local flashcard data cleared.', 'info');
  });

  // Confirm Modal
  $('btn-confirm-ok')?.addEventListener('click', () => closeConfirmModal(true));
  $('btn-confirm-cancel')?.addEventListener('click', () => closeConfirmModal(false));

  // Backdrop click to dismiss modals cleanly
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target !== backdrop) return;
      if (backdrop.id === 'modal-confirm') {
        closeConfirmModal(false);
      } else if (backdrop.id === 'modal-deck') {
        closeDeckModal();
      } else if (backdrop.id === 'modal-edit-card') {
        closeEditCardModal();
      } else {
        backdrop.hidden = true;
      }
    });
  });
}

async function init() {
  hydrateSettingsUI();

  manualCanvasEditor = new OcclusionCanvasEditor($('manual-canvas-container'));
  editCardCanvasEditor = new OcclusionCanvasEditor($('edit-card-canvas-container'));
  aiModalCanvasEditor = new OcclusionCanvasEditor($('ai-modal-canvas-container'));

  bindEvents();
  updateManualClozePreview();

  await openDB();
  await reloadAllData();
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    console.error('Initialization error:', err);
    showToast(err?.message || 'Failed to initialize application.', 'error');
  });
});
