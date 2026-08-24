/**
 * ATLAS GPA — local Unstructured PDF parser
 *
 * Runs the installed open-source Unstructured Python package locally, then
 * passes its element text through the existing CSW-specific record parser.
 */

const path = require('path');
const { execFile } = require('child_process');
const { parseSchoologyText } = require('./pdfParser');

const PYTHON_BINARY = process.env.UNSTRUCTURED_PYTHON || 'python3';
const HELPER_PATH = path.join(__dirname, 'unstructuredParser.py');
const TIMEOUT_MS = parseInt(process.env.UNSTRUCTURED_TIMEOUT || '60000', 10);

function resultScore(result) {
  const records = result.records || [];
  return {
    graded: records.filter(record => !record.isNA).length,
    total: records.length,
  };
}

function isMoreComplete(candidate, current) {
  const a = resultScore(candidate);
  const b = resultScore(current);
  return a.graded > b.graded || (a.graded === b.graded && a.total > b.total);
}

function extractText(pdfBuffer) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      PYTHON_BINARY,
      [HELPER_PATH],
      { timeout: TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().split('\n').pop();
          reject(new Error(detail || error.message));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          resolve({
            elementText: result.text || '',
            sourceTexts: result.sourceTexts || (result.sourceText ? [result.sourceText] : []),
          });
        } catch {
          reject(new Error('Unstructured returned invalid output'));
        }
      },
    );

    child.stdin.on('error', reject);
    child.stdin.end(pdfBuffer);
  });
}

async function parseWithUnstructured(pdfBuffer) {
  try {
    console.info('[unstructured] extracting PDF locally...');
    const { elementText, sourceTexts } = await extractText(pdfBuffer);
    console.info(`[unstructured] extracted ${elementText.length} chars`);

    const candidates = [elementText, ...sourceTexts]
      .filter((text, index, texts) => text && texts.indexOf(text) === index)
      .map(text => parseSchoologyText(text));
    const result = candidates.reduce(
      (best, candidate) => isMoreComplete(candidate, best) ? candidate : best,
      candidates[0],
    );

    console.info(`[unstructured] parse candidates: ${candidates.map(candidate => {
      const score = resultScore(candidate);
      return `${score.graded}/${score.total}`;
    }).join(', ')} graded`);

    return { ...result, usedUnstructured: true };
  } catch (err) {
    console.error(`[unstructured] ${err.message}`);
    return {
      records: [], schoolYear: null, studentName: null,
      parseWarnings: [`Unstructured failed: ${err.message}`],
      usedUnstructured: false,
      error: err.message,
    };
  }
}

module.exports = { parseWithUnstructured };
