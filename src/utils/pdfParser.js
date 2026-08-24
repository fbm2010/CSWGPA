/**
 * ATLAS GPA — Schoology PDF Parser
 * Tuned to actual CSW Schoology grade export format.
 */

const path = require('path');
const pdfParse = require('pdf-parse');
const { buildExcludeList, isExcluded } = require('./gpaCalculator');

const CATALOG_PATH = path.join(__dirname, '../../data/courses_catalog.json');
let _catalogCreditsByName = null;
function catalogCredits(canonicalName) {
  if (!_catalogCreditsByName) {
    _catalogCreditsByName = new Map();
    try {
      const catalog = require(CATALOG_PATH);
      catalog.forEach(c => _catalogCreditsByName.set(c.canonical_name.toLowerCase(), c.credits));
    } catch { /* catalog is optional — fall back to name-pattern heuristics */ }
  }
  return _catalogCreditsByName.get((canonicalName || '').toLowerCase());
}

// ── Regexes calibrated to CSW Schoology PDF ──────────────────────────────────

const COURSE_GRADE_STANDALONE = /^(?:Course\s+Grade|Year\s+Grade|Final\s+Average)\s*$/i;
const COURSE_GRADE_INLINE     = /^(?:Course\s+Grade|Year\s+Grade|Final\s+Average)[:\s]+([\d.]+%?|N\/A|-)\s*$/i;
const BARE_GRADE              = /^([\d.]+%?|N\/A|-)\s*$/i;

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
  /^Charter Sch/i,
  /^100 N\.?\s*DuPont/i,
  /^Wilmington/i,
  /^\(\d{3}\)\d{3}-?\d{4}/,
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
  /^\d{1,3}\.?\d*%\s*$/,
  /^[A-F][+-]?\s*$/,
  /^N\/A\s*$/i,
  /^-\s*$/,
  // Marking Period Report Card cover page / attendance / comment lines
  /^Counselor:/i,
  /^Homeroom Teacher:/i,
  /^Generated on/i,
  /^\d+(st|nd|rd|th)\s+Honors\b/i,
  /^Attendance Summary/i,
  /^Absent\s+Tardy\s*$/i,
  /^Grade Report:/i,
  /^Course Task/i,
  /^Grade:\s*\d/i,
  /^Term \d+ Comments:/i,
];

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
  // Course headers in the PDF are ALL CAPS, so lowercase first — otherwise
  // \b\w only recases the already-uppercase word-initial letter and the
  // rest of the word is left shouting (e.g. "FINANCIAL LITERACY" unchanged).
  return raw.trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/\s+/g, ' ');
}

function deriveSchoolYear(startYear, endYear) {
  if (!startYear) return null;
  if (endYear && endYear !== startYear) return `${startYear}-${endYear}`;
  return startYear;
}

function assignCredits(rawName, canonicalName) {
  const fromCatalog = catalogCredits(canonicalName);
  if (fromCatalog !== undefined) return fromCatalog;
  const n = rawName.toLowerCase();
  if (/drug|alcohol|homeroom|study.?hall|math.?lab/i.test(n)) return 0;
  if (/driver/i.test(n))                                       return 0.25;
  if (/health/i.test(n) && !/mental|public/i.test(n))         return 0.5;
  if (/physical.?education|^pe\s*\d/i.test(n))                return 0.5;
  return 1.0;
}

// ── Core line-by-line parser (accepts raw text string) ───────────────────────

function parseSchoologyText(rawText) {
  const excludeList = buildExcludeList();
  const records     = [];
  const warnings    = [];

  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  let studentName         = null;
  let schoolYear          = null;
  let currentCourse       = null;
  let mpStartYear         = null;
  let mpEndYear           = null;
  let awaitingCourseGrade = false;

  function finishCurrentCourse(grade = 'N/A') {
    if (!currentCourse) return;

    const finalGrade = (grade === 'N/A' || grade === '-' || grade === '') ? 'N/A' : grade;
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
    awaitingCourseGrade = false;
  }

  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    // Require a lowercase-following first name (not just an initial) so
    // "City, ST 12345" address lines (e.g. "Wilmington, DE 19807") don't
    // get mistaken for "Last, First" — state abbreviations are all-caps.
    if (/^[A-Z][a-z]+,\s+[A-Z][a-z]/.test(lines[i])) {
      studentName = lines[i];
      break;
    }
  }

  for (const line of lines) {
    if (!line || line.trim().length < 2) continue;
    const t = line.trim();

    // 1. Marking period date rows
    const mpMatch = t.match(/^M([1-4]):\s+(\d{4})-\d{2}-\d{2}\s*-\s*(\d{4})-\d{2}-\d{2}/);
    if (mpMatch) {
      if (mpMatch[1] === '1') mpStartYear = mpMatch[2];
      if (!mpEndYear || mpMatch[3] > mpEndYear) mpEndYear = mpMatch[3];
      if (!schoolYear) schoolYear = deriveSchoolYear(mpStartYear, mpEndYear);
      awaitingCourseGrade = false;
      continue;
    }

    // 1b. Marking Period Report Card cover title: "2025 - 2026 1st Marking Period Report Card"
    const titleYearMatch = t.match(/^(\d{4})\s*-\s*(\d{4})\s+\S.*Marking Period Report Card/i);
    if (titleYearMatch) {
      mpStartYear = titleYearMatch[1];
      mpEndYear   = titleYearMatch[2];
      if (!schoolYear) schoolYear = deriveSchoolYear(mpStartYear, mpEndYear);
      continue;
    }

    // 2a. "Course Grade" alone on its own line
    if (COURSE_GRADE_STANDALONE.test(t)) {
      if (currentCourse) awaitingCourseGrade = true;
      continue;
    }

    // 2b. Bare grade line after standalone "Course Grade"
    if (awaitingCourseGrade && currentCourse) {
      const gradeMatch = t.match(BARE_GRADE);
      if (gradeMatch) {
        finishCurrentCourse(gradeMatch[1].replace('%', '').trim());
        continue;
      }
      awaitingCourseGrade = false;
    }

    // 2c. Inline "Course Grade 92%"
    const cgInline = t.match(COURSE_GRADE_INLINE);
    if (cgInline && currentCourse) {
      finishCurrentCourse(cgInline[1].replace('%', '').trim());
      continue;
    }

    // 3. Skip non-course lines
    if (SKIP_PATTERNS.some(p => p.test(t))) continue;

    // 3.5 Marking Period Report Card course row (interim/progress report format):
    // "4526-2 6-AP COMP SCI PRINCIPLES [Raab, Jonas] Marking Period 99"
    const mpRowMatch = t.match(
      /^(\d{3,6})-\d+\s+([3-6])-(.+?)\s+\[[^\]]+\]\s*Marking Period\s*([\d.]+%?|N\/A|-)\s*$/i
    );
    if (mpRowMatch) {
      finishCurrentCourse();
      const [, courseId, phase, rawNameRaw, gradeRaw] = mpRowMatch;
      const rawName   = rawNameRaw.trim();
      const canonical = canonicalizeName(rawName);
      currentCourse = {
        name:          rawName,
        canonicalName: canonical,
        phase,
        courseId,
        credits:       assignCredits(rawName, canonical),
      };
      finishCurrentCourse(gradeRaw.replace('%', '').trim());
      continue;
    }

    // 4. Phased course header: "5-BIOLOGY : 7205 2 …"
    const phasedMatch = t.match(/^([3-6])-([^:]+?)\s*:\s*(\S+)/);
    if (phasedMatch) {
      finishCurrentCourse();
      const rawName  = phasedMatch[2].trim();
      const firstTok = phasedMatch[3];
      const canonical = canonicalizeName(rawName);
      currentCourse = {
        name:          rawName,
        canonicalName: canonical,
        phase:         phasedMatch[1],
        courseId:      /^\d{4}$/.test(firstTok) ? firstTok : null,
        credits:       assignCredits(rawName, canonical),
      };
      awaitingCourseGrade = false;
      continue;
    }

    // 5. Non-phased course header: "DRIVER ED : DRIVER ED - B MP3"
    if (t.includes(':')) {
      const npMatch = t.match(/^([A-Za-z][^:]{1,60}?)\s*:\s*(\S+)/);
      if (npMatch) {
        const rawName   = npMatch[1].trim();
        const sectionId = npMatch[2];
        if (rawName.length < 3) continue;
        if (/^(grades|course|student|school|parent|teacher|may |june |the |100 |https|year|final|quarter|semester|marking|period)/i.test(rawName)) continue;
        if (/^\d{1,2}[\/\-]\d{1,2}/.test(rawName)) continue;
        // Assignment titles also contain colons. Non-phased course headers in
        // this report format use a numeric/Section_* id, except for the known
        // special schedule courses whose section labels repeat their names.
        const knownSpecialCourse = /^(driver(?:s)? ed|drug and alcohol|homeroom|study hall)\b/i.test(rawName);
        if (!/^\d{4}$/.test(sectionId) && !/^Section_/i.test(sectionId) && !knownSpecialCourse) continue;
        finishCurrentCourse();
        const canonical = canonicalizeName(rawName);
        currentCourse = {
          name:          rawName,
          canonicalName: canonical,
          phase:         null,
          courseId:      /^\d{4}$/.test(sectionId) ? sectionId : null,
          credits:       assignCredits(rawName, canonical),
        };
        awaitingCourseGrade = false;
      }
    }
  }

  // A schedule entry can legitimately have no reported course grade yet.
  finishCurrentCourse();

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

// ── PDF buffer entry point ────────────────────────────────────────────────────

async function parseSchoologyPDF(pdfBuffer) {
  let rawText = '';
  const warnings = [];

  try {
    const data = await pdfParse(pdfBuffer, { pagerender: null });
    rawText = data.text || '';
  } catch (err) {
    warnings.push(`pdf-parse extraction failed: ${err.message}`);
    return { records: [], schoolYear: null, studentName: null, parseWarnings: warnings };
  }

  if (!rawText || rawText.trim().length < 100) {
    warnings.push('Very little text extracted — PDF may be image-only.');
  }

  const result = parseSchoologyText(rawText);
  return {
    ...result,
    parseWarnings: [...warnings, ...(result.parseWarnings || [])],
  };
}

module.exports = { parseSchoologyPDF, parseSchoologyText };
