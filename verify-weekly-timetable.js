const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { db } = require('./db');

function createSession() {
  let cookie = '';

  async function request(method, reqPath, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(`http://localhost:3000${reqPath}`);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { 'Cookie': cookie } : {}),
          ...headers
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        if (res.headers['set-cookie']) {
          cookie = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
        }
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch(e) {}
          resolve({ status: res.statusCode, data, json, headers: res.headers });
        });
      });

      req.on('error', reject);
      if (body) {
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.end();
    });
  }

  return {
    get: (p, h) => request('GET', p, null, h),
    post: (p, b, h) => request('POST', p, b, h),
    delete: (p, h) => request('DELETE', p, null, h),
    clearCookie: () => { cookie = ''; }
  };
}

// Client status evaluation matching public/app.js
function evaluateSlotStatus(slot, dateStr, now) {
  if (!slot) return null;
  const sDate = dateStr || slot.date_str;
  const startTime = new Date(`${sDate}T${slot.s}:00`);
  const endTime = new Date(`${sDate}T${slot.e}:00`);

  const isCancelled = slot.st === 'cancelled';
  const isAbsent = slot.st === 'absent';
  const isDelayed = slot.st === 'delayed';
  const isSub = slot.st === 'sub';

  if (isCancelled) {
    return {
      type: 'cancelled',
      label: 'Cancelled',
      cssClass: 'status-cancelled',
      isGreen: false
    };
  }

  if (isAbsent) {
    return {
      type: 'absent',
      label: slot.note ? `Absent (${slot.note})` : 'Faculty Absent',
      cssClass: 'status-absent',
      isGreen: false
    };
  }

  if (now >= endTime) {
    return {
      type: 'completed',
      label: '✓ Completed',
      cssClass: 'status-completed',
      isGreen: true
    };
  }

  if (now >= startTime && now < endTime) {
    return {
      type: 'live',
      label: '● Live now',
      cssClass: 'status-live',
      isGreen: false
    };
  }

  return {
    type: 'upcoming',
    label: '',
    cssClass: 'status-upcoming',
    isGreen: false
  };
}

async function isServerRunning() {
  try {
    const res = await fetch('http://localhost:3000/api/config');
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function waitForServer(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    if (await isServerRunning()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 Starting Weekly Timetable & Calendar Verification Suite...');
  console.log('===============================================================\n');

  let serverProcess = null;
  const alreadyRunning = await isServerRunning();

  if (!alreadyRunning) {
    console.log('Starting ClassPulse server with DEMO=1...');
    serverProcess = spawn('node', ['server.js'], {
      cwd: __dirname,
      env: { ...process.env, DEMO: '1', PORT: '3000' },
      stdio: 'inherit'
    });
    const ready = await waitForServer();
    if (!ready) {
      throw new Error('Server failed to start within timeout');
    }
  }

  try {
    // Clean seed before starting test suite
    const adminSession = createSession();
    const adminLogin = await adminSession.post('/api/auth/login', { uid: 'ADMIN001', passkey: 'admin123' });
    assert.strictEqual(adminLogin.status, 200, 'Admin login failed');
    await adminSession.post('/api/admin/reset-demo', {});

    // 1. Database schema & migration checks
    console.log('1. Checking Database Schema & Timetable Migration...');
    const tableInfo = db.prepare("PRAGMA table_info(timetable)").all();
    const hasDayCol = tableInfo.some(c => c.name === 'day');
    assert(hasDayCol, 'Timetable table must contain "day" column');

    const slotCounts = db.prepare('SELECT day, COUNT(*) as count FROM timetable GROUP BY day ORDER BY day ASC').all();
    console.log('   Timetable slots distribution per day:', slotCounts);
    assert(slotCounts.length >= 6, 'Must have slots for Monday through Saturday');
    for (const sc of slotCounts) {
      assert(sc.count >= 4 && sc.count <= 6, `Day ${sc.day} should have 4 to 6 classes, found ${sc.count}`);
    }
    console.log('   ✅ 4 to 6 classes per day for CSE-A confirmed');

    // 2. Test Completed Marks at THREE Simulated Times
    console.log('\n2. Testing Completed Marks at THREE Simulated Times...');

    // --- Simulated Time 1: Tuesday 09:30 ---
    console.log('   ▶ Time 1: Tuesday 09:30 (during Period 1 09:00-09:50)');
    const setTime1 = await adminSession.post('/api/timetable/simulated-time', { day: 2, time: '09:30' });
    assert.strictEqual(setTime1.status, 200);

    const weekly1Res = await adminSession.get('/api/timetable/weekly');
    assert.strictEqual(weekly1Res.status, 200);
    const now1 = new Date(weekly1Res.json.effectiveNow);

    const monSlots1 = weekly1Res.json.classes.filter(c => c.day === 1);
    for (const s of monSlots1) {
      const evalRes = evaluateSlotStatus(s, weekly1Res.json.weekDates[1], now1);
      assert.strictEqual(evalRes.type, 'completed', `Monday slot ${s.sub} should be completed`);
      assert.strictEqual(evalRes.isGreen, true, 'Completed Monday slot must be green');
    }

    const tueSlots1 = weekly1Res.json.classes.filter(c => c.day === 2);
    const p1Tue = tueSlots1.find(c => c.s === '09:00');
    const evalP1Tue = evaluateSlotStatus(p1Tue, weekly1Res.json.weekDates[2], now1);
    assert.strictEqual(evalP1Tue.type, 'live', 'Tuesday 09:00 class at 09:30 should be Live now');
    assert.strictEqual(evalP1Tue.isGreen, false, 'Live class is pulsing outline, not green completed');

    const p2Tue = tueSlots1.find(c => c.s === '09:50');
    const evalP2Tue = evaluateSlotStatus(p2Tue, weekly1Res.json.weekDates[2], now1);
    assert.strictEqual(evalP2Tue.type, 'upcoming', 'Tuesday 09:50 class at 09:30 should be upcoming');
    assert.strictEqual(evalP2Tue.isGreen, false, 'Upcoming class must not be green');
    console.log('   ✅ Time 1 passed: Monday completed (green), Tuesday 09:00 Live, subsequent upcoming');

    // --- Simulated Time 2: Tuesday 12:00 ---
    console.log('   ▶ Time 2: Tuesday 12:00 (during Period 4 11:45-12:35)');
    const setTime2 = await adminSession.post('/api/timetable/simulated-time', { day: 2, time: '12:00' });
    assert.strictEqual(setTime2.status, 200);

    const weekly2Res = await adminSession.get('/api/timetable/weekly');
    const now2 = new Date(weekly2Res.json.effectiveNow);
    const tueSlots2 = weekly2Res.json.classes.filter(c => c.day === 2);

    const morningTueSlots = tueSlots2.filter(c => c.e <= '11:45');
    assert.strictEqual(morningTueSlots.length, 3, 'Must have 3 morning Tuesday slots');
    for (const s of morningTueSlots) {
      const evalRes = evaluateSlotStatus(s, weekly2Res.json.weekDates[2], now2);
      assert.strictEqual(evalRes.type, 'completed', `Tuesday slot ${s.s}-${s.e} should be completed`);
      assert.strictEqual(evalRes.isGreen, true, 'Passed class must be marked green completed');
    }

    const liveTueSlot = tueSlots2.find(c => c.s === '11:45');
    const evalLiveTue = evaluateSlotStatus(liveTueSlot, weekly2Res.json.weekDates[2], now2);
    assert.strictEqual(evalLiveTue.type, 'live', 'Tuesday 11:45-12:35 class at 12:00 should be Live now');

    const afternoonTueSlot = tueSlots2.find(c => c.s === '13:30');
    const evalAfternoon = evaluateSlotStatus(afternoonTueSlot, weekly2Res.json.weekDates[2], now2);
    assert.strictEqual(evalAfternoon.type, 'upcoming', 'Tuesday afternoon class at 12:00 should be upcoming');
    console.log('   ✅ Time 2 passed: Morning classes (09:00, 09:50, 10:55) completed, 11:45 Live, afternoon upcoming');

    // --- Simulated Time 3: Tuesday 16:00 ---
    console.log('   ▶ Time 3: Tuesday 16:00 (after all classes ended for Tuesday)');
    const setTime3 = await adminSession.post('/api/timetable/simulated-time', { day: 2, time: '16:00' });
    assert.strictEqual(setTime3.status, 200);

    const weekly3Res = await adminSession.get('/api/timetable/weekly');
    const now3 = new Date(weekly3Res.json.effectiveNow);
    const tueSlots3 = weekly3Res.json.classes.filter(c => c.day === 2);

    for (const s of tueSlots3) {
      const evalRes = evaluateSlotStatus(s, weekly3Res.json.weekDates[2], now3);
      assert.strictEqual(evalRes.type, 'completed', `Tuesday slot ${s.sub} at 16:00 must be completed`);
      assert.strictEqual(evalRes.isGreen, true, 'Completed slot must be green');
    }

    const wedSlots3 = weekly3Res.json.classes.filter(c => c.day === 3);
    for (const s of wedSlots3) {
      const evalRes = evaluateSlotStatus(s, weekly3Res.json.weekDates[3], now3);
      assert.strictEqual(evalRes.type, 'upcoming', `Wednesday slot ${s.sub} must be upcoming`);
      assert.strictEqual(evalRes.isGreen, false, 'Future day classes must not be marked completed');
    }
    console.log('   ✅ Time 3 passed: All Tuesday classes completed (green), future Wednesday classes upcoming');

    // 3. Test: Cancelled and Absent Classes are NEVER Green
    console.log('\n3. Testing: Cancelled and Absent Classes are NEVER Green...');
    // Slot 7 is Tuesday Period 1 (CS104, taught by Prof. Rao)
    // Slot 8 is Tuesday Period 2 (CS101, taught by Prof. Rao)
    const facSession = createSession();
    await facSession.post('/api/auth/login', { uid: 'FAC001', passkey: 'fac123' });

    const cancelRes = await facSession.post('/api/timetable/status', {
      timetableId: 7,
      st: 'cancelled',
      note: 'Guest Lecture conflict',
      date_str: weekly3Res.json.weekDates[2]
    });
    assert.strictEqual(cancelRes.status, 200);

    const absentRes = await facSession.post('/api/timetable/status', {
      timetableId: 8,
      st: 'absent',
      note: 'Conference',
      date_str: weekly3Res.json.weekDates[2]
    });
    assert.strictEqual(absentRes.status, 200);

    // Now re-fetch weekly timetable at Tuesday 16:00 (when all classes have ended)
    const weeklyCheckRes = await adminSession.get('/api/timetable/weekly');
    const slot7 = weeklyCheckRes.json.classes.find(c => c.id === 7);
    const slot8 = weeklyCheckRes.json.classes.find(c => c.id === 8);

    assert.strictEqual(slot7.st, 'cancelled', 'Slot 7 should be cancelled');
    assert.strictEqual(slot8.st, 'absent', 'Slot 8 should be absent');

    const evalSlot7 = evaluateSlotStatus(slot7, weeklyCheckRes.json.weekDates[2], now3);
    const evalSlot8 = evaluateSlotStatus(slot8, weeklyCheckRes.json.weekDates[2], now3);

    assert.strictEqual(evalSlot7.type, 'cancelled');
    assert.strictEqual(evalSlot7.isGreen, false, 'Cancelled class must NEVER be green');
    assert.strictEqual(evalSlot7.cssClass, 'status-cancelled');

    assert.strictEqual(evalSlot8.type, 'absent');
    assert.strictEqual(evalSlot8.isGreen, false, 'Absent class must NEVER be green');
    assert.strictEqual(evalSlot8.cssClass, 'status-absent');
    console.log('   ✅ Cancelled class has gray mark, Absent class has red mark; neither is EVER green!');

    // 4. Test: Student Cannot Change Statuses (403 Forbidden)
    console.log('\n4. Testing Student Authorization (403 Forbidden)...');
    const studentSession = createSession();
    const stuLogin = await studentSession.post('/api/auth/login', { uid: 'STU001', passkey: 'stu123' });
    assert.strictEqual(stuLogin.status, 200);

    const stuChangeRes = await studentSession.post('/api/timetable/status', {
      timetableId: 1,
      st: 'cancelled',
      note: 'Hacked by student'
    });
    assert.strictEqual(stuChangeRes.status, 403, 'Student must receive 403 when trying to change status');
    console.log('   ✅ Student received 403 Forbidden on POST /api/timetable/status');

    // 5. Test: Faculty Can ONLY Change Their Own Classes
    console.log('\n5. Testing Faculty Scope Restrictions...');
    // Prof. Rao (FAC001) owns CS101 and CS104 (slot 1, slot 4, etc.)
    // Slot 2 is CS102 (taught by FAC002 Dr. Meena)
    const slot2Obj = db.prepare('SELECT * FROM timetable WHERE id = 2').get();
    assert.strictEqual(slot2Obj.faculty_id, 'FAC002', 'Slot 2 must be owned by FAC002');

    const facUnauthorizedRes = await facSession.post('/api/timetable/status', {
      timetableId: 2,
      st: 'cancelled',
      note: 'Prof Rao cancelling Dr Meena class'
    });
    assert.strictEqual(facUnauthorizedRes.status, 403, 'Faculty updating another faculty class must receive 403');
    assert(facUnauthorizedRes.json.error.includes('only update your own class status'), 'Error message must state restriction');
    console.log('   ✅ Faculty attempting to update other faculty class receives 403 Forbidden');

    const facAuthorizedRes = await facSession.post('/api/timetable/status', {
      timetableId: 1,
      st: 'delayed',
      note: 'Traffic delay'
    });
    assert.strictEqual(facAuthorizedRes.status, 200, 'Faculty updating their own class must receive 200 OK');
    console.log('   ✅ Faculty successfully updated their own class');

    // 6. Test: Faculty Sees Only Their Own Classes in Timetable View
    console.log('\n6. Testing Faculty View Visibility Filtering...');
    const facWeekly = await facSession.get('/api/timetable/weekly');
    assert.strictEqual(facWeekly.status, 200);
    for (const c of facWeekly.json.classes) {
      assert.strictEqual(c.faculty_id, 'FAC001', 'Faculty timetable must contain only classes taught by FAC001');
    }
    const studentWeekly = await studentSession.get('/api/timetable/weekly');
    assert.strictEqual(studentWeekly.status, 200);
    assert(studentWeekly.json.classes.length > facWeekly.json.classes.length, 'Students see all course periods');
    console.log(`   ✅ Faculty sees only their own classes (${facWeekly.json.classes.length} periods); students see full timetable (${studentWeekly.json.classes.length} periods)`);

    // 7. Test: Live Status Per Date (Monday Absent Does NOT Carry Over to Next Monday)
    console.log('\n7. Testing Date Isolation (Absent on Monday does not carry over to next Monday)...');
    const mondaySlot = db.prepare('SELECT * FROM timetable WHERE day = 1 LIMIT 1').get();
    const mondayDate = '2026-10-12';
    const nextMondayDate = '2026-10-19';

    // Set absent on Monday 2026-10-12
    await adminSession.post('/api/timetable/status', {
      timetableId: mondaySlot.id,
      st: 'absent',
      note: 'Sick leave',
      date_str: mondayDate
    });

    const statusThisMon = db.prepare('SELECT * FROM daily_class_status WHERE slot_id = ? AND date_str = ?').get(mondaySlot.id, mondayDate);
    const statusNextMon = db.prepare('SELECT * FROM daily_class_status WHERE slot_id = ? AND date_str = ?').get(mondaySlot.id, nextMondayDate);

    assert(statusThisMon && statusThisMon.st === 'absent', 'Status for 2026-10-12 must be absent');
    assert(!statusNextMon, 'Status for next Monday 2026-10-19 must not have an absent record');
    console.log('   ✅ Monday absent record isolated to 2026-10-12; 2026-10-19 remains pristine "ongoing"');

    // 8. Test: Reset Demo Data Clears Simulated Clock & Daily Statuses
    console.log('\n8. Testing Reset Demo Data...');
    await adminSession.post('/api/timetable/simulated-time', { day: 3, time: '14:00' });
    const simBeforeReset = db.prepare('SELECT value FROM system_state WHERE key = ?').get('simulated_time');
    assert(simBeforeReset && simBeforeReset.value, 'Simulated time should be set before reset');

    const resetRes = await adminSession.post('/api/admin/reset-demo', {});
    assert.strictEqual(resetRes.status, 200);

    const simAfterReset = db.prepare('SELECT value FROM system_state WHERE key = ?').get('simulated_time');
    assert(!simAfterReset || !simAfterReset.value, 'Simulated time must be cleared after reset');

    const dailyStatusesAfterReset = db.prepare('SELECT count(*) as count FROM daily_class_status').get().count;
    assert.strictEqual(dailyStatusesAfterReset, 0, 'daily_class_status must be empty after reset');
    console.log('   ✅ Reset Demo Data restored pristine state and cleared simulated clock');

    console.log('\n===============================================================');
    console.log('🎉 ALL TIMETABLE & CALENDAR VERIFICATION TESTS PASSED (100%)!');
    console.log('===============================================================\n');

  } finally {
    if (serverProcess) {
      serverProcess.kill();
    }
  }
}

runTests().catch(err => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
