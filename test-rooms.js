/**
 * test-rooms.js - Comprehensive test suite for room map pure logic.
 * Run with: node test-rooms.js
 */

const assert = require('assert');
const {
  getRoomStates,
  getLocalDateStr,
  getLocalTimeStr,
  DEFAULT_ROOMS,
  STATUS_LABELS
} = require('./rooms');

console.log('🧪 Starting Room Map Logic Test Suite...\n');

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${description}`);
    passed++;
  } catch (err) {
    console.error(`❌ FAIL: ${description}`);
    console.error(err);
    failed++;
  }
}

// Sample timetable for room testing
const sampleClassesToday = [
  {
    id: 1,
    day: 1,
    room: 'B-204',
    sub: 'Data Structures',
    fac: 'Prof. Rao',
    s: '09:00',
    e: '09:50',
    st: 'ongoing'
  },
  {
    id: 2,
    day: 1,
    room: 'B-204',
    sub: 'Advanced Algorithms',
    fac: 'Prof. Rao',
    s: '10:55',
    e: '11:45',
    st: 'ongoing'
  },
  {
    id: 3,
    day: 1,
    room: 'B-206',
    sub: 'Data Communications',
    fac: 'Dr. Meena',
    s: '09:00',
    e: '09:50',
    st: 'cancelled'
  },
  {
    id: 4,
    day: 1,
    room: 'B-206',
    sub: 'Wireless Networks',
    fac: 'Dr. Meena',
    s: '11:45',
    e: '12:35',
    st: 'ongoing'
  },
  {
    id: 5,
    day: 1,
    room: 'Design Lab',
    sub: 'UI/UX Workshop',
    fac: 'Ms. Kavya',
    s: '09:00',
    e: '10:00',
    st: 'sub',
    note: 'Covered by Prof. Rao'
  },
  {
    id: 6,
    day: 1,
    room: 'C-101',
    sub: 'Software Engineering',
    fac: 'Prof. Rao',
    s: '14:00',
    e: '15:00',
    st: 'absent'
  },
  {
    id: 7,
    day: 1,
    room: 'B-210',
    sub: 'Computer Networks',
    fac: 'Dr. Meena',
    s: '10:00',
    e: '11:00',
    st: 'resched'
  },
  {
    id: 8,
    day: 1,
    room: 'Lab 2',
    sub: 'Data Structures Lab',
    fac: 'Prof. Rao',
    s: '10:00',
    e: '11:00',
    st: 'delayed'
  },
  {
    id: 9,
    day: 1,
    room: 'Net Lab',
    sub: 'Special Seminar',
    fac: 'Guest Speaker',
    s: '10:00',
    e: '11:00',
    st: 'unknown_custom_code'
  }
];

// 1. Time between two classes
test('Case 1: Time between two classes in B-204 (10:10)', () => {
  const states = getRoomStates(sampleClassesToday, '10:10');
  const b204 = states['B-204'];
  assert.strictEqual(b204.status, 'free', 'Room should be free between classes');
  assert.strictEqual(b204.statusLabel, 'Free');
  assert.strictEqual(b204.currentClass, null, 'No class running right now');
  assert.ok(b204.nextClass, 'Next class should be present');
  assert.strictEqual(b204.nextClass.name, 'Advanced Algorithms');
  assert.strictEqual(b204.nextClass.start, '10:55');
  assert.strictEqual(b204.nextUseTime, '10:55');
});

// 2. Time before the first class
test('Case 2: Time before the first class in B-204 (08:30)', () => {
  const states = getRoomStates(sampleClassesToday, '08:30');
  const b204 = states['B-204'];
  assert.strictEqual(b204.status, 'free', 'Room should be free before first class');
  assert.strictEqual(b204.currentClass, null);
  assert.ok(b204.nextClass);
  assert.strictEqual(b204.nextClass.name, 'Data Structures');
  assert.strictEqual(b204.nextClass.start, '09:00');
  assert.strictEqual(b204.nextUseTime, '09:00');
});

// 3. Time after the last class
test('Case 3: Time after the last class in B-204 (12:00)', () => {
  const states = getRoomStates(sampleClassesToday, '12:00');
  const b204 = states['B-204'];
  assert.strictEqual(b204.status, 'free', 'Room should be free after last class');
  assert.strictEqual(b204.currentClass, null);
  assert.strictEqual(b204.nextClass, null, 'No more classes today');
  assert.strictEqual(b204.nextUseTime, null);
});

// 4. Class ends exactly at `now`
test('Case 4: Class ends exactly at now in B-204 (09:50)', () => {
  const states = getRoomStates(sampleClassesToday, '09:50');
  const b204 = states['B-204'];
  assert.strictEqual(b204.status, 'free', 'Room should be free once class reaches end time');
  assert.strictEqual(b204.currentClass, null, 'Finished class is no longer current');
  assert.ok(b204.nextClass);
  assert.strictEqual(b204.nextClass.start, '10:55');
});

// 5. Cancelled / Absent class running now
test('Case 5A: Cancelled class running now in B-206 (09:20)', () => {
  const states = getRoomStates(sampleClassesToday, '09:20');
  const b206 = states['B-206'];
  assert.strictEqual(b206.status, 'free-absent', 'Cancelled class running now should make room free-absent');
  assert.strictEqual(b206.statusLabel, 'Class Cancelled', 'Must display exact status label "Class Cancelled"');
  assert.ok(b206.currentClass);
  assert.strictEqual(b206.currentClass.name, 'Data Communications');
  assert.strictEqual(b206.currentClass.status, 'cancelled');
  assert.strictEqual(b206.nextUseTime, '11:45', 'Next used time should skip cancelled class');
});

test('Case 5B: Absent faculty class running now in C-101 (14:30)', () => {
  const states = getRoomStates(sampleClassesToday, '14:30');
  const c101 = states['C-101'];
  assert.strictEqual(c101.status, 'free-absent', 'Absent faculty class running now should make room free-absent');
  assert.strictEqual(c101.statusLabel, 'Faculty Absent', 'Must display exact label "Faculty Absent"');
  assert.ok(c101.currentClass);
  assert.strictEqual(c101.currentClass.name, 'Software Engineering');
  assert.strictEqual(c101.currentClass.status, 'absent');
});

test('Case 5C: Rescheduled class running now in B-210 (10:30)', () => {
  const states = getRoomStates(sampleClassesToday, '10:30');
  const b210 = states['B-210'];
  assert.strictEqual(b210.status, 'free-absent', 'Rescheduled slot is free-absent because room is empty');
  assert.strictEqual(b210.statusLabel, 'Rescheduled', 'Must display real label "Rescheduled", never "Faculty Absent"');
  assert.ok(b210.currentClass);
  assert.strictEqual(b210.currentClass.status, 'resched');
});

// 6. Delayed class running now
test('Case 6: Delayed class in Lab 2 (10:30)', () => {
  const states = getRoomStates(sampleClassesToday, '10:30');
  const lab2 = states['Lab 2'];
  assert.strictEqual(lab2.status, 'in-use', 'Delayed class stays in-use');
  assert.strictEqual(lab2.statusLabel, 'Faculty Delayed', 'Label must be "Faculty Delayed"');
  assert.ok(lab2.currentClass);
});

// 7. Unknown or missing status code
test('Case 7: Unknown/missing status code does not throw and falls back to in-use', () => {
  const states = getRoomStates(sampleClassesToday, '10:30');
  const netLab = states['Net Lab'];
  assert.doesNotThrow(() => {
    getRoomStates(sampleClassesToday, '10:30');
  });
  assert.strictEqual(netLab.status, 'in-use', 'Unknown status code falls back to in-use');
  assert.strictEqual(netLab.statusLabel, 'Class Ongoing', 'Unknown status gets neutral label');

  // Test missing status code (e.g. { room: 'Net Lab', s: '10:00', e: '11:00' })
  const statesNoSt = getRoomStates([{ room: 'Net Lab', s: '10:00', e: '11:00' }], '10:30');
  assert.strictEqual(statesNoSt['Net Lab'].status, 'in-use');
  assert.strictEqual(statesNoSt['Net Lab'].statusLabel, 'Class Ongoing');
});

// 8. Confirm exactly six canonical codes in STATUS_LABELS
test('Case 8: Verify exactly six canonical status codes in STATUS_LABELS', () => {
  const expectedCodes = ['ongoing', 'delayed', 'absent', 'sub', 'cancelled', 'resched'].sort();
  const actualCodes = Object.keys(STATUS_LABELS).sort();
  assert.deepStrictEqual(actualCodes, expectedCodes, 'rooms.js must use exactly the six expected status codes');
});

// 9. Substitute class running now
test('Case 9: Substitute class running now in Design Lab (09:30)', () => {
  const states = getRoomStates(sampleClassesToday, '09:30');
  const designLab = states['Design Lab'];
  assert.strictEqual(designLab.status, 'substitute', 'Substitute class should produce substitute status');
  assert.strictEqual(designLab.statusLabel, 'Substitute Assigned');
  assert.ok(designLab.currentClass);
  assert.strictEqual(designLab.currentClass.name, 'UI/UX Workshop');
  assert.strictEqual(designLab.currentClass.status, 'sub');
});

// 10. Active ongoing class running now
test('Case 10: Active ongoing class running now in B-204 (09:15)', () => {
  const states = getRoomStates(sampleClassesToday, '09:15');
  const b204 = states['B-204'];
  assert.strictEqual(b204.status, 'in-use', 'Active class should produce in-use status');
  assert.strictEqual(b204.statusLabel, 'Class Ongoing');
  assert.ok(b204.currentClass);
  assert.strictEqual(b204.currentClass.name, 'Data Structures');
  assert.strictEqual(b204.currentClass.start, '09:00');
  assert.strictEqual(b204.currentClass.end, '09:50');
  assert.strictEqual(b204.nextClass.start, '10:55');
});

// 11. Sunday / empty day - all seeded rooms are free
test('Case 11: Sunday or empty day with no classes', () => {
  const states = getRoomStates([], '10:00');
  assert.strictEqual(states.length, DEFAULT_ROOMS.length, 'All default rooms should be returned');
  for (const r of states) {
    assert.strictEqual(r.status, 'free', `Room ${r.room} must be free on empty day`);
    assert.strictEqual(r.statusLabel, 'Free');
    assert.strictEqual(r.currentClass, null);
    assert.strictEqual(r.nextClass, null);
    assert.strictEqual(r.nextUseTime, null);
  }
});

// 12. Local clock tests (Rule 2): 00:30 and 23:30 local time check
test('Case 12: Local clock formatting at 00:30 and 23:30 local time (never UTC/toISOString)', () => {
  // Construct explicit local dates
  const localDate1 = new Date(2026, 10, 4, 0, 30, 0); // Nov 4, 2026 00:30 local
  const timeStr1 = getLocalTimeStr(localDate1);
  const dateStr1 = getLocalDateStr(localDate1);

  assert.strictEqual(timeStr1, '00:30', 'Local time must format to 00:30');
  assert.strictEqual(dateStr1, '2026-11-04', 'Local date must format to 2026-11-04');

  const localDate2 = new Date(2026, 10, 4, 23, 30, 0); // Nov 4, 2026 23:30 local
  const timeStr2 = getLocalTimeStr(localDate2);
  const dateStr2 = getLocalDateStr(localDate2);

  assert.strictEqual(timeStr2, '23:30', 'Local time must format to 23:30');
  assert.strictEqual(dateStr2, '2026-11-04', 'Local date must format to 2026-11-04');

  // Verify getRoomStates accepts local Date directly
  const statesAtNight = getRoomStates(sampleClassesToday, localDate1);
  assert.strictEqual(statesAtNight['B-204'].status, 'free');
});

console.log(`\n================================`);
console.log(`Summary: ${passed} passed, ${failed} failed.`);
console.log(`================================\n`);

if (failed > 0) {
  process.exit(1);
}
