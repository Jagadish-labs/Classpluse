const http = require('http');
const assert = require('assert');

const BASE_URL = 'http://localhost:3000';

function postJson(path, payload, cookie = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const data = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    };
    if (cookie) headers['Cookie'] = cookie;

    const req = http.request(url, { method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let cookieVal = cookie;
        const setCookie = res.headers['set-cookie'];
        if (setCookie && setCookie.length > 0) {
          cookieVal = setCookie[0].split(';')[0];
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          cookie: cookieVal,
          json: body ? JSON.parse(body) : null
        });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(path, cookie = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const headers = {};
    if (cookie) headers['Cookie'] = cookie;

    http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          json: body ? JSON.parse(body) : null
        });
      });
    }).on('error', reject);
  });
}

// Client evaluation logic identical to public/app.js
function evaluateSlot(slot, dateStr, now) {
  const sDate = dateStr || slot.date_str;
  const startTime = new Date(`${sDate}T${slot.s}:00`);
  const endTime = new Date(`${sDate}T${slot.e}:00`);

  if (slot.st === 'cancelled') {
    return { type: 'cancelled', label: 'Cancelled', isGreen: false };
  }
  if (slot.st === 'absent') {
    return { type: 'absent', label: 'Absent', isGreen: false };
  }
  if (slot.st === 'delayed') {
    return { type: 'delayed', label: 'Delayed', isGreen: false };
  }
  if (slot.st === 'sub') {
    return { type: 'sub', label: 'Substitute', isGreen: false };
  }
  if (now >= endTime) {
    return { type: 'completed', label: '✓ Completed', isGreen: true };
  }
  if (now >= startTime && now < endTime) {
    return { type: 'live', label: '● Live Now', isGreen: false };
  }
  return { type: 'upcoming', label: '', isGreen: false };
}

async function runWeeklyTimetableTests() {
  console.log('🚀 Running Weekly Timetable & Calendar Verification Tests...\n');

  // Step 1: Login
  console.log('1. Logging in test users...');
  const adminLogin = await postJson('/api/auth/login', { uid: 'ADMIN001', passkey: 'admin123', role: 'ADMIN' });
  assert.strictEqual(adminLogin.status, 200, 'Admin login failed');

  const facRaoLogin = await postJson('/api/auth/login', { uid: 'FAC001', passkey: 'fac123', role: 'FACULTY' });
  assert.strictEqual(facRaoLogin.status, 200, 'Faculty Rao login failed');

  const facMeenaLogin = await postJson('/api/auth/login', { uid: 'FAC002', passkey: 'fac123', role: 'FACULTY' });
  assert.strictEqual(facMeenaLogin.status, 200, 'Faculty Meena login failed');

  const stuLogin = await postJson('/api/auth/login', { uid: 'STU001', passkey: 'stu123', role: 'STUDENT' });
  assert.strictEqual(stuLogin.status, 200, 'Student login failed');
  console.log('   ✅ All 4 test users logged in successfully');

  // Step 2: Reset Demo Data
  console.log('\n2. Resetting demo data...');
  const resetRes = await postJson('/api/admin/reset-demo', {}, adminLogin.cookie);
  assert.strictEqual(resetRes.status, 200);
  console.log('   ✅ Pristine seed data restored');

  // Step 3: Simulated Time Test 1 (Tuesday 11:30 AM)
  console.log('\n3. Testing Simulated Time 1: Tuesday 11:30 AM...');
  const sim1Res = await postJson('/api/timetable/simulated-time', { day: 2, time: '11:30' }, adminLogin.cookie);
  assert.strictEqual(sim1Res.status, 200);

  const week1 = await getJson('/api/timetable/weekly', stuLogin.cookie);
  assert.strictEqual(week1.status, 200);
  const now1 = new Date(week1.json.effectiveNow);
  console.log(`   Effective time: ${now1.toISOString()}`);

  // Mon slot 1 (09:00-09:50) -> passed yesterday -> must be completed
  const monSlot1 = week1.json.classes.find(c => c.day === 1 && c.id === 1);
  const evalMon1 = evaluateSlot(monSlot1, week1.json.weekDates[1], now1);
  assert.strictEqual(evalMon1.type, 'completed', 'Monday slot must be completed on Tuesday 11:30');
  assert.strictEqual(evalMon1.isGreen, true);

  // Tue slot 7 (09:00-09:50) -> passed today earlier -> must be completed
  const tueSlot7 = week1.json.classes.find(c => c.day === 2 && c.s === '09:00');
  const evalTue7 = evaluateSlot(tueSlot7, week1.json.weekDates[2], now1);
  assert.strictEqual(evalTue7.type, 'completed', 'Tuesday 09:00 slot must be completed at 11:30');
  assert.strictEqual(evalTue7.isGreen, true);

  // Tue slot 9 (10:55-11:45) -> currently in session -> must be live
  const tueSlot9 = week1.json.classes.find(c => c.day === 2 && c.s === '10:55');
  const evalTue9 = evaluateSlot(tueSlot9, week1.json.weekDates[2], now1);
  assert.strictEqual(evalTue9.type, 'live', 'Tuesday 10:55-11:45 slot must be live at 11:30');

  // Tue slot 10 (11:45-12:35) -> future -> must be upcoming
  const tueSlot10 = week1.json.classes.find(c => c.day === 2 && c.s === '11:45');
  const evalTue10 = evaluateSlot(tueSlot10, week1.json.weekDates[2], now1);
  assert.strictEqual(evalTue10.type, 'upcoming', 'Tuesday 11:45 slot must be upcoming at 11:30');
  console.log('   ✅ Simulated Time 1 marks verified (Monday completed, Tue morning completed, Tue 11:30 live, Tue afternoon upcoming)');

  // Step 4: Simulated Time Test 2 (Wednesday 14:30 PM)
  console.log('\n4. Testing Simulated Time 2: Wednesday 14:30 PM...');
  await postJson('/api/timetable/simulated-time', { day: 3, time: '14:30' }, adminLogin.cookie);
  const week2 = await getJson('/api/timetable/weekly', stuLogin.cookie);
  const now2 = new Date(week2.json.effectiveNow);

  // All Tue slots must be completed
  const tueSlots = week2.json.classes.filter(c => c.day === 2);
  for (const ts of tueSlots) {
    const ev = evaluateSlot(ts, week2.json.weekDates[2], now2);
    assert.strictEqual(ev.type, 'completed', `Tuesday slot ${ts.s} must be completed on Wednesday`);
  }

  // Wed slot at 14:20-15:10 must be live
  const wedSlotLive = week2.json.classes.find(c => c.day === 3 && c.s === '14:20');
  const evalWedLive = evaluateSlot(wedSlotLive, week2.json.weekDates[3], now2);
  assert.strictEqual(evalWedLive.type, 'live', 'Wed 14:20-15:10 must be live at 14:30');

  // Thu slot must be upcoming
  const thuSlot = week2.json.classes.find(c => c.day === 4 && c.s === '09:00');
  const evalThu = evaluateSlot(thuSlot, week2.json.weekDates[4], now2);
  assert.strictEqual(evalThu.type, 'upcoming', 'Thursday slot must be upcoming on Wednesday');
  console.log('   ✅ Simulated Time 2 marks verified (Tue all completed, Wed 14:30 live, Thu upcoming)');

  // Step 5: Simulated Time Test 3 (Saturday 16:00 PM)
  console.log('\n5. Testing Simulated Time 3: Saturday 16:00 PM...');
  await postJson('/api/timetable/simulated-time', { day: 6, time: '16:00' }, adminLogin.cookie);
  const week3 = await getJson('/api/timetable/weekly', stuLogin.cookie);
  const now3 = new Date(week3.json.effectiveNow);

  // All Sat slots must be completed
  const satSlots = week3.json.classes.filter(c => c.day === 6);
  for (const ss of satSlots) {
    const ev = evaluateSlot(ss, week3.json.weekDates[6], now3);
    assert.strictEqual(ev.type, 'completed', `Saturday slot ${ss.s} must be completed at 16:00`);
    assert.strictEqual(ev.isGreen, true);
  }
  console.log('   ✅ Simulated Time 3 marks verified (all Saturday slots completed at 16:00)');

  // Step 6: Test Cancelled / Absent classes are NEVER marked green
  console.log('\n6. Testing Cancelled & Absent classes are NEVER green...');
  // Let simulated time be Tuesday 11:30 AM
  await postJson('/api/timetable/simulated-time', { day: 2, time: '11:30' }, adminLogin.cookie);

  // Faculty Rao marks Monday class (id: 1) as cancelled
  const cancelRes = await postJson('/api/timetable/status', {
    timetableId: 1,
    st: 'cancelled',
    note: 'College holiday',
    date_str: week1.json.weekDates[1]
  }, facRaoLogin.cookie);
  assert.strictEqual(cancelRes.status, 200);

  // Faculty Rao marks Tuesday morning class (id: 7) as absent
  const absentRes = await postJson('/api/timetable/status', {
    timetableId: 7,
    st: 'absent',
    note: 'Sick leave',
    date_str: week1.json.weekDates[2]
  }, facRaoLogin.cookie);
  assert.strictEqual(absentRes.status, 200);

  // Fetch weekly timetable again
  const weekCheck = await getJson('/api/timetable/weekly', stuLogin.cookie);
  const checkNow = new Date(weekCheck.json.effectiveNow);

  const checkSlot1 = weekCheck.json.classes.find(c => c.id === 1);
  const evalCheck1 = evaluateSlot(checkSlot1, weekCheck.json.weekDates[1], checkNow);
  assert.strictEqual(evalCheck1.type, 'cancelled');
  assert.strictEqual(evalCheck1.isGreen, false, 'Cancelled class must NEVER be marked green even after end time!');

  const checkSlot7 = weekCheck.json.classes.find(c => c.id === 7);
  const evalCheck7 = evaluateSlot(checkSlot7, weekCheck.json.weekDates[2], checkNow);
  assert.strictEqual(evalCheck7.type, 'absent');
  assert.strictEqual(evalCheck7.isGreen, false, 'Absent class must NEVER be marked green even after end time!');
  console.log('   ✅ Cancelled and Absent classes correctly return non-green status marks even when time has passed');

  // Step 7: Student CANNOT change statuses (403)
  console.log('\n7. Testing Student cannot change statuses (HTTP 403)...');
  const stuAttempt = await postJson('/api/timetable/status', {
    timetableId: 2,
    st: 'delayed',
    note: 'Fake delay'
  }, stuLogin.cookie);
  assert.strictEqual(stuAttempt.status, 403, 'Student must receive 403 Forbidden on /api/timetable/status');
  console.log('   ✅ Student attempt blocked with HTTP 403 Forbidden');

  // Step 8: Faculty can ONLY change their own classes
  console.log('\n8. Testing Faculty can only change their own classes...');
  // Dr. Meena (FAC002) tries to change Prof. Rao\'s class (id: 1, faculty_id: FAC001)
  const meenaOnRao = await postJson('/api/timetable/status', {
    timetableId: 1,
    st: 'delayed',
    note: 'Unauthorized change'
  }, facMeenaLogin.cookie);
  assert.strictEqual(meenaOnRao.status, 403, 'Faculty modifying another faculty class must return 403');
  console.log('   ✅ Faculty attempt to modify another faculty class blocked with HTTP 403');

  // Dr. Meena changes her own class (id: 2, faculty_id: FAC002)
  const meenaOnOwn = await postJson('/api/timetable/status', {
    timetableId: 2,
    st: 'delayed',
    note: 'Traffic delay'
  }, facMeenaLogin.cookie);
  assert.strictEqual(meenaOnOwn.status, 200, 'Faculty must be able to change their own class');
  console.log('   ✅ Faculty successfully changed their own class (HTTP 200)');

  // Step 9: Faculty weekly view filters only their own classes
  console.log('\n9. Testing Faculty weekly timetable only returns their own classes...');
  const meenaWeek = await getJson('/api/timetable/weekly', facMeenaLogin.cookie);
  assert.strictEqual(meenaWeek.status, 200);
  for (const c of meenaWeek.json.classes) {
    assert.strictEqual(c.faculty_id, 'FAC002', 'Faculty weekly view must only contain classes for FAC002');
  }
  console.log(`   ✅ Dr. Meena weekly view returned only her ${meenaWeek.json.classes.length} assigned classes`);

  // Step 10: Clean reset at end
  console.log('\n10. Resetting demo data and verifying demo clock is cleared...');
  await postJson('/api/admin/reset-demo', {}, adminLogin.cookie);
  const finalState = await getJson('/api/timetable/today', stuLogin.cookie);
  assert.strictEqual(finalState.json.simulatedTime, null, 'Simulated time must be cleared after reset-demo');
  console.log('   ✅ Demo clock cleared and pristine state verified');

  console.log('\n===============================================================');
  console.log('🎉 ALL WEEKLY TIMETABLE VERIFICATION TESTS PASSED (100%)!');
  console.log('===============================================================\n');
}

runWeeklyTimetableTests().catch(err => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
