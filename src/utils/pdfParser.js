/**
 * ATLAS GPA — Schoology PDF Parser
 * Tuned to actual CSW Schoology grade export format.
 *
 * Input:  PDF buffer
 * Output: Array of normalized course records with Course Grade as the grade
 */

const pdfParse = require('pdf-parse');
const { buildExcludeList, isExcluded } = require('./gpaCalculator');

// ── Regexes calibrated to CSW Schoology PDF ──────────────────────────────────

/**
 * Matches a phased course header line.
 * Group 1: phase digit (3,4,5,6)
 * Group 2: course name (after phase dash, before colon)
 * Group 3: course ID (first token after colon)
 *
 * Examples matched:
 *   "4-ENGLISH 2 : 8204 1 4-ENGLISH 2"
 *   "5-BIOLOGY : 7205 2 5-BIOLOGY PD D"
 *   "6-AP COMP SCI PRINCIPLES : AP CSP H"
 *   "5-INT.MATH-II : 9205 4 F"
 *   "5-FRENCH III  : 5315 2 5-FRENCH III C"
 *   "5-CHEMISTRY : 7305 1 5-CHEMISTRY"
 */
const PHASED_HEADER = /^([3-6])-(.+?)\s*:\s*(\S+)/;

/**
 * Matches a non-phased course header.
 * Group 1: course name
 * Group 2: section identifier
 *
 * Examples:
 *   "DRIVER ED : DRIVER ED - B MP3"
 *   "Drug and Alcohol Course Level 2 : Section_1"
 *   "Homeroom : 9997 1 HOME ROOM-Thompson"
 *   "STUDY HALL : 9999 10 STUDY HALL"
 */
const NONPHASED_HEADER = /^([A-Za-z][^:]+?)\s*:\s*(\S+)/;

/**
 * Matches a marking period row to extract school year from dates.
 * Group 1: M period number
 * Group 2: start year (YYYY)
 * Group 3: end year (YYYY) from end date
 *
 * Examples:
 *   "M1: 2025-08-25 - 2025-10-24 (20%)"
 *   "M2: 2025-10-25- 2026-01-16 (20%)"
 */
const MP_ROW = /^M(\d):\s+(\d{4})-\d{2}-\d{2}\s*-\s*(\d{4})-\d{2}-\d{2}/;

/**
 * Matches the Course Grade row — this is the GPA-relevant grade.
 * Group 1: grade value (numeric percent or N/A)
 *
 * Examples:
 *   "Course Grade 92%"
 *   "Course Grade 99%"
 *   "Course Grade N/A"
 *   "Course Grade 98.48%"
 */
const COURSE_GRADE_ROW = /^Course Grade\s+([\d.]+%|N\/A|-)\s*$/i;

// Lines that are definitely not course headers
const SKIP_PATTERNS = [
  /^Grades\s*$/i,
  /^M\d:/,
  /^Midterm/i,
  /^Final/i,
  /^Course Grade/i,
  /^\[.*\]/,
  /^Parent['']s Signature/i,
  /^Teacher['']s Signature/i,
  /^Student ID:/i,
  /^The Charter School/i,
  /^100 N DuPont/i,
  /^Wilmington/i,
  /^May \d+/i,
  /^csw\.schoology\.com/i,
  /^https?:\/\//i,
  /^\d+\/\d+\/\d+,/,  // timestamp line
  /^Excellence/i,
  /^Chem /i,
  /^\[BIO\]/i,
  /^Research Paper/i,
  /^MIDTERM/i,
  /^FINAL/i,
  /^Intermediate/i,
];

/**
 * Human-readable course name cleaning.
 */
const CANONICAL_OVERRIDES = {
  'INT.MATH-I':   'Integrated Mathematics I',
  'INT.MATH-II':  'Integrated Mathematics II',
  'INT.MATH-III': 'Integrated Mathematics III',
  'INT MATH I':   'Integrated Mathematics I',
  'INT MATH II':  'Integrated Mathematics II',
  'INT MATH III': 'Integrated Mathematics III',
  'COMP SCI PRINCIPLES': 'Computer Science Principles',
  'AP COMP SCI PRINCIPLES': 'AP Computer Science Principles',
  'BIOLOGY':      'Biology',
  'CHEMISTRY':    'Chemistry',
  'PHYSICS':      'Physics',
  'FRENCH I':     'French I',
  'FRENCH II':    'French II',
  'FRENCH III':   'French III',
  'FRENCH IV':    'French IV',
  'SPANISH I':    'Spanish I',
  'SPANISH II':   'Spanish II',
  'SPANISH III':  'Spanish III',
  'ENGLISH 1':    'English 1',
  'ENGLISH 2':    'English 2',
  'ENGLISH 3':    'English 3',
  'ENGLISH 4':    'English 4',
  'WORLD HISTORY':        'World History',
  'UNITED STATES HISTORY':'United States History',
  'US HISTORY':           'United States History',
  'INTEGRATED SOCIAL SCIENCE': 'Integrated Social Science',
  'DRIVER ED':            'Driver Education',
  'DRIVERS ED':           'Driver Education',
  'AP COMP SCI A':        'AP Computer Science A',
  'INT SOCIAL SCIENCE':   'Integrated Social Science',
  'WORLD HIST':           'World History',
  'ENV SCIENCE':          'Environmental Science',
  'AP ENV SCIENCE':       'AP Environmental Science',
  'AP FRENCH':            'AP French Language and Culture',
  'AP SPANISH':           'AP Spanish Language and Culture',
};

function canonicalizeName(raw) {
  const upper = raw.toUpperCase().trim();
  if (CANONICAL_OVERRIDES[upper]) return CANONICAL_OVERRIDES[upper];
  return raw.trim().replace(/\b\w/g, c => c.toUpperCase()).replace(/\s+/g, ' ');
}

function deriveSchoolYear(startYear, endYear) {
  if (!startYear) return null;
  if (endYear && endYear !== startYear) return `${startYear}-${endYear}`;
  return startYear;
}

/**
 * Main parser entry point.
 *
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{
 *   records: Array,
 *   schoolYear: string|null,
 *   studentName: string|null,
 *   parseWarnings: string[]
 * }>}
 */
async function parseSchoologyPDF(pdfBuffer) {
  const warnings = [];
  let rawText = '';

  try {
    const data = await pdfParse(pdfBuffer, {
      pagerender: null,
    });
    rawText = data.text || '';
  } catch (err) {
    warnings.push(`pdf-parse extraction failed: ${err.message}`);
    return { records: [], schoolYear: null, studentName: null, parseWarnings: warnings };
  }

  if (!rawText || rawText.trim().length < 100) {
    warnings.push('Very little text extracted — PDF may be image-only. Consider OCR.');
  }

  const lines    = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const excludeList = buildExcludeList();
  const records  = [];

  let studentName  = null;
  let schoolYear   = null;
  let currentCourse = null;
  let mpStartYear  = null;
  let mpEndYear    = null;

  // Try to extract student name from first non-empty lines
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const line = lines[i];
    if (/^[A-Z][a-z]+,\s+[A-Z]/.test(line)) {
      studentName = line;
      break;
    }
  }

  for (const line of lines) {
    if (line.length < 4) continue;

    // ── Marking period row → extract school year dates (before SKIP_PATTERNS) ─
    const mpMatch = line.match(MP_ROW);
    if (mpMatch) {
      const mpNum    = parseInt(mpMatch[1]);
      const lineStart = mpMatch[2];
      const lineEnd   = mpMatch[3];
      if (mpNum === 1) mpStartYear = lineStart;
      if (mpEndYear === null || lineEnd > mpEndYear) mpEndYear = lineEnd;
      if (!schoolYear) schoolYear = deriveSchoolYear(mpStartYear, mpEndYear);
      continue;
    }

    // ── Course Grade row → finalize current course (before SKIP_PATTERNS) ───
    const cgMatch = line.match(COURSE_GRADE_ROW);
    if (cgMatch && currentCourse) {
      const rawGrade = cgMatch[1].replace('%', '');
      const finalGrade = rawGrade === 'N/A' || rawGrade === '-' ? 'N/A' : rawGrade;

      const { excluded, reason } = isExcluded(currentCourse.name, excludeList);

      records.push({
        canonicalName:    currentCourse.canonicalName,
        originalName:     currentCourse.name,
        courseId:         currentCourse.courseId || null,
        phase:            currentCourse.phase || null,
        credits:          currentCourse.credits,
        grade:            finalGrade,
        schoolYear:       deriveSchoolYear(mpStartYear, mpEndYear) || schoolYear,
        excludedFromGPA:  excluded,
        exclusionReason:  reason,
        isNA:             finalGrade === 'N/A',
      });

      currentCourse = null;
      continue;
    }

    // Skip non-course lines after handling MP and Course Grade rows above
    if (SKIP_PATTERNS.some(p => p.test(line))) continue;

    // ── Try phased course header ─────────────────────────────────────────────
    const phasedMatch = line.match(PHASED_HEADER);
    if (phasedMatch) {
      const phase      = phasedMatch[1];
      const rawName    = phasedMatch[2].trim();
      const courseId   = phasedMatch[3];
      const canonical  = canonicalizeName(rawName);

      const credits = courseId && /^\d{4}$/.test(courseId) ? 1.0 : 1.0;

      currentCourse = {
        name:          rawName,
        canonicalName: canonical,
        phase,
        courseId:      /^\d{4}$/.test(courseId) ? courseId : null,
        credits,
      };
      continue;
    }

    // ── Try non-phased course header ─────────────────────────────────────────
    if (line.includes(':') && !line.match(/^\d+%$/) && !currentCourse) {
      const npMatch = line.match(NONPHASED_HEADER);
      if (npMatch) {
        const rawName   = npMatch[1].trim();
        const sectionId = npMatch[2];
        const canonical = canonicalizeName(rawName);

        const looksLikeCourse = rawName.length > 2
          && !/^(Grades|Course|Student|School|Parent|Teacher|May |The |100 )/.test(rawName);

        if (looksLikeCourse) {
          let credits = 1.0;
          if (/driver/i.test(rawName)) credits = 0.25;
          if (/drug|alcohol|homeroom|study hall/i.test(rawName)) credits = 0;

          currentCourse = {
            name:          rawName,
            canonicalName: canonical,
            phase:         null,
            courseId:      /^\d{4}$/.test(sectionId) ? sectionId : null,
            credits,
          };
        }
      }
    }
  }

  // Deduplicate by canonicalName + schoolYear
  const seen  = new Set();
  const deduped = records.filter(r => {
    const key = `${r.canonicalName}|${r.grade}|${r.schoolYear}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length === 0) {
    warnings.push('No courses parsed. The PDF layout may have changed. Review rawText manually.');
  }

  return {
    records:       deduped,
    schoolYear:    deriveSchoolYear(mpStartYear, mpEndYear),
    studentName,
    parseWarnings: warnings,
  };
}

module.exports = { parseSchoologyPDF };
