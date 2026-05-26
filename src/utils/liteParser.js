/**
 * ATLAS GPA — LiteParse PDF extractor
 *
 * Uses @llamaindex/liteparse (PDFium-based, local, no cloud API) to extract
 * text from a PDF, then runs the same CSW-tuned regex parser over the result.
 *
 * LiteParse gives better text ordering than pdf-parse on complex layouts.
 * It's the primary parser; the plain pdf-parse+regex path is the fallback.
 */

const { parseSchoologyText } = require('./pdfParser');

// Cache the ESM import (CJS project, so we use dynamic import once)
let _LiteParse = null;
async function getLiteParse() {
  if (!_LiteParse) {
    const mod = await import('@llamaindex/liteparse');
    _LiteParse = mod.LiteParse;
  }
  return _LiteParse;
}

async function parseWithLiteParse(pdfBuffer) {
  try {
    const LiteParse = await getLiteParse();
    const lp = new LiteParse({
      outputFormat: 'text',
      ocrEnabled:   false,   // Schoology PDFs are text-based, OCR not needed
      quiet:        true,
    });

    console.info('[liteparse] parsing PDF...');
    const result  = await lp.parse(pdfBuffer);
    const rawText = result.text || '';
    console.info(`[liteparse] extracted ${rawText.length} chars`);

    if (!rawText || rawText.trim().length < 50) {
      return {
        records: [], schoolYear: null, studentName: null,
        parseWarnings: ['LiteParse extracted very little text — PDF may be image-only'],
        usedLiteParse: false,
      };
    }

    const parsed = parseSchoologyText(rawText);
    return { ...parsed, usedLiteParse: true };
  } catch (err) {
    console.error(`[liteparse] ${err.message}`);
    return {
      records: [], schoolYear: null, studentName: null,
      parseWarnings: [`LiteParse failed: ${err.message}`],
      usedLiteParse: false,
      error: err.message,
    };
  }
}

module.exports = { parseWithLiteParse };
