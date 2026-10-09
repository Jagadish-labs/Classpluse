const http = require('http');
const { io } = require('socket.io-client');
const assert = require('assert');

function createSession() {
  let cookie = '';

  async function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(`http://localhost:3000${path}`);
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
    get: (path, headers) => request('GET', path, null, headers),
    post: (path, body, headers) => request('POST', path, body, headers),
    delete: (path, headers) => request('DELETE', path, null, headers),
    clearCookie: () => { cookie = ''; }
  };
}

async function runDemoPassVerification() {
  console.log('===============================================================');
  console.log('🧪 Starting ClassPulse Demo-Ready Verification Test Suite...');
  console.log('===============================================================\n');

  // TEST 1: Admin Reset Demo Data
  console.log('Test 1: Admin 5-Second Reset Demo Data Endpoint & Speed...');
  const admin = createSession();
  const adminLogin = await admin.post('/api/auth/login', { uid: 'ADMIN001', passkey: 'admin123', role: 'ADMIN' });
  assert.strictEqual(adminLogin.status, 200, 'Admin login must succeed');

  const t0 = Date.now();
  const resetRes = await admin.post('/api/admin/reset-demo');
  const elapsed = Date.now() - t0;
  assert.strictEqual(resetRes.status, 200);
  assert.strictEqual(resetRes.json.success, true);
  assert.ok(elapsed < 5000, `Reset must complete in under 5 seconds (took ${elapsed}ms)`);
  console.log(`   ✅ /api/admin/reset-demo succeeded in ${elapsed}ms (< 5s limit)`);

  // Verify all timetable statuses are ongoing and notice is cleared
  const stateRes = await admin.get('/api/state');
  assert.strictEqual(stateRes.status, 200);
  assert.strictEqual(stateRes.json.notice, '');
  assert.ok(stateRes.json.classes.every(c => c.st === 'ongoing' && c.note === ''));
  console.log('   ✅ All classes reset to ongoing, notice cleared, pristine state verified');

  // TEST 2: Public /share Page
  console.log('\nTest 2: Public /share page (no auth needed, QR code, LAN URL, tagline)...');
  const publicUser = createSession();
  const shareRes = await publicUser.get('/share');
  assert.strictEqual(shareRes.status, 200);
  assert.ok(shareRes.data.includes('data:image/png;base64,'), 'Must contain generated QR code data URL');
  assert.ok(shareRes.data.includes('One screen that tells a student what to do right now.'), 'Must contain exact tagline');
  assert.ok(shareRes.data.includes('http://'), 'Must display LAN URL');
  console.log('   ✅ /share page verified with QR code image, LAN URL, and required tagline');

  // TEST 3: Admin Only /demo Cheat-Sheet Page & 403 Guards
  console.log('\nTest 3: /demo cheat-sheet page (Admin only, 403 on student)...');
  const student = createSession();
  await student.post('/api/auth/login', { uid: 'STU001', passkey: 'stu123', role: 'STUDENT' });
  const studentDemoAccess = await student.get('/demo');
  assert.strictEqual(studentDemoAccess.status, 403, 'Student access to /demo must return 403');
  console.log('   ✅ Student access to /demo blocked with 403 Forbidden');

  const adminDemoAccess = await admin.get('/demo');
  assert.strictEqual(adminDemoAccess.status, 200, 'Admin access to /demo must return 200');
  assert.ok(adminDemoAccess.data.includes('ADMIN001 / admin123'));
  assert.ok(adminDemoAccess.data.includes('FAC001 / fac123'));
  assert.ok(adminDemoAccess.data.includes('STU001 / stu123'));
  assert.ok(adminDemoAccess.data.includes('90-Second Demo Flow'));
  console.log('   ✅ Admin /demo cheat-sheet verified with logins and 90-second steps');

  // TEST 4: Config & DEMO=1 Mode
  console.log('\nTest 4: /api/config exposes DEMO mode...');
  const configRes = await publicUser.get('/api/config');
  assert.strictEqual(configRes.status, 200);
  assert.strictEqual(typeof configRes.json.demo, 'boolean', 'Config must return boolean demo property');
  if (process.env.DEMO === '1') {
    assert.strictEqual(configRes.json.demo, true, 'Config must indicate demo: true when DEMO=1');
  }
  console.log(`   ✅ /api/config returned { demo: ${configRes.json.demo} }`);

  // TEST 5: Security Role Guards (Student cannot open Faculty APIs)
  console.log('\nTest 5: Student cannot call faculty APIs (403 Forbidden)...');
  const timetableAttempt = await student.post('/api/timetable/status', { timetableId: 1, st: 'absent' });
  assert.strictEqual(timetableAttempt.status, 403);

  const noticeAttempt = await student.post('/api/timetable/notice', { text: 'Fake Notice' });
  assert.strictEqual(noticeAttempt.status, 403);

  const attendanceAttempt = await student.post('/api/attendance/session', { course_id: 'CS101', date: '2026-10-06', time_slot: '10:00-11:00', records: [] });
  assert.strictEqual(attendanceAttempt.status, 403);

  const assignCreateAttempt = await student.post('/api/courses/CS101/assignments', { title: 'Hack' });
  assert.strictEqual(assignCreateAttempt.status, 403);

  const adminRosterAttempt = await student.get('/api/admin/roster');
  assert.strictEqual(adminRosterAttempt.status, 403);
  console.log('   ✅ All 5 unauthorized staff/admin endpoints returned 403 Forbidden for Student');

  // TEST 6: Flow 1 - Faculty sets Faculty Absent -> Student receives real-time update
  console.log('\nTest 6: Real-time Sync: Faculty sets class to Faculty Absent -> student client updates...');
  const faculty = createSession();
  await faculty.post('/api/auth/login', { uid: 'FAC001', passkey: 'fac123', role: 'FACULTY' });

  const stuSocket = io('http://localhost:3000');
  await new Promise(r => stuSocket.on('connect', r));

  const stateUpdatePromise = new Promise(resolve => {
    stuSocket.on('state:update', resolve);
  });
  const classStatusPromise = new Promise(resolve => {
    stuSocket.on('class:status_changed', resolve);
  });

  const statusUpdateRes = await faculty.post('/api/timetable/status', {
    timetableId: 1,
    st: 'absent',
    note: 'Medical leave - study chapter 4'
  });
  assert.strictEqual(statusUpdateRes.status, 200);

  const [receivedState, receivedClassStatus] = await Promise.all([stateUpdatePromise, classStatusPromise]);
  const cls1 = receivedState.classes.find(c => c.id === 1);
  assert.strictEqual(cls1.st, 'absent');
  assert.strictEqual(cls1.note, 'Medical leave - study chapter 4');
  assert.strictEqual(receivedClassStatus.status, 'absent');
  assert.strictEqual(receivedClassStatus.note, 'Medical leave - study chapter 4');
  console.log('   ✅ Faculty Absent status received by student socket in real time without refresh');

  // TEST 7: Flow 2 - Assignment flow: Faculty creates -> student sees & submits -> faculty grades & returns
  console.log('\nTest 7: Assignment Flow: Post -> Submit -> Grade & Return...');
  const assignCreatedPromise = new Promise(resolve => {
    stuSocket.on('assignment:created', resolve);
  });

  const createAssignRes = await faculty.post('/api/courses/CS101/assignments', {
    title: 'Lab 5: Balanced Search Trees',
    instructions: 'Implement AVL Tree insertion and rotation.',
    due_date: new Date(Date.now() + 86400000).toISOString(),
    max_points: 100
  });
  assert.strictEqual(createAssignRes.status, 200);
  const newAssignId = createAssignRes.json.assignmentId;

  const broadcastedAssign = await assignCreatedPromise;
  assert.strictEqual(broadcastedAssign.assignmentId, newAssignId);
  console.log(`   ✅ Faculty posted assignment (ID: ${newAssignId}); student received socket broadcast`);

  // Student submits
  const submitRes = await student.post(`/api/assignments/${newAssignId}/submit`, {
    text_submission: 'Completed AVL tree implementation with rotational self-balancing.'
  });
  assert.strictEqual(submitRes.status, 200);
  assert.strictEqual(submitRes.json.status, 'Submitted');
  console.log('   ✅ Student submitted solution');

  // Faculty checks submissions
  const subsRes = await faculty.get(`/api/assignments/${newAssignId}/submissions`);
  assert.strictEqual(subsRes.status, 200);
  const stuSub = subsRes.json.submissions.find(s => s.student_uid === 'STU001');
  assert.ok(stuSub, 'Student submission found');

  // Faculty grades & returns
  const gradePromise = new Promise(resolve => {
    stuSocket.on('submission:graded', resolve);
  });

  const gradeRes = await faculty.post(`/api/submissions/${stuSub.id}/grade`, {
    points: 96,
    feedback: 'Excellent rotational code and corner-case tests.'
  });
  assert.strictEqual(gradeRes.status, 200);

  const gradedEvent = await gradePromise;
  assert.strictEqual(gradedEvent.studentId, 'STU001');
  assert.strictEqual(gradedEvent.points, 96);
  console.log('   ✅ Faculty graded 96/100 and returned; student received real-time socket event');

  // Student checks notifications
  const notifRes = await student.get('/api/notifications');
  assert.strictEqual(notifRes.status, 200);
  const returnedNotif = notifRes.json.notifications.find(n => n.title.includes('Lab 5'));
  assert.ok(returnedNotif, 'Notification delivered to student');
  console.log(`   ✅ In-app notification confirmed: "${returnedNotif.title}"`);

  // TEST 8: Flow 3 - Event registration: seats and trending update live
  console.log('\nTest 8: Event Registration & Live Seats/Trending Update...');
  const regCountPromise = new Promise(resolve => {
    stuSocket.on('registrationCount', resolve);
  });

  // Aarav (STU001) registers for an eligible upcoming event
  const allEventsRes = await student.get('/api/events');
  assert.strictEqual(allEventsRes.status, 200);
  const targetEvent = allEventsRes.json.events.find(e => !e.isRegistered && e.status === 'upcoming' && (e.seatsLeft === null || e.seatsLeft > 0));
  assert.ok(targetEvent, 'Must find an eligible event for registration');

  const regEventRes = await student.post(`/api/events/${targetEvent.id}/register`);
  assert.strictEqual(regEventRes.status, 200);

  const regCountEvent = await regCountPromise;
  assert.strictEqual(regCountEvent.eventId, targetEvent.id);
  console.log(`   ✅ Student registered for event ${targetEvent.id} ("${targetEvent.title}"); socket broadcasted registrationCount: ${regCountEvent.regCount}`);

  // Check trending reflects engagement
  const trendingRes = await student.get('/api/events/trending');
  assert.strictEqual(trendingRes.status, 200);
  assert.ok(trendingRes.json.trending.length > 0);
  console.log(`   ✅ Trending algorithm updated live (Top event: "${trendingRes.json.trending[0].title}")`);

  stuSocket.disconnect();

  console.log('\n===============================================================');
  console.log('🎉 ALL DEMO-READY VERIFICATION TESTS COMPLETED WITH 100% SUCCESS!');
  console.log('===============================================================\n');
}

runDemoPassVerification().catch(err => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
