/**
 * ATLAS GPA — Schoology PDF Parser
 * Tuned to actual CSW Schoology grade export format.
 *
 * Input:  PDF buffer
 * Output: Array of normalized course records with Course Grade as the grade
 *
 * CHANGES vs previous version:
 *  - Course Grade / percentage are on SEPARATE lines in the actual PDF.
 *    Added `awaitingCourseGrade` flag to capture the grade from the next line.
 *  - Added "Drug and Alcohol" course → credits = 0, excluded from GPA.
 *  - Hardened non-phased header guard against section IDs like "G Period …".
 *  - WORLD HISTORY canonical override confirmed present.
 */

const pdfParse = require('pdf-parse');
const { buildExcludeList, isExcluded } = require('./gpaCalculator');

// ── Regexes calibrated to CSW Schoology PDF ──────────────────────────────────

/**
 * Matches a phased course header line.
 * Group 1: phase digit (3,4,5,6)
 * Group 2: course name (after phase dash, before colon)
 * Group 3: first token after colon (section/course id, may be non-numeric)
 *
 * Examples matched:
 *   "4-ENGLISH 2 : 8204 1 4-ENGLISH 2"
 *   "4-WORLD HISTORY : G Period 6204 1 4-WORLD HISTORY"
 *   "5-BIOLOGY : 7205 2 5-BIOLOGY PD D"
 *   "6-AP COMP SCI PRINCIPLES : AP CSP H"
 *   "5-INT.MATH-II : 9205 4 F"
 *   "5-FRENCH III  : 5315 2 5-FRENCH III C"
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
 *
 * Examples:
 *   "M1: 2025-08-25 - 2025-10-24 (20%)"
 *   "M2: 2025-10-25- 2026-01-16 (20%)"
 */
const MP_ROW = /^M([1-4]):\s+(\d{4})-\d{2}-\d{2}\s*-\s*(\d{4})-\d{2}-\d{2}/;

/**
 * Matches "Course Grade" on its OWN line (no grade value on the same line).
 * The actual percentage appears on the NEXT non-empty line in the CSW PDF.
 *
 * Also matches same-line variants as a fallback:
 *   "Course Grade 92%"  /  "Course Grade N/A"
 */
const COURSE_GRADE_STANDALONE = /^(?:Course\s+Grade|Year\s+Grade|Final\s+Average)\s*$/i;
const COURSE_GRADE_INLINE     = /^(?:Course\s+Grade|Year\s+Grade|Final\s+Average)[:\s]+([\d.]+%?|N\/A|-)\s*$/i;

/**
 * Matches a bare grade value line (produced after COURSE_GRADE_STANDALONE).
 *   "92%"  /  "98.48%"  /  "N/A"  /  "-"
 */
const BARE_GRADE = /^([\d.]+%?|N\/A|-)\s*$/i;

// Lines that are definitely not course headers
const SKIP_PATTERNS = [
  /^Grades\s*$/i,
  /^M\d:/,
  /^Midterm/i,
  /^Final/i,
  /^Course Grade/i,
  /^Year Grade/i,
  /^Final Average/i,
  /^\[.*\]/,
  /^Parent['']s Signature/i,
  /^Teacher['']s Signature/i,
  /^Student ID:/i,
  /^The Charter School/i,
  /^100 N DuPont/i,
  /^Wilmington/i,
  /^May \d+/i,
  /^June \d+/i,
  /^csw\.schoology\.com/i,
  /^https?:\/\//i,
  /^\d+\/\d+\/\d+,/,
  /^Excellence/i,
  /^Chem /i,
  /^\[BIO\]/i,
  /^Research Paper/i,
  /^MIDTERM/i,
  /^FINAL/i,
  /^Intermediate/i,
  /^Period \d/i,
  /^Quarter \d/i,
  /^Semester \d/i,
  /^Marking Period/i,
  /^\d{1,3}\.?\d*%\s*$/,   // bare percentage line  e.g. "92%", "98.48%"
  /^[A-F][+-]?\s*$/,        // bare letter grade
  /^N\/A\s*$/i,
  /^-\s*$/,                 // bare dash
];

// ── Canonical name map ────────────────────────────────────────────────────────
const CANONICAL_OVERRIDES = {
  'INT.MATH-I':               'Integrated Mathematics I',
  'INT.MATH-II':              'Integrated Mathematics II',
  'INT.MATH-III':             'Integrated Mathematics III',
  'INT MATH I':               'Integrated Mathematics I',
  'INT MATH II':              'Integrated Mathematics II',
  'INT MATH III':             'Integrated Mathematics III',
  'COMP SCI PRINCIPLES':      'Computer Science Principles',
  'AP COMP SCI PRINCIPLES':   'AP Computer Science Principles',
  'AP COMP SCI A':            'AP Computer Science A',
  'BIOLOGY':                  'Biology',
  'CHEMISTRY':                'Chemistry',
  'PHYSICS':                  'Physics',
  'FRENCH I':                 'French I',
  'FRENCH II':                'French II',
  'FRENCH III':               'French III',
  'FRENCH IV':                'French IV',
  'SPANISH I':                'Spanish I',
  'SPANISH II':               'Spanish II',
  'SPANISH III':              'Spanish III',
  'ENGLISH 1':                'English 1',
  'ENGLISH 2':                'English 2',
  'ENGLISH 3':                'English 3',
  'ENGLISH 4':                'English 4',
  'WORLD HISTORY':            'World History',
  'WORLD HIST':               'World History',
  'UNITED STATES HISTORY':    'United States History',
  'US HISTORY':               'United States History',
  'INTEGRATED SOCIAL SCIENCE':'Integrated Social Science',
  'INT SOCIAL SCIENCE':       'Integrated Social Science',
  'DRIVER ED':                'Driver Education',
  'DRIVERS ED':               'Driver Education',
  'ENV SCIENCE':              'Environmental Science',
  'AP ENV SCIENCE':           'AP Environmental Science',
  'AP FRENCH':                'AP French Language and Culture',
  'AP SPANISH':               'AP Spanish Language and Culture',
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
 * Assign credit weight based on course name.
 * Returns 0 for non-credit courses (homeroom, study hall, drug/alcohol, etc.)
 */
function assignCredits(rawName) {
  const n = rawName.toLowerCase();
  if (/drug|alcohol|homeroom|study.?hall|math.?lab/i.test(n))    return 0;
  if (/driver/i.test(n))                                          return 0.25;
  if (/health/i.test(n) && !/mental|public/i.test(n))            return 0.5;
  if (/physical.?education|^pe\s*\d/i.test(n))                   return 0.5;
  return 1.0;
}

// ── Main parser ───────────────────────────────────────────────────────────────

/**
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
    const data = await pdfParse(pdfBuffer, { pagerender: null });
    rawText = data.text || '';
  } catch (err) {
    warnings.push(`pdf-parse extraction failed: ${err.message}`);
    return { records: [], schoolYear: null, studentName: null, parseWarnings: warnings };
  }

  if (!rawText || rawText.trim().length < 100) {
    warnings.push('Very little text extracted — PDF may be image-only. Consider OCR.');
  }

  const lines       = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const excludeList = buildExcludeList();
  const records     = [];

  let studentName        = null;
  let schoolYear         = null;
  let currentCourse      = null;
  let mpStartYear        = null;
  let mpEndYear          = null;
  let awaitingCourseGrade = false;   // ← KEY FIX: grade is on the NEXT line

  // Extract student name from first 15 non-empty lines
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    if (/^[A-Z][a-z]+,\s+[A-Z]/.test(lines[i])) {
      studentName = lines[i];
      break;
    }
  }

  for (const line of lines) {
    if (!line || line.trim().length < 2) continue;
    const t = line.trim();

    // ── 1. Marking period date rows (always first) ───────────────────────────
    const mpMatch = t.match(/^M([1-4]):\s+(\d{4})-\d{2}-\d{2}\s*-\s*(\d{4})-\d{2}-\d{2}/);
    if (mpMatch) {
      const lineStartYear = mpMatch[2];
      const lineEndYear   = mpMatch[3];
      if (mpMatch[1] === '1') mpStartYear = lineStartYear;
      if (!mpEndYear || lineEndYear > mpEndYear) mpEndYear = lineEndYear;
      if (!schoolYear) schoolYear = deriveSchoolYear(mpStartYear, mpEndYear);
      awaitingCourseGrade = false;
      continue;
    }

    // ── 2a. "Course Grade" on its OWN line — set flag, grab grade next line ──
    //   Real CSW PDF format:
    //     "Course Grade"   ← this line
    //     "92%"            ← next line
    if (COURSE_GRADE_STANDALONE.test(t)) {
      if (currentCourse) awaitingCourseGrade = true;
      continue;
    }

    // ── 2b. Consume the bare grade line that follows "Course Grade" ──────────
    if (awaitingCourseGrade && currentCourse) {
      const gradeMatch = t.match(BARE_GRADE);
      if (gradeMatch) {
        awaitingCourseGrade = false;
        const raw        = gradeMatch[1].replace('%', '').trim();
        const finalGrade = (raw === 'N/A' || raw === '-' || raw === '') ? 'N/A' : raw;
        const { excluded, reason } = isExcluded(currentCourse.name, excludeList);
        records.push({
          canonicalName:   currentCourse.canonicalName,
          originalName:    currentCourse.name,
          courseId:        currentCourse.courseId || null,
          phase:           currentCourse.phase || null,
          credits:         currentCourse.credits,
          grade:           finalGrade,
          schoolYear:      deriveSchoolYear(mpStartYear, mpEndYear) || schoolYear,
          excludedFromGPA: excluded,
          exclusionReason: reason,
          isNA:            finalGrade === 'N/A',
        });
        currentCourse = null;
        continue;
      }
      // If next line wasn't a grade value, reset flag and fall through
      awaitingCourseGrade = false;
    }

    // ── 2c. Inline "Course Grade 92%" fallback (unlikely but safe) ───────────
    const cgInline = t.match(COURSE_GRADE_INLINE);
    if (cgInline && currentCourse) {
      const raw        = cgInline[1].replace('%', '').trim();
      const finalGrade = (raw === 'N/A' || raw === '-' || raw === '') ? 'N/A' : raw;
      const { excluded, reason } = isExcluded(currentCourse.name, excludeList);
      records.push({
        canonicalName:   currentCourse.canonicalName,
        originalName:    currentCourse.name,
        courseId:        currentCourse.courseId || null,
        phase:           currentCourse.phase || null,
        credits:         currentCourse.credits,
        grade:           finalGrade,
        schoolYear:      deriveSchoolYear(mpStartYear, mpEndYear) || schoolYear,
        excludedFromGPA: excluded,
        exclusionReason: reason,
        isNA:            finalGrade === 'N/A',
      });
      currentCourse = null;
      continue;
    }

    // ── 3. Apply skip patterns for non-course lines ───────────────────────────
    if (SKIP_PATTERNS.some(p => p.test(t))) continue;

    // ── 4. Phased course header: "5-BIOLOGY : 7205 2 …" ──────────────────────
    const phasedMatch = t.match(/^([3-6])-([^:]+?)\s*:\s*(\S+)/);
    if (phasedMatch) {
      const phase    = phasedMatch[1];
      const rawName  = phasedMatch[2].trim();
      const firstTok = phasedMatch[3];
      const canonical = canonicalizeName(rawName);
      currentCourse = {
        name:          rawName,
        canonicalName: canonical,
        phase,
        // Only store courseId if it looks like a numeric section id
        courseId:      /^\d{4}$/.test(firstTok) ? firstTok : null,
        credits:       assignCredits(rawName),
      };
      awaitingCourseGrade = false;
      continue;
    }

    // ── 5. Non-phased course header: "DRIVER ED : DRIVER ED - B MP3" ─────────
    if (t.includes(':') && !currentCourse) {
      const npMatch = t.match(/^([A-Za-z][^:]{1,60}?)\s*:\s*(\S+)/);
      if (npMatch) {
        const rawName   = npMatch[1].trim();
        const sectionId = npMatch[2];

        if (rawName.length < 3) continue;

        // Guard: skip lines whose pre-colon part looks like metadata
        if (/^(grades|course|student|school|parent|teacher|may |june |the |100 |https|year|final|quarter|semester|marking|period)/i.test(rawName)) continue;
        if (/^\d{1,2}[\/\-]\d{1,2}/.test(rawName)) continue;

        const canonical = canonicalizeName(rawName);
        currentCourse = {
          name:          rawName,
          canonicalName: canonical,
          phase:         null,
          courseId:      /^\d{4}$/.test(sectionId) ? sectionId : null,
          credits:       assignCredits(rawName),
        };
        awaitingCourseGrade = false;
      }
    }
  }

  // ── Deduplicate by canonicalName + grade + schoolYear ────────────────────
  const seen   = new Set();
  const deduped = records.filter(r => {
    const key = `${r.canonicalName}|${r.grade}|${r.schoolYear}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length === 0) {
    warnings.push(
      'No courses found in this document. ' +
      'This may not be a Schoology PDF, or the format has changed. ' +
      'You can close this dialog and add courses manually.'
    );
  }

  return {
    records:       deduped,
    schoolYear:    deriveSchoolYear(mpStartYear, mpEndYear),
    studentName,
    parseWarnings: warnings,
    rawLineCount:  lines.length,
  };
}

module.exports = { parseSchoologyPDF };