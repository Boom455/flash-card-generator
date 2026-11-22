/**
 * IndexedDB Persistence Layer, Schema Builders & Sample Dataset Generator
 * Pure Vanilla ES Module — zero external dependencies.
 */

import { createInitialFSRS } from './fsrs.js';

const DB_NAME = 'FlashcardStudioDB';
const DB_VERSION = 1;
const STORE_DECKS = 'decks';
const STORE_CARDS = 'cards';
const STORE_LOGS = 'reviewLogs';

let cachedDbPromise = null;

/**
 * Generate a unique identifier using crypto.randomUUID with a safe fallback.
 * @returns {string}
 */
export function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Open (and lazily initialize/upgrade) the FlashcardStudioDB IndexedDB instance.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (cachedDbPromise) {
    return cachedDbPromise;
  }

  cachedDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported in this environment.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_DECKS)) {
        const decksStore = db.createObjectStore(STORE_DECKS, { keyPath: 'id' });
        decksStore.createIndex('createdAt', 'createdAt', { unique: false });
        decksStore.createIndex('updatedAt', 'updatedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_CARDS)) {
        const cardsStore = db.createObjectStore(STORE_CARDS, { keyPath: 'id' });
        cardsStore.createIndex('deckId', 'deckId', { unique: false });
        cardsStore.createIndex('source', 'source', { unique: false });
        cardsStore.createIndex('type', 'type', { unique: false });
        cardsStore.createIndex('dueDate', 'fsrs.dueDate', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_LOGS)) {
        const logsStore = db.createObjectStore(STORE_LOGS, { keyPath: 'id' });
        logsStore.createIndex('cardId', 'cardId', { unique: false });
        logsStore.createIndex('deckId', 'deckId', { unique: false });
        logsStore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      db.onversionchange = () => {
        db.close();
        cachedDbPromise = null;
      };
      db.onclose = () => {
        cachedDbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      cachedDbPromise = null;
      reject(request.error || new Error('Failed to open IndexedDB.'));
    };

    request.onblocked = () => {
      cachedDbPromise = null;
      reject(new Error('IndexedDB open request was blocked by another open tab.'));
    };
  });

  return cachedDbPromise;
}

/**
 * Wrap an IDBRequest into a Promise.
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

/**
 * Wrap an IDBTransaction completion into a Promise.
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function promisifyTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
  });
}

/**
 * Build a normalized Deck object.
 * @param {object} [input]
 * @returns {{ id: string, name: string, description: string, createdAt: number, updatedAt: number }}
 */
export function createDeckObject({
  id,
  name,
  description = '',
  createdAt,
  updatedAt,
} = {}) {
  const now = Date.now();
  const normalizedName = String(name ?? '').trim() || 'Untitled Deck';
  return {
    id: id || generateId(),
    name: normalizedName,
    description: String(description ?? '').trim(),
    createdAt: Number.isFinite(createdAt) ? createdAt : now,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
  };
}

/**
 * Normalize an image occlusion box to the shared 0..1 coordinate schema.
 * @param {object} occ
 * @returns {{ id: string, x: number, y: number, w: number, h: number, label: string }}
 */
function normalizeOcclusion(occ) {
  return {
    id: occ?.id || generateId(),
    x: Number(occ?.x ?? 0),
    y: Number(occ?.y ?? 0),
    w: Number(occ?.w ?? 0),
    h: Number(occ?.h ?? 0),
    label: String(occ?.label ?? ''),
  };
}

/**
 * Build a normalized Card object matching the shared application schema.
 * @param {object} [input]
 * @returns {object}
 */
export function createCardObject({
  id,
  deckId = '',
  type = 'basic',
  source = 'manual',
  front = '',
  back = '',
  imageDataUrl = null,
  occlusions = [],
  createdAt,
  fsrs,
} = {}) {
  const now = Date.now();
  const ts = Number.isFinite(createdAt) ? createdAt : now;
  const baseFsrs = createInitialFSRS(ts);

  let normalizedType = String(type || 'basic').toLowerCase();
  if (normalizedType === 'image-occlusion') normalizedType = 'occlusion';
  if (normalizedType !== 'basic' && normalizedType !== 'cloze' && normalizedType !== 'occlusion') {
    normalizedType = 'basic';
  }

  const normalizedSource = source === 'ai' ? 'ai' : 'manual';

  return {
    id: id || generateId(),
    deckId: String(deckId ?? ''),
    type: normalizedType,
    source: normalizedSource,
    front: String(front ?? ''),
    back: String(back ?? ''),
    imageDataUrl: imageDataUrl || null,
    occlusions: Array.isArray(occlusions) ? occlusions.map(normalizeOcclusion) : [],
    createdAt: ts,
    fsrs: fsrs ? { ...baseFsrs, ...fsrs } : baseFsrs,
  };
}

/**
 * Build a normalized ReviewLog object.
 * @param {object} [input]
 * @returns {{ id: string, cardId: string, deckId: string, rating: number, timestamp: number, durationMs: number }}
 */
export function createReviewLogObject({
  id,
  cardId = '',
  deckId = '',
  rating = 3,
  timestamp,
  durationMs = 0,
} = {}) {
  const now = Date.now();
  return {
    id: id || generateId(),
    cardId: String(cardId ?? ''),
    deckId: String(deckId ?? ''),
    rating: Number(rating) || 3,
    timestamp: Number.isFinite(timestamp) ? timestamp : now,
    durationMs: Math.max(0, Number(durationMs) || 0),
  };
}

/* ===========================
 * Deck CRUD Operations
 * =========================== */

/**
 * Fetch all decks sorted by most recently updated first.
 * @returns {Promise<Array<object>>}
 */
export async function getAllDecks() {
  const db = await openDB();
  const tx = db.transaction(STORE_DECKS, 'readonly');
  const decks = await promisifyRequest(tx.objectStore(STORE_DECKS).getAll());
  return decks.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * Fetch a single deck by ID.
 * @param {string} id
 * @returns {Promise<object|undefined>}
 */
export async function getDeck(id) {
  if (!id) return undefined;
  const db = await openDB();
  const tx = db.transaction(STORE_DECKS, 'readonly');
  return promisifyRequest(tx.objectStore(STORE_DECKS).get(id));
}

/**
 * Insert or update a deck, refreshing updatedAt.
 * @param {object} deck
 * @returns {Promise<object>}
 */
export async function saveDeck(deck) {
  const db = await openDB();
  const record = createDeckObject({
    ...deck,
    updatedAt: Date.now(),
  });
  const tx = db.transaction(STORE_DECKS, 'readwrite');
  tx.objectStore(STORE_DECKS).put(record);
  await promisifyTransaction(tx);
  return record;
}

/**
 * Delete a deck and all cards belonging to that deck inside a single transaction.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteDeck(id) {
  if (!id) return;
  const db = await openDB();
  const tx = db.transaction([STORE_DECKS, STORE_CARDS], 'readwrite');
  const decksStore = tx.objectStore(STORE_DECKS);
  const cardsStore = tx.objectStore(STORE_CARDS);

  decksStore.delete(id);

  const deckIndex = cardsStore.index('deckId');
  const cursorReq = deckIndex.openCursor(IDBKeyRange.only(id));
  await new Promise((resolve, reject) => {
    cursorReq.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error || new Error('Failed to delete deck cards.'));
  });

  await promisifyTransaction(tx);
}

/* ===========================
 * Card CRUD Operations
 * =========================== */

/**
 * Fetch all cards across all decks.
 * @returns {Promise<Array<object>>}
 */
export async function getAllCards() {
  const db = await openDB();
  const tx = db.transaction(STORE_CARDS, 'readonly');
  return promisifyRequest(tx.objectStore(STORE_CARDS).getAll());
}

/**
 * Fetch all cards belonging to a given deck.
 * @param {string} deckId
 * @returns {Promise<Array<object>>}
 */
export async function getCardsByDeck(deckId) {
  if (!deckId) return [];
  const db = await openDB();
  const tx = db.transaction(STORE_CARDS, 'readonly');
  return promisifyRequest(tx.objectStore(STORE_CARDS).index('deckId').getAll(deckId));
}

/**
 * Fetch a single card by ID.
 * @param {string} id
 * @returns {Promise<object|undefined>}
 */
export async function getCard(id) {
  if (!id) return undefined;
  const db = await openDB();
  const tx = db.transaction(STORE_CARDS, 'readonly');
  return promisifyRequest(tx.objectStore(STORE_CARDS).get(id));
}

/**
 * Insert or update a single card.
 * @param {object} card
 * @returns {Promise<object>}
 */
export async function saveCard(card) {
  const db = await openDB();
  const record = createCardObject(card);
  const tx = db.transaction(STORE_CARDS, 'readwrite');
  tx.objectStore(STORE_CARDS).put(record);
  await promisifyTransaction(tx);
  return record;
}

/**
 * Insert or update multiple cards in a single transaction.
 * @param {Array<object>} cards
 * @returns {Promise<Array<object>>}
 */
export async function saveCardsBatch(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return [];
  const db = await openDB();
  const records = cards.map((card) => createCardObject(card));
  const tx = db.transaction(STORE_CARDS, 'readwrite');
  const store = tx.objectStore(STORE_CARDS);
  for (const record of records) {
    store.put(record);
  }
  await promisifyTransaction(tx);
  return records;
}

/**
 * Delete a single card by ID.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteCard(id) {
  if (!id) return;
  const db = await openDB();
  const tx = db.transaction(STORE_CARDS, 'readwrite');
  tx.objectStore(STORE_CARDS).delete(id);
  await promisifyTransaction(tx);
}

/* ===========================
 * Review Log Operations
 * =========================== */

/**
 * Fetch all review logs sorted chronologically.
 * @returns {Promise<Array<object>>}
 */
export async function getAllReviewLogs() {
  const db = await openDB();
  const tx = db.transaction(STORE_LOGS, 'readonly');
  const logs = await promisifyRequest(tx.objectStore(STORE_LOGS).getAll());
  return logs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

/**
 * Fetch review logs for a specific deck.
 * @param {string} deckId
 * @returns {Promise<Array<object>>}
 */
export async function getReviewLogsByDeck(deckId) {
  if (!deckId) return [];
  const db = await openDB();
  const tx = db.transaction(STORE_LOGS, 'readonly');
  const logs = await promisifyRequest(tx.objectStore(STORE_LOGS).index('deckId').getAll(deckId));
  return logs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

/**
 * Append a new review log entry.
 * @param {object} log
 * @returns {Promise<object>}
 */
export async function addReviewLog(log) {
  const db = await openDB();
  const record = createReviewLogObject(log);
  const tx = db.transaction(STORE_LOGS, 'readwrite');
  tx.objectStore(STORE_LOGS).put(record);
  await promisifyTransaction(tx);
  return record;
}

/* ===========================
 * Backup / Restore / Clear
 * =========================== */

/**
 * Export all decks, cards, and reviewLogs as a portable JSON-serializable bundle.
 * @returns {Promise<{ schemaVersion: number, exportedAt: number, decks: Array<object>, cards: Array<object>, reviewLogs: Array<object> }>}
 */
export async function exportAllData() {
  const [decks, cards, reviewLogs] = await Promise.all([
    getAllDecks(),
    getAllCards(),
    getAllReviewLogs(),
  ]);

  return {
    schemaVersion: 1,
    exportedAt: Date.now(),
    decks,
    cards,
    reviewLogs,
  };
}

/**
 * Import decks, cards, and reviewLogs into IndexedDB.
 * @param {object} payload
 * @param {'replace'|'merge'} [mode='replace']
 * @returns {Promise<{ decksCount: number, cardsCount: number, logsCount: number }>}
 */
export async function importAllData(payload, mode = 'replace') {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.decks) ||
    !Array.isArray(payload.cards) ||
    !Array.isArray(payload.reviewLogs)
  ) {
    throw new Error('Invalid backup payload: expected decks, cards, and reviewLogs arrays.');
  }

  const decks = payload.decks.map((d) => createDeckObject(d));
  const cards = payload.cards.map((c) => createCardObject(c));
  const reviewLogs = payload.reviewLogs.map((l) => createReviewLogObject(l));

  const db = await openDB();
  const tx = db.transaction([STORE_DECKS, STORE_CARDS, STORE_LOGS], 'readwrite');
  const decksStore = tx.objectStore(STORE_DECKS);
  const cardsStore = tx.objectStore(STORE_CARDS);
  const logsStore = tx.objectStore(STORE_LOGS);

  if (mode === 'replace') {
    decksStore.clear();
    cardsStore.clear();
    logsStore.clear();
  }

  for (const deck of decks) decksStore.put(deck);
  for (const card of cards) cardsStore.put(card);
  for (const log of reviewLogs) logsStore.put(log);

  await promisifyTransaction(tx);

  return {
    decksCount: decks.length,
    cardsCount: cards.length,
    logsCount: reviewLogs.length,
  };
}

/**
 * Clear all decks, cards, and reviewLogs from IndexedDB.
 * @returns {Promise<void>}
 */
export async function clearAllData() {
  const db = await openDB();
  const tx = db.transaction([STORE_DECKS, STORE_CARDS, STORE_LOGS], 'readwrite');
  tx.objectStore(STORE_DECKS).clear();
  tx.objectStore(STORE_CARDS).clear();
  tx.objectStore(STORE_LOGS).clear();
  await promisifyTransaction(tx);
}

/* ===========================
 * Sample Data & Diagrams
 * =========================== */

/**
 * Helper to draw a rounded rectangle on a 2D canvas context.
 */
function drawRoundedRect(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Programmatically render the Cardiac Conduction System diagram onto an offscreen canvas
 * and compute exact normalized (0..1) occlusion rectangles over each label box.
 * @returns {{ imageDataUrl: string|null, occlusions: Array<object> }}
 */
function generateCardiacDiagram() {
  const W = 1000;
  const H = 650;

  const callouts = [
    {
      id: 'sample-occ-sa',
      label: 'SA Node',
      box: { x: 30, y: 155, w: 205, h: 54 },
      target: { x: 356, y: 185 },
      anchor: { x: 235, y: 182 },
    },
    {
      id: 'sample-occ-av',
      label: 'AV Node',
      box: { x: 30, y: 270, w: 205, h: 54 },
      target: { x: 465, y: 292 },
      anchor: { x: 235, y: 297 },
    },
    {
      id: 'sample-occ-his',
      label: 'Bundle of His',
      box: { x: 30, y: 385, w: 205, h: 54 },
      target: { x: 486, y: 342 },
      anchor: { x: 235, y: 412 },
    },
    {
      id: 'sample-occ-la',
      label: 'Left Atrium',
      box: { x: 765, y: 175, w: 205, h: 54 },
      target: { x: 635, y: 215 },
      anchor: { x: 765, y: 202 },
    },
    {
      id: 'sample-occ-purkinje',
      label: 'Purkinje Fibers',
      box: { x: 765, y: 435, w: 205, h: 54 },
      target: { x: 668, y: 455 },
      anchor: { x: 765, y: 462 },
    },
  ];

  const pad = 2;
  const occlusions = callouts.map((c) => ({
    id: c.id,
    x: Number(((c.box.x - pad) / W).toFixed(4)),
    y: Number(((c.box.y - pad) / H).toFixed(4)),
    w: Number(((c.box.w + pad * 2) / W).toFixed(4)),
    h: Number(((c.box.h + pad * 2) / H).toFixed(4)),
    label: c.label,
  }));

  if (typeof document === 'undefined') {
    return { imageDataUrl: null, occlusions };
  }

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { imageDataUrl: null, occlusions };

  // Background
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 2;
  ctx.strokeRect(12, 12, W - 24, H - 24);

  // Header
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 26px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Cardiac Conduction System & Chambers', W / 2, 52);

  ctx.fillStyle = '#475569';
  ctx.font = '15px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText('Electrical propagation pathway from pacemaker to ventricular myocardium', W / 2, 78);

  // Heart Chambers (anatomical view: Right on viewer left, Left on viewer right)
  // Right Atrium
  ctx.fillStyle = '#fee2e2';
  ctx.strokeStyle = '#dc2626';
  ctx.lineWidth = 3;
  drawRoundedRect(ctx, 295, 130, 195, 168, 28);
  ctx.fill();
  ctx.stroke();

  // Left Atrium
  ctx.fillStyle = '#fce7f3';
  ctx.strokeStyle = '#db2777';
  drawRoundedRect(ctx, 510, 130, 195, 168, 28);
  ctx.fill();
  ctx.stroke();

  // Right Ventricle
  ctx.fillStyle = '#ffe4e6';
  ctx.strokeStyle = '#e11d48';
  drawRoundedRect(ctx, 295, 312, 195, 255, 32);
  ctx.fill();
  ctx.stroke();

  // Left Ventricle (thicker myocardial wall)
  ctx.fillStyle = '#fecdd3';
  ctx.strokeStyle = '#9f1239';
  ctx.lineWidth = 6;
  drawRoundedRect(ctx, 510, 312, 195, 270, 36);
  ctx.fill();
  ctx.stroke();

  // Subtle chamber orientation labels (excluding Left Atrium which is occluded)
  ctx.fillStyle = '#991b1b';
  ctx.font = '600 14px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Right Atrium', 392, 268);
  ctx.fillText('Right Ventricle', 392, 535);
  ctx.fillText('Left Ventricle', 608, 545);

  // Conduction Pathway (Amber / Gold)
  ctx.strokeStyle = '#d97706';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Internodal pathways: SA -> AV
  ctx.beginPath();
  ctx.moveTo(356, 185);
  ctx.quadraticCurveTo(425, 200, 465, 292);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(356, 185);
  ctx.quadraticCurveTo(360, 265, 465, 292);
  ctx.stroke();

  // Bundle of His
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(465, 292);
  ctx.lineTo(500, 365);
  ctx.stroke();

  // Right & Left Bundle Branches
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(500, 365);
  ctx.lineTo(475, 505);
  ctx.lineTo(340, 480);
  ctx.lineTo(322, 375);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(500, 365);
  ctx.lineTo(525, 515);
  ctx.lineTo(664, 485);
  ctx.lineTo(678, 370);
  ctx.stroke();

  // Purkinje arborizations
  ctx.lineWidth = 3;
  for (const [x1, y1, x2, y2] of [
    [664, 485, 672, 435],
    [664, 485, 635, 510],
    [340, 480, 330, 430],
    [340, 480, 368, 505],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // SA Node circle
  ctx.fillStyle = '#f59e0b';
  ctx.strokeStyle = '#92400e';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(356, 185, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // AV Node oval
  ctx.beginPath();
  ctx.ellipse(465, 292, 18, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Callout leader lines & label boxes
  for (const c of callouts) {
    // Leader line
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(c.anchor.x, c.anchor.y);
    ctx.lineTo(c.target.x, c.target.y);
    ctx.stroke();

    // Target dot
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(c.target.x, c.target.y, 5, 0, Math.PI * 2);
    ctx.fill();

    // Label Box
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2.5;
    drawRoundedRect(ctx, c.box.x, c.box.y, c.box.w, c.box.h, 10);
    ctx.fill();
    ctx.stroke();

    // Label Text
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 18px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(c.label, c.box.x + c.box.w / 2, c.box.y + c.box.h / 2);
  }

  ctx.textBaseline = 'alphabetic';

  return {
    imageDataUrl: canvas.toDataURL('image/jpeg', 0.82),
    occlusions,
  };
}

/**
 * Programmatically render the Autonomic Cardiac Receptors diagram onto an offscreen canvas
 * and compute normalized occlusion boxes for each receptor target.
 * @returns {{ imageDataUrl: string|null, occlusions: Array<object> }}
 */
function generateReceptorDiagram() {
  const W = 1000;
  const H = 650;

  const rows = [
    {
      id: 'sample-occ-b1',
      neuro: 'Sympathetic • NE / Epi',
      neuroBg: '#fef3c7',
      neuroBorder: '#d97706',
      label: 'Beta-1 (β1) Receptor',
      effect: '↑ Heart Rate & Contractility',
      y: 130,
    },
    {
      id: 'sample-occ-a1',
      neuro: 'Sympathetic • NE',
      neuroBg: '#fef3c7',
      neuroBorder: '#d97706',
      label: 'Alpha-1 (α1) Receptor',
      effect: 'Arteriolar Vasoconstriction',
      y: 250,
    },
    {
      id: 'sample-occ-b2',
      neuro: 'Sympathetic • Epi',
      neuroBg: '#fef3c7',
      neuroBorder: '#d97706',
      label: 'Beta-2 (β2) Receptor',
      effect: 'Bronchodilation & Vasodilation',
      y: 370,
    },
    {
      id: 'sample-occ-m2',
      neuro: 'Parasympathetic • ACh',
      neuroBg: '#dbeafe',
      neuroBorder: '#2563eb',
      label: 'Muscarinic (M2) Receptor',
      effect: '↓ SA & AV Node Conduction',
      y: 490,
    },
  ];

  const boxX = 365;
  const boxW = 270;
  const boxH = 72;
  const pad = 2;

  const occlusions = rows.map((r) => ({
    id: r.id,
    x: Number(((boxX - pad) / W).toFixed(4)),
    y: Number(((r.y - pad) / H).toFixed(4)),
    w: Number(((boxW + pad * 2) / W).toFixed(4)),
    h: Number(((boxH + pad * 2) / H).toFixed(4)),
    label: r.label,
  }));

  if (typeof document === 'undefined') {
    return { imageDataUrl: null, occlusions };
  }

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { imageDataUrl: null, occlusions };

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 2;
  ctx.strokeRect(12, 12, W - 24, H - 24);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 26px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Autonomic Pharmacology: Receptor Targets', W / 2, 52);

  ctx.fillStyle = '#475569';
  ctx.font = '15px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText('Match each neurotransmitter pathway and effector response to its receptor', W / 2, 80);

  for (const r of rows) {
    const midY = r.y + boxH / 2;

    // Left neurotransmitter badge
    ctx.fillStyle = r.neuroBg;
    ctx.strokeStyle = r.neuroBorder;
    ctx.lineWidth = 2;
    drawRoundedRect(ctx, 45, r.y, 250, boxH, 12);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#0f172a';
    ctx.font = '600 16px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(r.neuro, 170, midY);

    // Arrow 1
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(295, midY);
    ctx.lineTo(355, midY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(347, midY - 6);
    ctx.lineTo(357, midY);
    ctx.lineTo(347, midY + 6);
    ctx.stroke();

    // Center Receptor Box (occluded target)
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2.5;
    drawRoundedRect(ctx, boxX, r.y, boxW, boxH, 12);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 18px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText(r.label, boxX + boxW / 2, midY);

    // Arrow 2
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(boxX + boxW, midY);
    ctx.lineTo(695, midY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(687, midY - 6);
    ctx.lineTo(697, midY);
    ctx.lineTo(687, midY + 6);
    ctx.stroke();

    // Right Physiological Effect Box
    ctx.fillStyle = '#ecfdf5';
    ctx.strokeStyle = '#059669';
    ctx.lineWidth = 2;
    drawRoundedRect(ctx, 705, r.y, 250, boxH, 12);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#064e3b';
    ctx.font = '600 16px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText(r.effect, 830, midY);
  }

  ctx.textBaseline = 'alphabetic';

  return {
    imageDataUrl: canvas.toDataURL('image/jpeg', 0.82),
    occlusions,
  };
}

/**
 * Populate realistic sample decks, cards (Basic, Cloze, and Canvas Image Occlusion),
 * and 14 days of reviewLogs without duplicating sample entries if re-run.
 * @returns {Promise<{ decksCount: number, cardsCount: number, logsCount: number }>}
 */
export async function loadSampleData() {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;

  const cardiacDeckId = 'sample-deck-cardiac';
  const vocabDeckId = 'sample-deck-vocab';

  const decks = [
    createDeckObject({
      id: cardiacDeckId,
      name: 'Pharmacology & Cardiac Anatomy (Sample)',
      description: 'Core cardiovascular drugs, physiology, and interactive cardiac diagram occlusions.',
      createdAt: now - 14 * DAY,
      updatedAt: now - 10 * 60 * 1000,
    }),
    createDeckObject({
      id: vocabDeckId,
      name: 'Academic English Vocabulary (Sample)',
      description: 'High-utility GRE/academic terms with contextual cloze deletions and active recall prompts.',
      createdAt: now - 12 * DAY,
      updatedAt: now - 30 * 60 * 1000,
    }),
  ];

  const conductionDiagram = generateCardiacDiagram();
  const receptorDiagram = generateReceptorDiagram();

  const cards = [
    createCardObject({
      id: 'sample-card-c1',
      deckId: cardiacDeckId,
      type: 'basic',
      source: 'manual',
      front: 'Compare the receptor selectivity of Metoprolol vs. Propranolol and state one key clinical precaution for Propranolol.',
      back: 'Metoprolol is β1-selective (cardioselective at standard doses), whereas Propranolol is a non-selective β1/β2 antagonist. Avoid Propranolol in patients with asthma or COPD due to β2-mediated bronchoconstriction.',
      createdAt: now - 14 * DAY,
      fsrs: {
        stability: 3.2,
        difficulty: 4.5,
        reps: 2,
        lapses: 0,
        state: 'review',
        dueDate: now - 2 * HOUR,
        lastReview: now - 3 * DAY,
      },
    }),
    createCardObject({
      id: 'sample-card-c2',
      deckId: cardiacDeckId,
      type: 'basic',
      source: 'manual',
      front: 'What does the Frank-Starling mechanism describe?',
      back: 'Increased ventricular end-diastolic volume (preload) stretches cardiac myocytes, optimizing actin-myosin overlap and increasing stroke volume up to a physiological limit.',
      createdAt: now - 13 * DAY,
      fsrs: createInitialFSRS(now - 13 * DAY),
    }),
    createCardObject({
      id: 'sample-card-c3',
      deckId: cardiacDeckId,
      type: 'cloze',
      source: 'ai',
      front: 'ACE inhibitors block {{c1::angiotensin-converting enzyme}}, lowering {{c2::angiotensin II}} and {{c3::aldosterone}} levels to reduce both preload and afterload.',
      back: 'Recall bradykinin also accumulates because ACE breaks down bradykinin — explaining the dry cough adverse effect.',
      createdAt: now - 10 * DAY,
      fsrs: {
        stability: 2.4,
        difficulty: 3.1,
        reps: 1,
        lapses: 0,
        state: 'review',
        dueDate: now - 30 * 60 * 1000,
        lastReview: now - 2 * DAY,
      },
    }),
    createCardObject({
      id: 'sample-card-c4',
      deckId: cardiacDeckId,
      type: 'cloze',
      source: 'manual',
      front: 'Loop diuretics such as {{c1::furosemide}} inhibit the {{c2::Na⁺-K⁺-2Cl⁻ cotransporter}} in the {{c3::thick ascending limb}} of the loop of Henle.',
      back: 'Mnemonic: "Loops Lose Calcium" — inhibition eliminates the lumen-positive potential, increasing urinary Ca²⁺ and Mg²⁺ excretion.',
      createdAt: now - 9 * DAY,
      fsrs: createInitialFSRS(now - 9 * DAY),
    }),
    createCardObject({
      id: 'sample-card-c5',
      deckId: cardiacDeckId,
      type: 'occlusion',
      source: 'manual',
      front: 'Identify the occluded structures of the Cardiac Conduction System & Chambers.',
      back: 'Impulse sequence: SA Node → AV Node → Bundle of His → Bundle Branches → Purkinje Fibers.',
      imageDataUrl: conductionDiagram.imageDataUrl,
      occlusions: conductionDiagram.occlusions,
      createdAt: now - 8 * DAY,
      fsrs: createInitialFSRS(now - 8 * DAY),
    }),
    createCardObject({
      id: 'sample-card-c6',
      deckId: cardiacDeckId,
      type: 'occlusion',
      source: 'ai',
      front: 'Identify the occluded Autonomic Pharmacology Receptor Targets.',
      back: 'β1 drives cardiac rate/inotropy; α1 constricts arterioles; β2 dilates bronchi/vessels; M2 slows SA/AV nodal conduction.',
      imageDataUrl: receptorDiagram.imageDataUrl,
      occlusions: receptorDiagram.occlusions,
      createdAt: now - 6 * DAY,
      fsrs: createInitialFSRS(now - 6 * DAY),
    }),
    createCardObject({
      id: 'sample-card-c7',
      deckId: cardiacDeckId,
      type: 'basic',
      source: 'ai',
      front: 'Why does Nitroglycerin primarily decrease myocardial oxygen demand?',
      back: 'At low/standard doses it preferentially dilates systemic veins (venodilation), reducing venous return (preload) and ventricular wall tension.',
      createdAt: now - 11 * DAY,
      fsrs: {
        stability: 7.5,
        difficulty: 2.8,
        reps: 3,
        lapses: 0,
        state: 'review',
        dueDate: now + 4 * DAY,
        lastReview: now - 2 * DAY,
      },
    }),

    // Deck 2: Academic English Vocabulary
    createCardObject({
      id: 'sample-card-v1',
      deckId: vocabDeckId,
      type: 'basic',
      source: 'manual',
      front: 'Ubiquitous (adj.)',
      back: 'Present, appearing, or found everywhere simultaneously. Example: "Smartphones have become ubiquitous in modern clinical wards."',
      createdAt: now - 12 * DAY,
      fsrs: {
        stability: 4.1,
        difficulty: 3.4,
        reps: 2,
        lapses: 0,
        state: 'review',
        dueDate: now - HOUR,
        lastReview: now - 4 * DAY,
      },
    }),
    createCardObject({
      id: 'sample-card-v2',
      deckId: vocabDeckId,
      type: 'basic',
      source: 'ai',
      front: 'Ephemeral (adj.)',
      back: 'Lasting for a very short time; transitory. Example: "The ephemeral euphoria of the short-acting anesthetic wore off within minutes."',
      createdAt: now - 11 * DAY,
      fsrs: createInitialFSRS(now - 11 * DAY),
    }),
    createCardObject({
      id: 'sample-card-v3',
      deckId: vocabDeckId,
      type: 'cloze',
      source: 'ai',
      front: 'To {{c1::ameliorate}} a difficult situation means to make it {{c2::better or more tolerable}}, rather than worsening it ({{c3::exacerbate}}).',
      back: 'Pair to remember: ameliorate (improve) vs. exacerbate (worsen).',
      createdAt: now - 9 * DAY,
      fsrs: createInitialFSRS(now - 9 * DAY),
    }),
    createCardObject({
      id: 'sample-card-v4',
      deckId: vocabDeckId,
      type: 'cloze',
      source: 'manual',
      front: 'A {{c1::cogent}} argument is {{c2::clear, logical, and convincing}}, leaving little room for reasonable doubt.',
      back: 'Derived from Latin cogere ("to compel").',
      createdAt: now - 7 * DAY,
      fsrs: {
        stability: 2.0,
        difficulty: 4.2,
        reps: 1,
        lapses: 0,
        state: 'review',
        dueDate: now - 15 * 60 * 1000,
        lastReview: now - 2 * DAY,
      },
    }),
    createCardObject({
      id: 'sample-card-v5',
      deckId: vocabDeckId,
      type: 'basic',
      source: 'manual',
      front: 'Mitigate (v.)',
      back: 'To make less severe, serious, or painful. Example: "Early beta-blocker therapy can mitigate adverse ventricular remodeling."',
      createdAt: now - 8 * DAY,
      fsrs: {
        stability: 8.4,
        difficulty: 2.2,
        reps: 3,
        lapses: 0,
        state: 'review',
        dueDate: now + 5 * DAY,
        lastReview: now - 3 * DAY,
      },
    }),
  ];

  // Generate 14 days of realistic reviewLogs (including a 7-day active streak up to today).
  const dayPlan = [
    { offset: 13, deckId: cardiacDeckId, ratings: [3, 3, 2, 4, 3] },
    { offset: 12, deckId: vocabDeckId, ratings: [3, 4, 1, 3] },
    { offset: 10, deckId: cardiacDeckId, ratings: [2, 3, 3, 4, 3, 4] },
    { offset: 8, deckId: vocabDeckId, ratings: [3, 2, 3, 4] },
    { offset: 6, deckId: cardiacDeckId, ratings: [3, 1, 3, 3, 4] },
    { offset: 5, deckId: vocabDeckId, ratings: [4, 3, 3, 4, 3] },
    { offset: 4, deckId: cardiacDeckId, ratings: [2, 3, 4, 3, 3, 4] },
    { offset: 3, deckId: vocabDeckId, ratings: [3, 3, 2, 4] },
    { offset: 2, deckId: cardiacDeckId, ratings: [1, 3, 3, 4, 3] },
    { offset: 1, deckId: vocabDeckId, ratings: [3, 4, 3, 3, 4, 4] },
    { offset: 0, deckId: cardiacDeckId, ratings: [3, 4, 2, 3] },
  ];

  const nowDate = new Date(now);
  const startOfToday = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate(),
    0,
    0,
    0,
    0
  ).getTime();

  const cardiacCardIds = ['sample-card-c1', 'sample-card-c3', 'sample-card-c7'];
  const vocabCardIds = ['sample-card-v1', 'sample-card-v4', 'sample-card-v5'];
  const reviewLogs = [];
  let logSeq = 1;

  for (const plan of dayPlan) {
    let sessionStart;
    if (plan.offset === 0) {
      // Keep today's sample session strictly in today's local day and <= now.
      sessionStart = Math.max(startOfToday + 60 * 1000, now - 12 * 60 * 1000);
    } else {
      sessionStart = new Date(
        nowDate.getFullYear(),
        nowDate.getMonth(),
        nowDate.getDate() - plan.offset,
        19,
        15,
        0,
        0
      ).getTime();
    }

    const pool = plan.deckId === cardiacDeckId ? cardiacCardIds : vocabCardIds;
    let cursorTs = sessionStart;

    for (let i = 0; i < plan.ratings.length; i++) {
      const durationMs = 2800 + ((logSeq * 1370) % 5800); // 2.8s .. 8.6s
      cursorTs += durationMs + 1200;
      if (plan.offset === 0 && cursorTs > now) {
        cursorTs = now - (plan.ratings.length - i) * 1000;
      }

      reviewLogs.push(
        createReviewLogObject({
          id: `sample-log-${logSeq}`,
          cardId: pool[i % pool.length],
          deckId: plan.deckId,
          rating: plan.ratings[i],
          timestamp: cursorTs,
          durationMs,
        })
      );
      logSeq += 1;
    }
  }

  const db = await openDB();
  const tx = db.transaction([STORE_DECKS, STORE_CARDS, STORE_LOGS], 'readwrite');
  const decksStore = tx.objectStore(STORE_DECKS);
  const cardsStore = tx.objectStore(STORE_CARDS);
  const logsStore = tx.objectStore(STORE_LOGS);

  for (const deck of decks) decksStore.put(deck);
  for (const card of cards) cardsStore.put(card);
  for (const log of reviewLogs) logsStore.put(log);

  await promisifyTransaction(tx);

  return {
    decksCount: decks.length,
    cardsCount: cards.length,
    logsCount: reviewLogs.length,
  };
}
