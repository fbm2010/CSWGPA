/**
 * ATLAS GPA — Ollama-based report card parser
 *
 * Extracts raw text from a PDF with pdf-parse, then sends it to a local
 * Ollama instance to extract structured course data.
 *
 * Falls back gracefully if Ollama is unavailable or returns bad JSON.
 *
 * Tuned for low-memory Codespaces (~8 GB RAM):
 *   - num_ctx  4096  — fits full prompt (~950 tokens) + full JSON response
 *   - num_predict 1200 — enough for 10-15 courses in pretty-printed JSON
 *   - prompt capped at MAX_PROMPT_CHARS to stay inside the context window
 *   - OLLAMA_TIMEOUT defaults to 45 s (not 90 s) so failures surface quickly
 */

const pdfParse = require('pdf-parse');
const http     = require('http');
const https    = require('https');

const OLLAMA_HOST     = process.env.OLLAMA_HOST     || 'http://127.0.0.1:11434';
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL    || 'qwen2.5:0.5b';
const OLLAMA_TIMEOUT  = parseInt(process.env.OLLAMA_TIMEOUT  || '120000');
const OLLAMA_NUM_CTX  = parseInt(process.env.OLLAMA_NUM_CTX  || '4096');
const OLLAMA_NUM_PRED = parseInt(process.env.OLLAMA_NUM_PRED || '1200');
// Hard cap on PDF text fed to the model — keeps the full prompt under num_ctx
const MAX_PROMPT_CHARS = parseInt(process.env.OLLAMA_MAX_CHARS || '3000');

// ── HTTP helper (avoids fetch/node-fetch version issues) ──────────────────────
function httpPost(urlStr, body) {
  return new Promise((resolve, reject) => {
    const url    = new URL(urlStr);
    const driver = url.protocol === 'https:' ? https : http;
    const data   = JSON.stringify(body);
    const req = driver.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout:  OLLAMA_TIMEOUT,
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Ollama HTTP ${res.statusCode}: ${buf.slice(0, 120)}`));
        } else {
          resolve(buf);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timed out')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    const url    = new URL(urlStr);
    const driver = url.protocol === 'https:' ? https : http;
    const req = driver.get({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      timeout:  4000,
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ── Ollama availability check ─────────────────────────────────────────────────
async function checkOllamaAvailable() {
  try {
    const { status, body } = await httpGet(`${OLLAMA_HOST}/api/tags`);
    if (status !== 200) return { available: false, hasModel: false, models: [], configuredModel: OLLAMA_MODEL };
    const data   = JSON.parse(body);
    const models = (data.models || []).map(m => m.name);
    const base   = OLLAMA_MODEL.split(':')[0];
    const hasModel = models.some(m => m === OLLAMA_MODEL || m.startsWith(base + ':') || m === base);
    return { available: true, hasModel, models, configuredModel: OLLAMA_MODEL };
  } catch (err) {
    return { available: false, hasModel: false, models: [], configuredModel: OLLAMA_MODEL, error: err.message };
  }
}

// ── Extraction prompt ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a precise data extractor for high school report cards.
Extract ALL courses from the report card text and return ONLY valid JSON, no explanation.

Required output format:
{
  "courses": [
    { "name": "English 2", "grade": "92", "credits": 1.0, "phase": "4" }
  ],
  "schoolYear": "2025-2026",
  "studentName": "Last, First"
}

Rules:
- name: full course name, properly capitalized (e.g. "English 2", "AP Chemistry")
- grade: use Course Grade or Final Average percentage as a plain number string like "92" or "88.5"; use "N/A" if not yet graded; letter grades like "B+" are also fine
- credits: 1.0 for standard courses; 0.25 for Driver Ed; 0.5 for Physical Education or Health; 0 for Homeroom, Study Hall, or Drug & Alcohol
- phase: the phase number as a string ("3","4","5","6") if the course has a prefix like "4-ENGLISH 2", else "none"
- Include ALL courses — Driver Ed, PE, Health, Homeroom, Study Hall — even if they are not graded
- schoolYear: "YYYY-YYYY" if detectable from dates in the document, otherwise null
- studentName: "Last, First" format if present, otherwise null
- Use ONLY the final Course Grade or Final Average as the grade value, not individual marking period grades
- Do not add any explanation, markdown, or extra text outside the JSON object`;

// ── Main Ollama parse function ────────────────────────────────────────────────
async function parseWithOllama(pdfBuffer) {
  const warnings = [];

  // 1. Extract raw text from PDF
  let rawText = '';
  try {
    const data = await pdfParse(pdfBuffer, { pagerender: null });
    rawText = data.text || '';
  } catch (err) {
    warnings.push(`PDF text extraction failed: ${err.message}`);
    return { records: [], schoolYear: null, studentName: null, parseWarnings: warnings, usedOllama: false };
  }

  if (!rawText || rawText.trim().length < 50) {
    warnings.push('Very little text found — PDF may be image-only or scanned. Try a different file.');
    return { records: [], schoolYear: null, studentName: null, parseWarnings: warnings, usedOllama: false };
  }

  // 2. Check Ollama
  const ollamaStatus = await checkOllamaAvailable();
  if (!ollamaStatus.available) {
    return {
      records: [], schoolYear: null, studentName: null,
      parseWarnings: warnings,
      usedOllama: false,
      ollamaUnavailable: true,
      rawText,
    };
  }

  // Pick best available model
  const modelToUse = ollamaStatus.hasModel
    ? OLLAMA_MODEL
    : (ollamaStatus.models[0] || OLLAMA_MODEL);

  if (!ollamaStatus.hasModel && ollamaStatus.models.length) {
    warnings.push(`Model ${OLLAMA_MODEL} not pulled. Using ${modelToUse}.`);
  } else if (!ollamaStatus.hasModel) {
    warnings.push(`Model ${OLLAMA_MODEL} not found — pull it with: ollama pull ${OLLAMA_MODEL}`);
    return { records: [], schoolYear: null, studentName: null, parseWarnings: warnings, usedOllama: false };
  }

  // 3. Send to Ollama — cap prompt to MAX_PROMPT_CHARS to stay within num_ctx
  const trimmed = rawText.length > MAX_PROMPT_CHARS
    ? rawText.slice(0, MAX_PROMPT_CHARS) + '\n[...truncated for memory safety]'
    : rawText;

  const fullPrompt = SYSTEM_PROMPT + '\n\nReport card text:\n' + trimmed;
  console.info(`[ollama] model=${modelToUse} ctx=${OLLAMA_NUM_CTX} predict=${OLLAMA_NUM_PRED} promptChars=${fullPrompt.length} timeout=${OLLAMA_TIMEOUT}ms`);

  let responseText = '';
  try {
    const raw = await httpPost(`${OLLAMA_HOST}/api/generate`, {
      model:   modelToUse,
      prompt:  fullPrompt,
      stream:  false,
      format:  'json',
      options: {
        temperature:  0,
        num_ctx:      OLLAMA_NUM_CTX,
        num_predict:  OLLAMA_NUM_PRED,
        // Aggressive memory knobs for Codespaces
        num_thread:   parseInt(process.env.OLLAMA_NUM_THREAD || '2'),
        low_vram:     true,
      },
    });
    const payload = JSON.parse(raw);
    responseText = payload.response || '';
    if (payload.done_reason === 'length') {
      warnings.push('AI response was cut off (hit token limit). Output may be incomplete — some courses may be missing.');
    }
    console.info(`[ollama] done=true eval_count=${payload.eval_count ?? '?'} total_duration=${payload.total_duration ?? '?'}`);
  } catch (err) {
    const detail = err.message || String(err);
    console.error(`[ollama] inference failed: ${detail}`);
    warnings.push(`AI extraction failed: ${detail}`);
    return {
      records: [], schoolYear: null, studentName: null,
      parseWarnings: warnings,
      usedOllama: false,
      rawText,
      ollamaError: detail,
    };
  }

  // 4. Parse JSON from model response
  let parsed;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
  } catch {
    warnings.push('AI returned unexpected output format. Try uploading again or enter courses manually.');
    return { records: [], schoolYear: null, studentName: null, parseWarnings: warnings, usedOllama: true };
  }

  const rawCourses = Array.isArray(parsed.courses) ? parsed.courses : [];
  if (!rawCourses.length) {
    warnings.push('AI could not find any courses in this document. You can close this and enter courses manually.');
    return { records: [], schoolYear: null, studentName: null, parseWarnings: warnings, usedOllama: true };
  }

  // 5. Normalise into the same record shape the rest of the app expects
  const EXCLUDED_PATTERNS = [
    /^driver.{0,2}ed/i, /^driver.{0,2}s.{0,2}ed/i,
    /^driver.{0,4}education/i, /^driver.{0,4}training/i,
    /^drug.{0,6}alcohol/i, /^alcohol.{0,5}awareness/i, /^drug.{0,5}awareness/i,
    /^homeroom$/i, /^home.?room$/i,
    /^study.?hall$/i,
    /^health$/i,
    /^physical.?education/i, /^pe\s*\d?$/i,
    /^math.?lab$/i, /^lab.?assistant$/i,
  ];

  function isCourseExcluded(name) {
    const n = (name || '').trim().toLowerCase();
    return EXCLUDED_PATTERNS.some(p => p.test(n));
  }

  const seen    = new Set();
  const records = [];

  for (const c of rawCourses) {
    const name = String(c.name || '').trim();
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const gradeRaw = String(c.grade ?? '').replace('%', '').trim();
    const isNA     = !gradeRaw || gradeRaw.toLowerCase() === 'n/a' || gradeRaw === 'null';
    const credits  = Math.max(0, parseFloat(c.credits) || 1.0);
    const phase    = String(c.phase ?? 'none').trim();
    const excluded = isCourseExcluded(name);

    records.push({
      canonicalName:   name,
      originalName:    name,
      courseId:        null,
      phase:           (!phase || phase === 'none') ? null : phase,
      credits,
      grade:           isNA ? 'N/A' : gradeRaw,
      schoolYear:      parsed.schoolYear || null,
      excludedFromGPA: excluded,
      exclusionReason: excluded ? 'excluded_course' : null,
      isNA,
    });
  }

  return {
    records,
    schoolYear:    parsed.schoolYear   || null,
    studentName:   parsed.studentName  || null,
    parseWarnings: warnings,
    usedOllama:    true,
    modelUsed:     modelToUse,
  };
}

module.exports = { parseWithOllama, checkOllamaAvailable };
