/**
 * test-wrapper.js - Test for getClassesForTargetDate wrapper against getFullTimetableState().classes
 */

const assert = require('assert');
const { getLocalDateStr } = require('./rooms');

// Load server dependencies
const { getFullTimetableState, getClassesForTargetDate } = require('./server');

console.log('🧪 Testing getClassesForTargetDate wrapper...\n');

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

// 1. Check for today (no argument)
test('Wrapper with no argument returns same classes as getFullTimetableState().classes', () => {
  const fullState = getFullTimetableState();
  const wrapperClasses = getClassesForTargetDate();

  assert.strictEqual(wrapperClasses.length, fullState.classes.length, 'Length must match');
  assert.deepStrictEqual(wrapperClasses, fullState.classes, 'Classes and effective statuses must match exactly');
});

// 2. Check for today (explicit todayStr)
test('Wrapper with explicit todayStr returns same classes as getFullTimetableState().classes', () => {
  const fullState = getFullTimetableState();
  const todayStr = getLocalDateStr(new Date(fullState.effectiveNow));
  const wrapperClasses = getClassesForTargetDate(todayStr);

  assert.strictEqual(wrapperClasses.length, fullState.classes.length, 'Length must match for todayStr');
  assert.deepStrictEqual(wrapperClasses, fullState.classes, 'Classes and statuses must match for todayStr');
});

// 3. Sunday returns empty array (Rule 3)
test('Wrapper returns empty array for Sunday', () => {
  // 2026-11-01 was a Sunday
  const sundayClasses = getClassesForTargetDate('2026-11-01');
  assert.strictEqual(Array.isArray(sundayClasses), true, 'Must return an array');
  assert.strictEqual(sundayClasses.length, 0, 'Sunday must have 0 classes');
});

console.log(`\n================================`);
console.log(`Summary: ${passed} passed, ${failed} failed.`);
console.log(`================================\n`);

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
