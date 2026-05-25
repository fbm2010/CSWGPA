const { calculateGPA, gradeToPoints, isExcluded, buildExcludeList } = require('../utils/gpaCalculator');

describe('CSW grade scale (no A+, no D+/D-)', () => {
  test('A=4.0, A-=3.7', () => {
    expect(gradeToPoints('A').points).toBe(4.0);
    expect(gradeToPoints('A-').points).toBe(3.7);
  });
  test('A+ is not a valid CSW grade', () => {
    expect(gradeToPoints('A+').points).toBeNull();
  });
  test('D=1.0, D+ and D- are not valid', () => {
    expect(gradeToPoints('D').points).toBe(1.0);
    expect(gradeToPoints('D+').points).toBeNull();
    expect(gradeToPoints('D-').points).toBeNull();
  });
  test('numeric percentages from Schoology PDF', () => {
    expect(gradeToPoints('92%').points).toBe(3.7);   // A- (90-92)
    expect(gradeToPoints('93%').points).toBe(4.0);   // A (93-100)
    expect(gradeToPoints('99%').points).toBe(4.0);   // A
    expect(gradeToPoints('88%').points).toBe(3.3);   // B+
    expect(gradeToPoints('87%').points).toBe(3.3);   // B+
    expect(gradeToPoints('90%').points).toBe(3.7);   // A-
  });
  test('N/A grade = pass/fail exclusion', () => {
    expect(gradeToPoints('N/A').isPassFail).toBe(true);
    expect(gradeToPoints('N/A').points).toBeNull();
  });
  test('98.48% (Drug and Alcohol style)', () => {
    expect(gradeToPoints('98.48%').points).toBe(4.0);
  });
});

describe('GPA exclusion list', () => {
  const list = buildExcludeList();

  test('Driver Education excluded', () => {
    expect(isExcluded('DRIVER ED', list).excluded).toBe(true);
    expect(isExcluded("Driver's Ed", list).excluded).toBe(true);
    expect(isExcluded('Driver Education', list).excluded).toBe(true);
  });
  test('Drug and Alcohol excluded', () => {
    expect(isExcluded('Drug and Alcohol Course Level 2', list).excluded).toBe(true);
    expect(isExcluded('Drug and Alcohol Education', list).excluded).toBe(true);
    expect(isExcluded('DRUG AND ALCOHOL', list).excluded).toBe(true);
  });
  test('Homeroom excluded', () => {
    expect(isExcluded('Homeroom', list).excluded).toBe(true);
    expect(isExcluded('HOMEROOM', list).excluded).toBe(true);
  });
  test('Study Hall excluded', () => {
    expect(isExcluded('Study Hall', list).excluded).toBe(true);
    expect(isExcluded('STUDY HALL', list).excluded).toBe(true);
  });
  test('real CSW courses not excluded', () => {
    expect(isExcluded('AP Computer Science Principles', list).excluded).toBe(false);
    expect(isExcluded('Biology', list).excluded).toBe(false);
    expect(isExcluded('World History', list).excluded).toBe(false);
    expect(isExcluded('French III', list).excluded).toBe(false);
    expect(isExcluded('Integrated Mathematics II', list).excluded).toBe(false);
  });
});

describe('GPA calculation — real PDF data', () => {
  // Real courses from the uploaded PDF:
  // English 2 (Ph4):        92%
  // World History (Ph4):    93%
  // Biology (Ph5):          93%
  // Chemistry (Ph5):        90%
  // French III (Ph5):       88%
  // Int. Math II (Ph5):     87%
  // AP Comp Sci Prin (Ph6): 99%
  const realCourses = [
    { name: 'English 2',              grade: '92', credits: 1.0, phase: '4' },
    { name: 'World History',          grade: '93', credits: 1.0, phase: '4' },
    { name: 'Biology',                grade: '93', credits: 1.0, phase: '5' },
    { name: 'Chemistry',              grade: '90', credits: 1.0, phase: '5' },
    { name: 'French III',             grade: '88', credits: 1.0, phase: '5' },
    { name: 'Integrated Mathematics II', grade: '87', credits: 1.0, phase: '5' },
    { name: 'AP Computer Science Principles', grade: '99', credits: 1.0, phase: '6' },
  ];

  test('calculates correct unweighted GPA', () => {
    const result = calculateGPA(realCourses);
    // 92→3.7(A-), 93→4.0(A), 93→4.0, 90→3.7, 88→3.3(B+), 87→3.3, 99→4.0
    // UW = (3.7+4.0+4.0+3.7+3.3+3.3+4.0)/7 = 26.0/7 ≈ 3.714
    expect(result.unweightedGPA).toBeCloseTo(3.714, 2);
    expect(result.courseCount).toBe(7);
    expect(result.totalCredits).toBe(7.0);
  });

  test('calculates correct weighted GPA with phase bonuses', () => {
    const result = calculateGPA(realCourses);
    // Phase bonuses: Ph4=+0.25, Ph5=+0.50, Ph6=+1.00
    // English2(Ph4):   3.7+0.25=3.95
    // WorldHist(Ph4):  4.0+0.25=4.25
    // Biology(Ph5):    4.0+0.50=4.50
    // Chemistry(Ph5):  3.7+0.50=4.20
    // FrenchIII(Ph5):  3.3+0.50=3.80
    // IntMathII(Ph5):  3.3+0.50=3.80
    // APCSP(Ph6):      4.0+1.00=5.00
    // W = (3.95+4.25+4.50+4.20+3.80+3.80+5.00)/7 = 29.5/7 ≈ 4.214
    expect(result.weightedGPA).toBeCloseTo(4.214, 2);
  });

  test('excludes Driver Ed, Drug & Alcohol, Homeroom, Study Hall from GPA', () => {
    const withExcluded = [
      ...realCourses,
      { name: 'DRIVER ED',                  grade: '84', credits: 0.25, phase: null },
      { name: 'Drug and Alcohol Course Level 2', grade: '98.48', credits: 0, phase: null },
      { name: 'Homeroom',                   grade: 'N/A', credits: 0, phase: null },
      { name: 'STUDY HALL',                 grade: 'N/A', credits: 0, phase: null },
    ];
    const result = calculateGPA(withExcluded);
    expect(result.courseCount).toBe(7);      // Only the 7 academic courses
    expect(result.totalCredits).toBe(7.0);
    expect(result.excludedCourses).toHaveLength(4);
  });
});
