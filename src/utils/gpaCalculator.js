/**
 * ATLAS GPA — GPA Calculation Engine
 *
 * CSW Grading Scale (exact — no A+, no D+/D-):
 *   A   93-100  4.0
 *   A-  90-92   3.7
 *   B+  87-89   3.3
 *   B   83-86   3.0
 *   B-  80-82   2.7
 *   C+  77-79   2.3
 *   C   73-76   2.0
 *   C-  70-72   1.7
 *   D   66-69   1.0
 *   F   ≤65     0.0
 *
 * Phase weighting:
 *   Phase 3  +0.00
 *   Phase 4  +0.25
 *   Phase 5  +0.50
 *   Phase 6  +1.00
 *   null/non-phased  +0.00
 */

const CSW_SCALE = [
  { min: 93, max: 100, letter: 'A',  points: 4.0 },
  { min: 90, max: 92,  letter: 'A-', points: 3.7 },
  { min: 87, max: 89,  letter: 'B+', points: 3.3 },
  { min: 83, max: 86,  letter: 'B',  points: 3.0 },
  { min: 80, max: 82,  letter: 'B-', points: 2.7 },
  { min: 77, max: 79,  letter: 'C+', points: 2.3 },
  { min: 73, max: 76,  letter: 'C',  points: 2.0 },
  { min: 70, max: 72,  letter: 'C-', points: 1.7 },
  { min: 66, max: 69,  letter: 'D',  points: 1.0 },
  { min: 0,  max: 65,  letter: 'F',  points: 0.0 },
];

const LETTER_MAP = {
  'A': 4.0, 'A-': 3.7,
  'B+': 3.3, 'B': 3.0, 'B-': 2.7,
  'C+': 2.3, 'C': 2.0, 'C-': 1.7,
  'D': 1.0,
  'F': 0.0,
};

const PHASE_BONUS = {
  'none': 0, '': 0,
  '3': 0, '4': 0.25, '5': 0.50, '6': 1.00,
};

/**
 * Where phase bonuses are applied.
 * Finals, midterms, and marking period grades are components that feed INTO
 * the Course Grade percentage. The phase bonus (+0.25/+0.50/+1.00) is applied
 * exactly ONCE to the final Course Grade quality points. There is no
 * double-weighting of individual assessment components.
 */
const PHASE_BONUS_APPLIES_TO = 'course_grade_only';

/**
 * Build GPA exclusion list from env + hardcoded defaults.
 * Excludes: Driver Ed, Drug & Alcohol, Homeroom, Study Hall, N/A courses.
 */
function buildExcludeList() {
  const defaults = [
    'drivers ed', "driver's ed", 'drivers education', 'driver education',
    'driver ed', 'drug and alcohol', 'drug & alcohol',
    'drug and alcohol education', 'drug and alcohol awareness',
    'drug and alcohol course', 'homeroom', 'study hall',
  ];
  const envList = (process.env.EXCLUDE_COURSES || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...defaults, ...envList])];
}

function normalizeForExclusion(str) {
  return (str || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function isExcluded(courseName, excludeList) {
  const normalized = normalizeForExclusion(courseName);
  for (const pattern of excludeList) {
    if (normalized.includes(normalizeForExclusion(pattern))) {
      return { excluded: true, reason: `Matches exclusion: "${pattern}"` };
    }
  }
  return { excluded: false, reason: null };
}

function gradeToPoints(grade) {
  if (grade === null || grade === undefined)
    return { points: null, isPassFail: false, letter: null };

  const str = String(grade).trim().toUpperCase().replace(/%$/, '');

  // N/A or dash = no grade
  if (['N/A', 'NA', '-', ''].includes(str))
    return { points: null, isPassFail: true, letter: 'N/A' };

  // Pass/Fail markers
  if (['P', 'PASS', 'S', 'U', 'I', 'W'].includes(str))
    return { points: null, isPassFail: true, letter: str };

  // Letter grade
  if (Object.prototype.hasOwnProperty.call(LETTER_MAP, str))
    return { points: LETTER_MAP[str], isPassFail: false, letter: str };

  // Numeric grade (CSW uses percentages like 91%, 92, 98.48)
  const num = parseFloat(str);
  if (!isNaN(num)) {
    // CSW_SCALE is ordered highest→lowest with contiguous min thresholds
    // (F's min is 0), so the first row the score meets or exceeds is
    // correct even for decimal percentages that fall between the
    // integer bin boundaries (e.g. 72.5, 86.5, 92.5).
    const row = CSW_SCALE.find(r => num >= r.min);
    if (row) return { points: row.points, isPassFail: false, letter: row.letter };
    return { points: 0.0, isPassFail: false, letter: 'F' };
  }

  return { points: null, isPassFail: false, letter: null };
}

function getPhaseBonus(phase) {
  const key = String(phase ?? '').trim();
  return PHASE_BONUS[key] ?? 0;
}

/**
 * Calculate GPA from an array of course objects.
 *
 * CSW Phase Bonus rule:
 *   Finals, midterms, and marking period grades are components that feed
 *   INTO the Course Grade percentage. The phase bonus (Ph4 +0.25, Ph5 +0.50,
 *   Ph6 +1.00) is applied EXACTLY ONCE to the final Course Grade quality
 *   points. Individual assessment components (midterms, finals, MP grades)
 *   do NOT receive their own phase weighting — there is no double-weighting.
 *
 * @param {Array<{
 *   name: string,
 *   grade: string|number,
 *   credits: number,
 *   phase: string|null,
 *   schoolYear?: string
 * }>} courses
 * @param {{ excludeList?: string[] }} options
 * @returns {{
 *   unweightedGPA: number|null,
 *   weightedGPA: number|null,
 *   totalCredits: number,
 *   excludedCredits: number,
 *   allCredits: number,
 *   courseCount: number,
 *   includedCourses: Array,
 *   excludedCourses: Array
 * }}
 */
function calculateGPA(courses, options = {}) {
  const excludeList = options.excludeList || buildExcludeList();
  let uwSum = 0, wSum = 0, totalCredits = 0, excludedCredits = 0;
  const included = [], excluded = [];

  for (const course of courses) {
    const credits = parseFloat(course.credits) || 0;
    const { points, isPassFail, letter } = gradeToPoints(course.grade);
    const bonus = getPhaseBonus(course.phase);
    const { excluded: isExc, reason } = isExcluded(course.name, excludeList);

    if (isExc) { excluded.push({ ...course, exclusionReason: reason }); excludedCredits += credits; continue; }
    if (isPassFail || points === null) {
      excluded.push({ ...course, exclusionReason: isPassFail ? 'Pass/Fail or N/A' : 'Unrecognized grade' });
      continue;
    }
    if (credits === 0) {
      excluded.push({ ...course, exclusionReason: 'Zero credits' });
      continue;
    }

    uwSum += points * credits;
    wSum  += (points + bonus) * credits;
    totalCredits += credits;

    included.push({
      name: course.name, grade: course.grade, letterGrade: letter,
      credits, phase: course.phase || null,
      qualityPoints: points, phaseBonus: bonus, weightedPoints: points + bonus,
      uwContribution: points * credits, wContribution: (points + bonus) * credits,
      schoolYear: course.schoolYear || null,
    });
  }

  const round4 = n => Math.round(n * 10000) / 10000;
  return {
    unweightedGPA:   totalCredits > 0 ? round4(uwSum / totalCredits) : null,
    weightedGPA:     totalCredits > 0 ? round4(wSum  / totalCredits) : null,
    totalCredits,
    excludedCredits,
    allCredits:      totalCredits + excludedCredits,
    courseCount:     included.length,
    includedCourses: included,
    excludedCourses: excluded,
  };
}

module.exports = { calculateGPA, gradeToPoints, getPhaseBonus, isExcluded, buildExcludeList, PHASE_BONUS_APPLIES_TO };
