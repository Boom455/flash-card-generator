/**
 * PDF & Image processing utilities (Pure ESM, GitHub Pages compatible).
 * Lazy-loads PDF.js from jsDelivr CDN on first PDF operation.
 */

const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs';
const PDFJS_WORKER_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';
const PDFJS_CMAP_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/cmaps/';
const PDFJS_STANDARD_FONTS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/standard_fonts/';

/** Cached dynamic import promise so PDF.js loads at most once. */
let pdfjsPromise = null;

/**
 * Lazy-loads PDF.js ESM module from CDN and configures its web worker.
 * Clears cached promise on failure so subsequent attempts can retry.
 * @returns {Promise<any>}
 */
async function getPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_CDN)
      .then((mod) => {
        const pdfjsLib = mod?.getDocument ? mod : mod?.default || mod;
        if (!pdfjsLib?.getDocument) {
          throw new Error('PDF.js module did not expose getDocument.');
        }
        if (pdfjsLib.GlobalWorkerOptions) {
          pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;
        }
        return pdfjsLib;
      })
      .catch((err) => {
        pdfjsPromise = null;
        throw new Error(`Failed to load PDF.js from CDN: ${err?.message || err}`);
      });
  }
  return pdfjsPromise;
}

/**
 * Loads an image URL or Data URL into an HTMLImageElement.
 * @param {string} src
 * @returns {Promise<HTMLImageElement>}
 */
function loadHtmlImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith('data:') && !src.startsWith('blob:')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image for compression.'));
    img.src = src;
  });
}

/**
 * Ensures an HTMLImageElement has finished loading before drawing.
 * @param {HTMLImageElement} img
 * @returns {Promise<HTMLImageElement>}
 */
async function ensureImageReady(img) {
  if (img.complete && img.naturalWidth > 0) {
    return img;
  }
  if (typeof img.decode === 'function') {
    try {
      await img.decode();
      if (img.naturalWidth > 0) {
        return img;
      }
    } catch {
      // Fall through to event listener fallback
    }
  }
  return new Promise((resolve, reject) => {
    const onLoad = () => {
      cleanup();
      resolve(img);
    };
    const onError = () => {
      cleanup();
      reject(new Error('Failed to decode provided HTMLImageElement.'));
    };
    const cleanup = () => {
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
    };
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);
  });
}

/**
 * Compresses an image source to a JPEG Data URL on a white background.
 * Accepts a File, Blob, HTMLCanvasElement, HTMLImageElement, or Data URL string.
 *
 * @param {File|Blob|HTMLCanvasElement|HTMLImageElement|string} source
 * @param {{ maxWidth?: number, quality?: number }} [options]
 * @returns {Promise<string>} JPEG Data URL
 */
export async function compressImageToJpeg(source, { maxWidth = 1600, quality = 0.82 } = {}) {
  if (!source) {
    throw new TypeError('Image source is required.');
  }

  let objectUrl = null;
  let drawable = null;
  let width = 0;
  let height = 0;

  try {
    if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
      drawable = source;
      width = source.width;
      height = source.height;
    } else if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
      drawable = await ensureImageReady(source);
      width = drawable.naturalWidth || drawable.width;
      height = drawable.naturalHeight || drawable.height;
    } else if (typeof Blob !== 'undefined' && source instanceof Blob) {
      objectUrl = URL.createObjectURL(source);
      drawable = await loadHtmlImage(objectUrl);
      width = drawable.naturalWidth || drawable.width;
      height = drawable.naturalHeight || drawable.height;
    } else if (typeof source === 'string') {
      drawable = await loadHtmlImage(source);
      width = drawable.naturalWidth || drawable.width;
      height = drawable.naturalHeight || drawable.height;
    } else {
      throw new TypeError('Unsupported image source type for JPEG compression.');
    }

    if (!width || !height) {
      throw new Error('Image has invalid zero dimensions.');
    }

    const safeMaxWidth = Math.max(1, Number(maxWidth) || 1600);
    const safeQuality = Math.min(1, Math.max(0.05, Number(quality) || 0.82));

    let targetWidth = width;
    let targetHeight = height;
    if (width > safeMaxWidth) {
      targetWidth = safeMaxWidth;
      targetHeight = Math.max(1, Math.round(height * (safeMaxWidth / width)));
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not create 2D canvas context.');
    }

    // Fill white background first so transparent PNGs/pages do not render black in JPEG
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetWidth, targetHeight);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(drawable, 0, 0, targetWidth, targetHeight);

    const dataUrl = canvas.toDataURL('image/jpeg', safeQuality);
    // Release backing store promptly (important on iOS Safari memory limits)
    canvas.width = 0;
    canvas.height = 0;
    return dataUrl;
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

/**
 * Renders a single PDF page onto a fresh offscreen canvas with a white background.
 * @param {any} page
 * @param {number} scale
 * @returns {Promise<HTMLCanvasElement>}
 */
async function renderPageToCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create 2D canvas context for PDF rendering.');
  }

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({
    canvasContext: ctx,
    viewport,
    background: 'rgb(255, 255, 255)',
  }).promise;

  return canvas;
}

/**
 * Loads a PDF File into a PDF.js document proxy.
 *
 * @param {File} file
 * @returns {Promise<{ pdfDoc: any, numPages: number, fileName: string }>}
 */
export async function loadPdfDocument(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('Please provide a valid PDF file.');
  }

  const pdfjsLib = await getPdfJs();
  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: buffer,
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_STANDARD_FONTS_URL,
  });
  const pdfDoc = await loadingTask.promise;

  return {
    pdfDoc,
    numPages: pdfDoc.numPages,
    fileName: file.name || 'document.pdf',
  };
}

/**
 * Renders a lightweight JPEG thumbnail for a PDF page.
 *
 * @param {any} pdfDoc
 * @param {number} pageNum 1-based page number
 * @param {number} [maxWidth=240]
 * @returns {Promise<string>} JPEG Data URL
 */
export async function renderPageThumbnail(pdfDoc, pageNum, maxWidth = 240) {
  const page = await pdfDoc.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = baseViewport.width > 0 ? maxWidth / baseViewport.width : 1;

  const canvas = await renderPageToCanvas(page, scale);
  try {
    return canvas.toDataURL('image/jpeg', 0.72);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Extracts readable text from a single PDF page, preserving line breaks and spacing.
 *
 * @param {any} pdfDoc
 * @param {number} pageNum 1-based page number
 * @returns {Promise<string>}
 */
export async function extractPageText(pdfDoc, pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const textContent = await page.getTextContent();
  const items = Array.isArray(textContent?.items) ? textContent.items : [];

  let result = '';
  let prevItem = null;

  for (const item of items) {
    if (!item || typeof item.str !== 'string') {
      continue;
    }

    const str = item.str;
    if (prevItem && result.length > 0 && str.length > 0) {
      const prevEndedWithSpace = /\s$/.test(result);
      const currStartsWithSpace = /^\s/.test(str);

      if (!prevEndedWithSpace && !currStartsWithSpace) {
        if (Array.isArray(prevItem.transform) && Array.isArray(item.transform)) {
          const fontSize = Math.abs(item.transform[3]) || Math.abs(item.transform[0]) || 12;
          const prevY = prevItem.transform[5];
          const currY = item.transform[5];
          const prevEndX = prevItem.transform[4] + (prevItem.width || 0);
          const currX = item.transform[4];

          // Detect vertical line jump even when hasEOL wasn't emitted
          if (Math.abs(currY - prevY) > fontSize * 0.55) {
            result += '\n';
          } else if (currX - prevEndX > fontSize * 0.18) {
            result += ' ';
          }
        } else {
          result += ' ';
        }
      }
    }

    result += str;

    if (item.hasEOL) {
      if (!result.endsWith('\n')) {
        result += '\n';
      }
    }

    prevItem = item;
  }

  return result
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts text across multiple PDF pages formatted as `[Page X]\n...` blocks.
 *
 * @param {any} pdfDoc
 * @param {number[]} pageNumbers
 * @returns {Promise<string>}
 */
export async function extractPagesText(pdfDoc, pageNumbers) {
  if (!pdfDoc || !Array.isArray(pageNumbers) || pageNumbers.length === 0) {
    return '';
  }

  const uniqueSorted = [...new Set(pageNumbers)]
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= pdfDoc.numPages)
    .sort((a, b) => a - b);

  const sections = [];
  for (const pageNum of uniqueSorted) {
    const pageText = await extractPageText(pdfDoc, pageNum);
    sections.push(`[Page ${pageNum}]\n${pageText}`);
  }

  return sections.join('\n\n');
}

/**
 * Renders a PDF page at high resolution (up to 2.0x scale, capped to maxWidth)
 * and compresses it as a white-backed JPEG Data URL.
 *
 * @param {any} pdfDoc
 * @param {number} pageNum 1-based page number
 * @param {{ maxWidth?: number, quality?: number }} [options]
 * @returns {Promise<string>} JPEG Data URL
 */
export async function renderPageHighRes(pdfDoc, pageNum, { maxWidth = 1600, quality = 0.82 } = {}) {
  const page = await pdfDoc.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });
  const cappedMaxWidth = Math.min(1600, Math.max(1, Number(maxWidth) || 1600));
  const maxAllowedScale = baseViewport.width > 0 ? cappedMaxWidth / baseViewport.width : 2.0;
  const scale = Math.min(2.0, maxAllowedScale);

  const canvas = await renderPageToCanvas(page, scale);
  try {
    return await compressImageToJpeg(canvas, { maxWidth: cappedMaxWidth, quality });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
