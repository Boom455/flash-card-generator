/**
 * Google Gemini REST API client & settings persistence (Pure ESM, client-side).
 */

export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const PRESET_MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

const SETTINGS_STORAGE_KEY = 'fcs_settings';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const DEFAULT_SETTINGS = Object.freeze({
  apiKey: '',
  model: DEFAULT_MODEL,
  customModel: '',
  theme: 'light',
});

/**
 * Generates a unique ID using crypto.randomUUID when available, with a safe fallback.
 * @returns {string}
 */
function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `occ_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

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
 * Safely reads persisted user settings from localStorage with schema defaults.
 * @returns {{ apiKey: string, model: string, customModel: string, theme: string }}
 */
export function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_SETTINGS };
    }
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : DEFAULT_SETTINGS.apiKey,
      model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_SETTINGS.model,
      customModel: typeof parsed.customModel === 'string' ? parsed.customModel : DEFAULT_SETTINGS.customModel,
      theme: parsed.theme === 'dark' ? 'dark' : 'light',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Merges partial settings into stored settings and persists to localStorage.
 * @param {Partial<{ apiKey: string, model: string, customModel: string, theme: string }>} partial
 * @returns {{ apiKey: string, model: string, customModel: string, theme: string }}
 */
export function saveSettings(partial) {
  const current = getSettings();
  const next = {
    ...current,
    ...(partial && typeof partial === 'object' ? partial : {}),
  };

  next.apiKey = typeof next.apiKey === 'string' ? next.apiKey : '';
  next.model = typeof next.model === 'string' && next.model ? next.model : DEFAULT_MODEL;
  next.customModel = typeof next.customModel === 'string' ? next.customModel : '';
  next.theme = next.theme === 'dark' ? 'dark' : 'light';

  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota or private mode failures while still returning merged state
  }

  return next;
}

/**
 * Resolves the active Gemini model ID from settings (supporting custom model override).
 * @param {{ apiKey?: string, model?: string, customModel?: string, theme?: string }} [settings]
 * @returns {string}
 */
export function getEffectiveModel(settings = getSettings()) {
  const selected = typeof settings?.model === 'string' ? settings.model.trim() : '';
  if (selected === '__custom__' || selected === 'custom') {
    return settings?.customModel?.trim() || DEFAULT_MODEL;
  }
  return selected || DEFAULT_MODEL;
}

/**
 * Strips accidental markdown code fences and parses a JSON string from Gemini output.
 * @param {string} rawText
 * @returns {any}
 */
function parseJsonResponse(rawText) {
  let cleaned = String(rawText ?? '').trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse Gemini JSON response: ${err.message}`);
  }
}

/**
 * Parses MIME type and Base64 payload from an image Data URL.
 * @param {string} dataUrl
 * @returns {{ mimeType: string, data: string }}
 */
function parseImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.trim()) {
    throw new Error('Image data URL is required.');
  }
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) {
    throw new Error('Invalid image format. Expected a base64 Data URL.');
  }
  return {
    mimeType: match[1].trim(),
    data: match[2].trim(),
  };
}

/**
 * Sends a generateContent request to the Gemini v1beta REST API.
 * Preserves exact Gemini API `error.message` strings on HTTP failures.
 *
 * @param {{
 *   apiKey?: string,
 *   model?: string,
 *   contents: Array<any>,
 *   systemInstruction?: string | { parts: Array<{ text: string }> },
 *   generationConfig?: Record<string, any>
 * }} params
 * @returns {Promise<string>} Extracted response text
 */
export async function callGeminiAPI({ apiKey, model, contents, systemInstruction, generationConfig }) {
  const settings = getSettings();
  const resolvedKey = (apiKey !== undefined ? apiKey : settings.apiKey)?.trim();
  if (!resolvedKey) {
    throw new Error('Gemini API Key is required. Please configure it in Settings.');
  }

  const resolvedModel = (typeof model === 'string' && model.trim())
    ? model.trim()
    : getEffectiveModel(settings);

  const endpoint = `${GEMINI_API_BASE}/${encodeURIComponent(resolvedModel)}:generateContent?key=${encodeURIComponent(resolvedKey)}`;

  const payload = { contents };
  if (systemInstruction) {
    payload.systemInstruction = typeof systemInstruction === 'string'
      ? { parts: [{ text: systemInstruction }] }
      : systemInstruction;
  }
  if (generationConfig && typeof generationConfig === 'object') {
    payload.generationConfig = generationConfig;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const msg = data?.error?.message || `Gemini API request failed (HTTP ${response.status})`;
    throw new Error(msg);
  }

  const blockReason = data?.promptFeedback?.blockReason;
  const candidate = data?.candidates?.[0];

  if (!candidate) {
    if (blockReason) {
      throw new Error(`Gemini blocked the request (${blockReason}).`);
    }
    throw new Error('Gemini API returned no response candidates.');
  }

  const text = (candidate.content?.parts || [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();

  if (!text) {
    const finishReason = candidate.finishReason || blockReason || 'empty response';
    throw new Error(`Gemini API returned no usable content (${finishReason}).`);
  }

  return text;
}

/**
 * Generates Basic (Q&A) and Cloze deletion flashcards from study text.
 *
 * @param {{
 *   text: string,
 *   customInstruction?: string,
 *   count?: number,
 *   language?: string,
 *   apiKey?: string,
 *   model?: string
 * }} params
 * @returns {Promise<Array<{ type: 'basic'|'cloze', front: string, back: string }>>}
 */
export async function generateTextAndClozeCards({
  text,
  customInstruction = '',
  count = 6,
  language = 'Thai',
  apiKey,
  model,
}) {
  if (!text || !String(text).trim()) {
    throw new Error('Study text is required to generate flashcards.');
  }

  const targetCount = clamp(Math.round(Number(count) || 6), 1, 30);
  const targetLanguage = String(language || 'Thai').trim() || 'Thai';
  const extraInstruction = String(customInstruction || '').trim();

  const systemInstruction = [
    `You are an expert medical and academic educator creating high-yield spaced-repetition flashcards in ${targetLanguage}.`,
    `Generate exactly ${targetCount} flashcards from the provided study content.`,
    'Follow any user custom instruction strictly.',
    'Supported card types:',
    '- "basic": "front" is a clear, focused question or prompt; "back" is the concise, accurate answer.',
    '- "cloze": "front" is a clear sentence containing {{c1::key term}} (and {{c2::...}} if helpful); "back" is a brief explanation or supporting context.',
    'Include a helpful mix of "basic" and "cloze" cards unless the custom instruction specifies a particular style or card type.',
    'Ensure every fact is accurate and directly grounded in the provided study material.',
  ].join('\n');

  const userPromptParts = [
    `Language: ${targetLanguage}`,
    `Requested card count: ${targetCount}`,
  ];
  if (extraInstruction) {
    userPromptParts.push(`Custom instruction (follow strictly): ${extraInstruction}`);
  }
  userPromptParts.push(`Study content:\n"""\n${String(text).trim()}\n"""`);

  const rawJson = await callGeminiAPI({
    apiKey,
    model,
    systemInstruction,
    contents: [
      {
        role: 'user',
        parts: [{ text: userPromptParts.join('\n\n') }],
      },
    ],
    generationConfig: {
      temperature: 0.35,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            type: {
              type: 'STRING',
              enum: ['basic', 'cloze'],
            },
            front: {
              type: 'STRING',
            },
            back: {
              type: 'STRING',
            },
          },
          required: ['type', 'front', 'back'],
        },
      },
    },
  });

  const parsed = parseJsonResponse(rawJson);
  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.cards)
      ? parsed.cards
      : null;

  if (!rawList) {
    throw new Error('Gemini returned an unexpected JSON structure for flashcards.');
  }

  const normalized = rawList
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      type: item.type === 'cloze' ? 'cloze' : 'basic',
      front: String(item.front ?? '').trim(),
      back: String(item.back ?? '').trim(),
    }))
    .filter((card) => card.front.length > 0 && card.back.length > 0);

  if (normalized.length === 0) {
    throw new Error('Gemini did not return any valid flashcards.');
  }

  return normalized;
}

/**
 * Detects key labels or anatomical/conceptual targets in an image and returns
 * normalized Image Occlusion boxes (`0..1`) suitable for OcclusionCanvasEditor.
 *
 * @param {{
 *   imageDataUrl: string,
 *   customInstruction?: string,
 *   language?: string,
 *   apiKey?: string,
 *   model?: string
 * }} params
 * @returns {Promise<{ title: string, occlusions: Array<{ id: string, x: number, y: number, w: number, h: number, label: string }> }>}
 */
export async function generateImageOcclusionBoxes({
  imageDataUrl,
  customInstruction = '',
  language = 'Thai',
  apiKey,
  model,
}) {
  const { mimeType, data } = parseImageDataUrl(imageDataUrl);
  const targetLanguage = String(language || 'Thai').trim() || 'Thai';
  const extraInstruction = String(customInstruction || '').trim();

  const systemInstruction = [
    `You are an expert study assistant creating Image Occlusion flashcards in ${targetLanguage}.`,
    'Analyze the provided diagram, slide, or anatomical/study image.',
    'Identify key labels, terms, or distinct visual structures/concepts that should be hidden for active-recall testing.',
    'For each item, return:',
    '- "label": concise answer/name in the requested language (or matching the label being tested).',
    '- "box_2d": exact 4-integer bounding box [ymin, xmin, ymax, xmax] normalized to a 0 to 1000 integer scale.',
    'Keep bounding boxes tight around each target label or region without overlapping unnecessarily or covering the entire image.',
    'Also provide a short descriptive "title" for the image.',
  ].join('\n');

  const promptLines = [
    `Target language for title and labels: ${targetLanguage}`,
  ];
  if (extraInstruction) {
    promptLines.push(`Custom instruction (follow strictly): ${extraInstruction}`);
  } else {
    promptLines.push('Identify the most important labels, terms, or structures in this image for image occlusion study.');
  }

  const rawJson = await callGeminiAPI({
    apiKey,
    model,
    systemInstruction,
    contents: [
      {
        role: 'user',
        parts: [
          { text: promptLines.join('\n\n') },
          {
            inlineData: {
              mimeType,
              data,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          title: {
            type: 'STRING',
          },
          boxes: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                label: {
                  type: 'STRING',
                },
                box_2d: {
                  type: 'ARRAY',
                  items: {
                    type: 'INTEGER',
                  },
                },
              },
              required: ['label', 'box_2d'],
            },
          },
        },
        required: ['title', 'boxes'],
      },
    },
  });

  const parsed = parseJsonResponse(rawJson);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.boxes)) {
    throw new Error('Gemini returned an unexpected JSON structure for image occlusion boxes.');
  }

  const title = String(parsed.title || 'Image Occlusion').trim() || 'Image Occlusion';
  const occlusions = [];

  for (let i = 0; i < parsed.boxes.length; i += 1) {
    const item = parsed.boxes[i];
    if (!item || !Array.isArray(item.box_2d) || item.box_2d.length < 4) {
      continue;
    }

    const coords = item.box_2d.slice(0, 4).map(Number);
    if (coords.some((n) => !Number.isFinite(n))) {
      continue;
    }

    const ymin = Math.min(coords[0], coords[2]);
    const ymax = Math.max(coords[0], coords[2]);
    const xmin = Math.min(coords[1], coords[3]);
    const xmax = Math.max(coords[1], coords[3]);

    const x = clamp(xmin / 1000, 0, 0.99);
    const y = clamp(ymin / 1000, 0, 0.99);
    const w = clamp((xmax - xmin) / 1000, 0.01, 1 - x);
    const h = clamp((ymax - ymin) / 1000, 0.01, 1 - y);

    occlusions.push({
      id: createId(),
      x,
      y,
      w,
      h,
      label: String(item.label ?? '').trim() || `Label ${occlusions.length + 1}`,
    });
  }

  return { title, occlusions };
}
