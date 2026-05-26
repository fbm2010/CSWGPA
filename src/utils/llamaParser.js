/**
 * ATLAS GPA — LlamaParse cloud PDF parser
 *
 * Uploads a PDF to LlamaParse, waits for the job, retrieves raw text,
 * then runs the same CSW-tuned regex parser over the result.
 *
 * Used as a fallback when local pdf-parse finds no courses (e.g. complex
 * or multi-column layouts where pdfjs struggles to order lines correctly).
 *
 * Requires LLAMAPARSE_API_KEY in the environment.
 */

const { parseSchoologyText } = require('./pdfParser');

const LLAMAPARSE_KEY     = process.env.LLAMAPARSE_API_KEY || '';
const LLAMAPARSE_BASE    = 'https://api.cloud.llamaindex.ai';
const POLL_INTERVAL_MS   = 2500;
const MAX_WAIT_MS        = parseInt(process.env.LLAMAPARSE_TIMEOUT || '60000');

async function uploadPDF(pdfBuffer) {
  const form = new FormData();
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  form.append('file', blob, 'report.pdf');

  const res = await fetch(`${LLAMAPARSE_BASE}/api/parsing/upload`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${LLAMAPARSE_KEY}` },
    body:    form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LlamaParse upload failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  if (!data.id) throw new Error('LlamaParse upload returned no job id');
  return data.id;
}

async function waitForJob(jobId) {
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const res = await fetch(`${LLAMAPARSE_BASE}/api/parsing/job/${jobId}`, {
      headers: { Authorization: `Bearer ${LLAMAPARSE_KEY}` },
    });
    const data = await res.json();

    if (data.status === 'SUCCESS') return;
    if (data.status === 'ERROR') throw new Error(`LlamaParse job error: ${data.error || 'unknown'}`);
  }

  throw new Error('LlamaParse job timed out');
}

async function getJobText(jobId) {
  const res = await fetch(`${LLAMAPARSE_BASE}/api/parsing/job/${jobId}/result/raw/text`, {
    headers: { Authorization: `Bearer ${LLAMAPARSE_KEY}` },
  });

  if (!res.ok) throw new Error(`LlamaParse text fetch failed (${res.status})`);

  // Response is either plain text or JSON {pages:[{text},...]}
  const body = await res.text();
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed.pages)) {
      return parsed.pages.map(p => p.text || '').join('\n');
    }
    return parsed.text || body;
  } catch {
    return body;
  }
}

async function parseWithLlamaParse(pdfBuffer) {
  if (!LLAMAPARSE_KEY) {
    return {
      records: [], schoolYear: null, studentName: null,
      parseWarnings: ['LLAMAPARSE_API_KEY not set'],
      usedLlamaParse: false,
      unavailable: true,
    };
  }

  try {
    console.info('[llamaparse] uploading PDF...');
    const jobId   = await uploadPDF(pdfBuffer);
    console.info(`[llamaparse] job=${jobId} polling...`);
    await waitForJob(jobId);
    const rawText = await getJobText(jobId);
    console.info(`[llamaparse] extracted ${rawText.length} chars`);

    const result = parseSchoologyText(rawText);
    return { ...result, usedLlamaParse: true };
  } catch (err) {
    console.error(`[llamaparse] ${err.message}`);
    return {
      records: [], schoolYear: null, studentName: null,
      parseWarnings: [`LlamaParse failed: ${err.message}`],
      usedLlamaParse: false,
      error: err.message,
    };
  }
}

module.exports = { parseWithLlamaParse };
