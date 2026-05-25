/**
 * PDF Parser tests using synthetic lines that match
 * the real CSW Schoology PDF format.
 */

const { parseSchoologyPDF } = require('../utils/pdfParser');

// Synthetic text matching real Schoology PDF format exactly
const SYNTHETIC_PDF_TEXT = `
Buddha, Dhanush Surya

4-ENGLISH 2 : 8204 1 4-ENGLISH 2
Grades
M1: 2025-08-25 - 2025-10-24 (20%) 91%
M2: 2025-10-25- 2026-01-16 (20%) 91%
M3: 2026-01-17 - 2026-03-27 (20%) 93%
M4: 2026-03-28 - 2026-06-05 (20%) 96%
Midterm (10%) 89%
Research Paper (10%) -
Course Grade 92%

5-BIOLOGY : 7205 2 5-BIOLOGY PD D
Grades
M1: 2025-08-25 - 2025-10-24 (20%) 97%
M2: 2025-10-25- 2026-01-16 (20%) 95%
M3: 2026-01-17 - 2026-03-27 (20%) 91%
M4: 2026-03-28 - 2026-06-05 (20%) 98%
[BIO] Midterm (10%) 76%
[BIO] Final Exam -- placeholder (10%) -
Course Grade 93%

6-AP COMP SCI PRINCIPLES : AP CSP H
Grades
M1: 2025-08-25 - 2025-10-24 (22.22%) 99%
M2: 2025-10-25- 2026-01-16 (22.22%) 100%
M3: 2026-01-17 - 2026-03-27 (22.22%) 98%
M4: 2026-03-28 - 2026-06-05 (22.22%) 100%
Course Grade 99%

DRIVER ED : DRIVER ED - B MP3
Grades
M3: 2026-01-17 - 2026-03-27 (100%) 84%
Course Grade 84%

Drug and Alcohol Course Level 2 : Section_1
Grades
M3: 2026-01-17 - 2026-03-27 (25%) 96.97%
M4: 2026-03-28 - 2026-06-05 (25%) 100%
Course Grade 98.48%

Homeroom : 9997 1 HOME ROOM-Thompson
Grades
M1: 2025-08-25 - 2025-10-24 (25%) -
Course Grade N/A

STUDY HALL : 9999 10 STUDY HALL
Grades
Course Grade N/A
`;

// Mock pdf-parse to return our synthetic text
jest.mock('pdf-parse', () => {
  return jest.fn().mockResolvedValue({ text: SYNTHETIC_PDF_TEXT });
});

describe('parseSchoologyPDF — real CSW format', () => {
  let result;
  beforeAll(async () => {
    result = await parseSchoologyPDF(Buffer.from('fake'));
  });

  test('extracts correct school year from M1 dates', () => {
    expect(result.schoolYear).toBe('2025-2026');
  });

  test('parses all courses', () => {
    expect(result.records.length).toBeGreaterThanOrEqual(7);
  });

  test('English 2 parsed with phase 4 and grade 92', () => {
    const eng = result.records.find(r => r.canonicalName.toLowerCase().includes('english'));
    expect(eng).toBeTruthy();
    expect(eng.phase).toBe('4');
    expect(eng.grade).toBe('92');
  });

  test('Biology parsed with phase 5 and grade 93', () => {
    const bio = result.records.find(r => r.canonicalName === 'Biology');
    expect(bio).toBeTruthy();
    expect(bio.phase).toBe('5');
    expect(bio.grade).toBe('93');
  });

  test('AP Comp Sci Principles parsed with phase 6 and grade 99', () => {
    const ap = result.records.find(r => r.canonicalName.toLowerCase().includes('computer science principles'));
    expect(ap).toBeTruthy();
    expect(ap.phase).toBe('6');
    expect(ap.grade).toBe('99');
  });

  test('Driver Ed marked as excluded', () => {
    const de = result.records.find(r => /driver/i.test(r.canonicalName));
    expect(de).toBeTruthy();
    expect(de.excludedFromGPA).toBe(true);
  });

  test('Drug and Alcohol marked as excluded', () => {
    const drug = result.records.find(r => /drug/i.test(r.canonicalName));
    expect(drug).toBeTruthy();
    expect(drug.excludedFromGPA).toBe(true);
  });

  test('Homeroom is N/A', () => {
    const hr = result.records.find(r => /homeroom/i.test(r.canonicalName));
    expect(hr).toBeTruthy();
    expect(hr.grade).toBe('N/A');
    expect(hr.isNA).toBe(true);
  });

  test('Study Hall is N/A', () => {
    const sh = result.records.find(r => /study hall/i.test(r.canonicalName));
    expect(sh).toBeTruthy();
    expect(sh.grade).toBe('N/A');
  });

  test('uses Course Grade (not M1/M2/Midterm) as the grade', () => {
    // English 2: M1=91, M2=91, M3=93, M4=96, Midterm=89 → Course Grade 92
    const eng = result.records.find(r => r.canonicalName.toLowerCase().includes('english'));
    expect(eng.grade).toBe('92');  // Must be Course Grade, not any individual MP
  });
});
