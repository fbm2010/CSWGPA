const { parseSchoologyText } = require('../utils/pdfParser');

describe('parseSchoologyText — CSW Schoology PDF format', () => {
  test('parses a phased course header with grade on the following line', () => {
    const text = [
      'Smith, Jordan',
      'M1: 2025-08-25 - 2025-10-24 (20%)',
      '4-ENGLISH 2 : 8204 1 4-ENGLISH 2',
      'Course Grade',
      '92%',
    ].join('\n');

    const result = parseSchoologyText(text);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      canonicalName: 'English 2',
      phase: '4',
      credits: 1,
      grade: '92',
      excludedFromGPA: false,
      isNA: false,
    });
    expect(result.studentName).toBe('Smith, Jordan');
  });

  test('derives a "YYYY-YYYY" school year from marking period date rows', () => {
    const text = [
      'M1: 2025-08-25 - 2025-10-24 (20%)',
      'M2: 2025-10-25 - 2026-01-16 (20%)',
      '5-BIOLOGY : 7205 2 5-BIOLOGY PD D',
      'Course Grade',
      '93%',
    ].join('\n');

    const result = parseSchoologyText(text);
    expect(result.schoolYear).toBe('2025-2026');
    expect(result.records[0].schoolYear).toBe('2025-2026');
  });

  test('flags a non-phased excluded course (Driver Ed) with 0.25 credits and no GPA impact', () => {
    const text = [
      'DRIVER ED : DRIVER ED - B MP3',
      'Course Grade',
      '84%',
    ].join('\n');

    const result = parseSchoologyText(text);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      canonicalName: 'Driver Education',
      credits: 0.25,
      excludedFromGPA: true,
    });
  });

  test('marks a course with no grade yet as N/A', () => {
    const text = [
      '6-AP COMP SCI PRINCIPLES : AP CSP H',
      'Course Grade',
      'N/A',
    ].join('\n');

    const result = parseSchoologyText(text);
    expect(result.records[0]).toMatchObject({
      canonicalName: 'AP Computer Science Principles',
      phase: '6',
      grade: 'N/A',
      isNA: true,
    });
  });

  test('retains every scheduled course when only some have grades', () => {
    const text = [
      '4-ENGLISH 2 : 8204 1 4-ENGLISH 2',
      'Course Grade',
      '92%',
      '5-BIOLOGY : 7205 2 5-BIOLOGY',
      'Course Grade',
      '93%',
      '6-AP COMP SCI PRINCIPLES : 6500 1 AP CSP',
      'Course Grade',
      '95%',
      '4-WORLD HISTORY : 8300 1 WORLD HISTORY',
      '5-FRENCH III : 5315 2 FRENCH III',
      'DRIVER ED : DRIVER ED - B MP3',
    ].join('\n');

    const result = parseSchoologyText(text);
    expect(result.records).toHaveLength(6);
    expect(result.records.map(record => record.grade)).toEqual([
      '92', '93', '95', 'N/A', 'N/A', 'N/A',
    ]);
    expect(result.records.slice(3).every(record => record.isNA)).toBe(true);
  });

  test('does not treat a colon in an assignment title as a new course', () => {
    const text = [
      '5-SPANISH II : 5205 3 5-SPANISH II PD D',
      'Grades',
      'MTE 24-25 Spanish II: Interpersonal Reading & Listening',
      '94.64%',
      'Course Grade 95%',
    ].join('\n');

    const result = parseSchoologyText(text);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      canonicalName: 'Spanish II',
      grade: '95',
    });
  });

  test('title-cases a course with no canonical override (not left ALL CAPS)', () => {
    const text = [
      'FINANCIAL LITERACY : 1234 1 FINANCIAL LITERACY',
      'Course Grade',
      '90%',
    ].join('\n');

    const result = parseSchoologyText(text);
    expect(result.records[0].canonicalName).toBe('Financial Literacy');
  });

  test('deduplicates identical records', () => {
    const text = [
      '5-FRENCH III  : 5315 2 5-FRENCH III C',
      'Course Grade',
      '88%',
      '5-FRENCH III  : 5315 2 5-FRENCH III C',
      'Course Grade',
      '88%',
    ].join('\n');

    const result = parseSchoologyText(text);
    expect(result.records).toHaveLength(1);
  });

  test('returns a warning and no records when nothing matches', () => {
    const result = parseSchoologyText('Nothing useful in this document.');
    expect(result.records).toHaveLength(0);
    expect(result.parseWarnings.length).toBeGreaterThan(0);
  });
});

describe('parseSchoologyText — CSW "Marking Period Report Card" interim format', () => {
  const text = [
    'Charter Sch of Wilm',
    '100 N. Dupont Rd.',
    'Wilmington, DE 19807',
    '(302)651-2727',
    '',
    'Buddha, Surya D',
    '2025 - 2026 1st Marking Period Report Card',
    'Grade: 10 Student ID: 150081',
    'Counselor: Taylor, Aleya',
    'Homeroom Teacher: M.Thompson',
    'Generated on 05/24/2026 07:19:30 PM',
    '',
    '2nd Honors Honor Roll',
    'Attendance Summary By Term:',
    'M1',
    '',
    'Absent Tardy',
    '1 2',
    '',
    'Grade Report:',
    'Course Task M1',
    '4526-2 6-AP COMP SCI PRINCIPLES [Raab, Jonas] Marking Period 99',
    '5315-2 5-FRENCH III [M.Antal] Marking Period 88',
    'Term 1 Comments:Demonstrates insufficient effort. Needs to accept responsibility. Needs to participate in class.',
    '6204-1 4-WORLD HISTORY [R.Stella] Marking Period 93',
    '7205-2 5-BIOLOGY [M.Guenther] Marking Period 97',
    '7305-1 5-CHEMISTRY [J.Costanza] Marking Period 89',
    'Term 1 Comments:Demonstrates outstanding effort. Demonstrates leadership. Makes good use of time.',
    '8204-1 4-ENGLISH 2 [A.DiMaio] Marking Period 91',
    '9205-4 5-INT.MATH-II [C.Zhao] Marking Period 82',
    'Term 1 Comments:Participates in class. Demonstrates inconsistent effort.',
  ].join('\n');

  test('extracts every course with correct grade, phase, and canonical name', () => {
    const result = parseSchoologyText(text);
    expect(result.records).toHaveLength(7);
    expect(result.records.map(r => [r.canonicalName, r.phase, r.grade])).toEqual([
      ['AP Computer Science Principles', '6', '99'],
      ['French III',                    '5', '88'],
      ['World History',                 '4', '93'],
      ['Biology',                       '5', '97'],
      ['Chemistry',                     '5', '89'],
      ['English 2',                     '4', '91'],
      ['Integrated Mathematics II',     '5', '82'],
    ]);
  });

  test('does not fabricate a course from the "Homeroom Teacher:" cover line', () => {
    const result = parseSchoologyText(text);
    expect(result.records.some(r => /homeroom/i.test(r.canonicalName))).toBe(false);
  });

  test('derives student name and school year from the cover page', () => {
    const result = parseSchoologyText(text);
    expect(result.studentName).toBe('Buddha, Surya D');
    expect(result.schoolYear).toBe('2025-2026');
  });
});

describe('parseSchoologyText — "Marking Period Report Card" with collapsed table whitespace', () => {
  // pdf-parse extraction of the real PDF drops the whitespace between adjacent
  // table cells that have no gap in the underlying layout, e.g.
  // "[Raab, Jonas]Marking Period99" instead of "[Raab, Jonas] Marking Period 99".
  const text = [
    'Buddha, Surya D',
    '2025 - 2026 1st Marking Period Report Card',
    'Grade: 10    Student ID: 150081',
    'Grade Report:',
    'CourseTaskM1',
    '4526-2 6-AP COMP SCI PRINCIPLES [Raab, Jonas]Marking Period99',
    '5315-2 5-FRENCH III [M.Antal]Marking Period88',
    'Term 1 Comments:Demonstrates insufficient effort.',
    '9205-4 5-INT.MATH-II [C.Zhao]Marking Period82',
  ].join('\n');

  test('extracts every course despite the missing whitespace around "Marking Period"', () => {
    const result = parseSchoologyText(text);
    expect(result.records.map(r => [r.canonicalName, r.phase, r.grade])).toEqual([
      ['AP Computer Science Principles', '6', '99'],
      ['French III',                    '5', '88'],
      ['Integrated Mathematics II',     '5', '82'],
    ]);
  });
});
