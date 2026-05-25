/**
 * ATLAS GPA — Report Card Import Routes
 *
 * POST /api/reportcards/upload         → parse Schoology PDF, return preview
 * POST /api/reportcards/import/confirm → confirm pending import
 * POST /api/reportcards/import/manual  → submit manual grades
 * GET  /api/reportcards                → list user's imports
 */

const express  = require('express');
const multer   = require('multer');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const router   = express.Router();
const { parseSchoologyPDF } = require('../utils/pdfParser');
const { calculateGPA }     = require('../utils/gpaCalculator');
const { authenticateJWT }  = require('../middleware/auth');
const { getDb }            = require('../db');

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename:    (req, file, cb) => {
      const safe = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${crypto.randomUUID()}_${safe}`);
    },
  }),
  limits:     { fileSize: parseInt(process.env.MAX_PDF_SIZE_MB || '10') * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype === 'application/pdf'
      ? cb(null, true)
      : cb(new Error('Only PDF files accepted')),
});

// POST /api/reportcards/upload
router.post('/api/reportcards/upload', authenticateJWT, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

    const pdfBuffer = fs.readFileSync(req.file.path);
    const { records, schoolYear, studentName, parseWarnings } = await parseSchoologyPDF(pdfBuffer);

    const gpaCourses = records
      .filter(r => !r.isNA && !r.excludedFromGPA)
      .map(r => ({ name: r.canonicalName, grade: r.grade, credits: r.credits, phase: r.phase, schoolYear: r.schoolYear }));

    const gpaPreview = calculateGPA(gpaCourses);

    const db       = getDb();
    const importId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO reportcard_imports
        (id, user_id, method, original_filename, original_filepath, parsed_records, school_year, status)
      VALUES (?, ?, 'pdf', ?, ?, ?, ?, 'pending')
    `).run(importId, req.userId, req.file.originalname, req.file.path,
           JSON.stringify(records), schoolYear || null);

    res.json({
      success:      true,
      previewId:    importId,
      importSource: 'pdf',
      schoolYear,
      studentName,
      parseWarnings,
      records,
      gpaPreview: {
        unweightedGPA: gpaPreview.unweightedGPA,
        weightedGPA:   gpaPreview.weightedGPA,
        totalCredits:  gpaPreview.totalCredits,
        courseCount:   gpaPreview.courseCount,
        excludedCount: records.filter(r => r.excludedFromGPA || r.isNA).length,
      },
    });
  } catch (err) {
    console.error('[reportcards/upload]', err.message);
    res.status(500).json({ error: 'PDF processing failed', detail: err.message });
  }
});

// POST /api/reportcards/import/confirm
router.post('/api/reportcards/import/confirm', authenticateJWT, (req, res) => {
  const { previewId, overrides } = req.body;
  if (!previewId) return res.status(400).json({ error: 'previewId required' });
  const db = getDb();
  const pending = db.prepare(
    'SELECT * FROM reportcard_imports WHERE id=? AND user_id=? AND status="pending"'
  ).get(previewId, req.userId);
  if (!pending) return res.status(404).json({ error: 'Pending import not found' });

  let records = JSON.parse(pending.parsed_records);
  if (overrides?.length) {
    records = records.map((r, i) => ({ ...r, ...(overrides[i] || {}) }));
  }
  db.prepare(`
    UPDATE reportcard_imports SET status='confirmed', parsed_records=?, updated_at=datetime('now') WHERE id=?
  `).run(JSON.stringify(records), previewId);
  res.json({ success: true, importId: previewId, recordCount: records.length });
});

// POST /api/reportcards/import/manual
router.post('/api/reportcards/import/manual', authenticateJWT, (req, res) => {
  const { courses, schoolYear } = req.body;
  if (!courses?.length) return res.status(400).json({ error: 'courses array required' });
  const db       = getDb();
  const importId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO reportcard_imports (id, user_id, method, parsed_records, school_year, status)
    VALUES (?, ?, 'manual', ?, ?, 'confirmed')
  `).run(importId, req.userId, JSON.stringify(courses), schoolYear || null);
  const gpa = calculateGPA(courses);
  res.json({ success: true, importId, importSource: 'manual', gpa });
});

// GET /api/reportcards
router.get('/api/reportcards', authenticateJWT, (req, res) => {
  const imports = getDb().prepare(`
    SELECT id, method, original_filename, school_year, status, created_at
    FROM reportcard_imports WHERE user_id=? ORDER BY created_at DESC
  `).all(req.userId);
  res.json({ imports });
});

module.exports = router;
