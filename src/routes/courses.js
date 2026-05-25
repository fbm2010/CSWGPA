/**
 * ATLAS GPA — Course Autocomplete
 *
 * GET  /api/courses/autocomplete?q=&limit=
 * GET  /api/courses/lookup?id=
 * POST /api/courses/normalize
 */

const express = require('express');
const Fuse    = require('fuse.js');
const router  = express.Router();
const { getDb } = require('../db');
const { isExcluded, buildExcludeList } = require('../utils/gpaCalculator');

let _cache = null;
let _fuse  = null;

function getCatalog() {
  if (!_cache) _cache = getDb().prepare('SELECT * FROM courses_catalog').all();
  return _cache;
}
function getFuse() {
  if (!_fuse) {
    _fuse = new Fuse(getCatalog(), {
      keys:              ['display_name', 'canonical_name', 'course_id'],
      threshold:         parseFloat(process.env.FUSE_THRESHOLD || '0.35'),
      includeScore:      true,
      ignoreLocation:    true,
      minMatchCharLength: 2,
    });
  }
  return _fuse;
}
function fmt(item) {
  return {
    courseId:          item.course_id,
    displayName:       item.display_name,
    canonicalName:     item.canonical_name,
    credits:           item.credits,
    defaultGradeScale: item.default_grade_scale,
    category:          item.category,
    department:        item.department,
    phase:             item.phase,
    excludedFromGPA:   item.excluded_from_gpa === 1,
  };
}

router.get('/api/courses/autocomplete', (req, res) => {
  const q     = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit || process.env.AUTOCOMPLETE_LIMIT || '10'), 25);
  if (q.length < 2) return res.json({ results: [], query: q });
  const results = getFuse().search(q, { limit }).map(({ item }) => fmt(item));
  res.json({ results, query: q });
});

router.get('/api/courses/lookup', (req, res) => {
  const id   = (req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id required' });
  const item = getDb().prepare('SELECT * FROM courses_catalog WHERE course_id=?').get(id);
  if (!item) return res.status(404).json({ error: 'Course not found' });
  res.json(fmt(item));
});

router.post('/api/courses/normalize', (req, res) => {
  const { rawName } = req.body;
  if (!rawName) return res.status(400).json({ error: 'rawName required' });

  let phase = null;
  let name  = rawName.trim();
  const phaseMatch = name.match(/^([3-6])-(.+)$/);
  if (phaseMatch) { phase = phaseMatch[1]; name = phaseMatch[2].trim(); }

  const { excluded, reason } = isExcluded(name, buildExcludeList());
  const matches = getFuse().search(name, { limit: 1 });
  const match   = matches[0]?.item || null;

  res.json({
    originalName:    rawName,
    canonicalName:   name,
    detectedPhase:   phase,
    excludedFromGPA: excluded,
    exclusionReason: reason,
    catalogMatch:    match ? fmt(match) : null,
  });
});

module.exports = { router, invalidateCache: () => { _cache = null; _fuse = null; } };
