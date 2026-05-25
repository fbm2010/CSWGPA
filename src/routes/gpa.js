/**
 * ATLAS GPA — GPA Calculation Routes
 *
 * POST /api/gpa/calculate   → calculate from courses array or school years
 * POST /api/gpa/what-if     → simulate adding one course
 */

const express = require('express');
const router  = express.Router();
const { calculateGPA, buildExcludeList } = require('../utils/gpaCalculator');

/**
 * Flatten input into flat course array.
 * Accepts:
 *   { schoolYears: [{ year, courses }] }   ← new format
 *   { courses: [...] }                      ← flat format
 *   { markingPeriods: [...] }               ← legacy (still accepted, MP info ignored)
 */
function flattenInput(body) {
  if (body.schoolYears?.length)
    return body.schoolYears.flatMap(sy =>
      (sy.courses || []).map(c => ({ ...c, schoolYear: c.schoolYear || sy.year || sy.name }))
    );
  if (body.markingPeriods?.length)
    return body.markingPeriods.flatMap(mp =>
      (mp.courses || []).map(c => ({ ...c, schoolYear: c.schoolYear || mp.year || null }))
    );
  return body.courses || [];
}

router.post('/api/gpa/calculate', (req, res) => {
  try {
    const courses = flattenInput(req.body);
    if (!courses.length) return res.status(400).json({ error: 'No courses provided' });
    const result = calculateGPA(courses, { excludeList: buildExcludeList() });
    res.json({ success: true, ...result, calculatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[gpa/calculate]', err.message);
    res.status(500).json({ error: 'Calculation failed', detail: err.message });
  }
});

router.post('/api/gpa/what-if', (req, res) => {
  try {
    const { existingCourses, proposedCourse } = req.body;
    if (!existingCourses || !proposedCourse)
      return res.status(400).json({ error: 'existingCourses and proposedCourse required' });
    const before = calculateGPA(existingCourses);
    const after  = calculateGPA([...existingCourses, proposedCourse]);
    const delta  = (a, b) => a !== null && b !== null
      ? Math.round((a - b) * 10000) / 10000 : null;
    res.json({
      success: true,
      before:  { unweightedGPA: before.unweightedGPA, weightedGPA: before.weightedGPA, totalCredits: before.totalCredits },
      after:   { unweightedGPA: after.unweightedGPA,  weightedGPA: after.weightedGPA,  totalCredits: after.totalCredits  },
      impact:  {
        unweightedDelta: delta(after.unweightedGPA, before.unweightedGPA),
        weightedDelta:   delta(after.weightedGPA,   before.weightedGPA),
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'What-if failed', detail: err.message });
  }
});

router.post('/api/gpa/report', (req, res) => {
  try {
    const courses = flattenInput(req.body);
    if (!courses.length) return res.status(400).json({ error: 'No courses provided' });
    const result = calculateGPA(courses, { excludeList: buildExcludeList() });
    const date = new Date().toISOString().split('T')[0];
    const lines = [
      'ATLAS GPA — CSW Export',
      '─'.repeat(38),
      `Generated: ${new Date().toLocaleString()}`,
      `Unweighted GPA: ${result.unweightedGPA != null ? result.unweightedGPA.toFixed(2) : '—'}`,
      `Weighted GPA:   ${result.weightedGPA   != null ? result.weightedGPA.toFixed(2)   : '—'}`,
      `Total Credits:  ${result.totalCredits}`,
      `Course Count:   ${result.courseCount}`,
      '',
      '── Included Courses ──',
    ];
    result.includedCourses.forEach(c => {
      lines.push(`  ${(c.name||'Unnamed').padEnd(32)} ${String(c.grade).padEnd(6)} ${(c.phase||'—').padEnd(6)} ${c.qualityPoints.toFixed(1)} pts`);
    });
    if (result.excludedCourses.length) {
      lines.push('', '── Excluded from GPA ──');
      result.excludedCourses.forEach(c => {
        lines.push(`  ${(c.name||'Unnamed').padEnd(32)} ${c.exclusionReason||''}`);
      });
    }
    const text = lines.join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ATLAS_GPA_Report_${date}.txt"`);
    res.send(text);
  } catch (err) {
    console.error('[gpa/report]', err.message);
    res.status(500).json({ error: 'Report generation failed', detail: err.message });
  }
});

module.exports = router;
