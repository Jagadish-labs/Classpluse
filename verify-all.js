const http = require('http');
const { io } = require('socket.io-client');
const assert = require('assert');
const { db } = require('./db');

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

async function runEndToEndVerification() {
  console.log('===============================================================');
  console.log('🧪 Starting ClassPulse Comprehensive End-to-End Verification...');
  console.log('===============================================================\n');

  // Reset demo user STU101 to unregistered state before test
  db.prepare("DELETE FROM users WHERE uid = 'STU101'").run();
  db.prepare("UPDATE roster SET registered = 0 WHERE uid = 'STU101'").run();

  // STEP 1: Sign up STU101 with a valid roster name, then logout and login
  console.log('Step 1: Testing Signup & Activation with Roster...');
  const student101 = createSession();
  const signupRes = await student101.post('/api/auth/signup', {
    uid: 'STU101',
    name: 'Demo Student',
    passkey: 'demo1234',
    confirmPasskey: 'demo1234'
  });
  assert.strictEqual(signupRes.status, 200, 'STU101 signup should succeed');
  assert.strictEqual(signupRes.json.success, true);
  console.log('   ✅ STU101 successfully registered with roster validation');

  // Logout STU101
  await student101.post('/api/auth/logout');
  student101.clearCookie();

  // Login with new passkey
  const login101 = await student101.post('/api/auth/login', {
    uid: 'STU101',
    passkey: 'demo1234',
    role: 'STUDENT'
  });
  assert.strictEqual(login101.status, 200);
  assert.strictEqual(login101.json.user.uid, 'STU101');
  console.log('   ✅ STU101 logged in successfully with new passkey');

  // STEP 2: Try signup with an ID not in the roster and confirm rejection
  console.log('\nStep 2: Testing Roster Security Rejection for unauthorized IDs...');
  const fakeUser = createSession();
  const fakeSignup = await fakeUser.post('/api/auth/signup', {
    uid: 'FAKE999',
    name: 'Unauthorized Person',
    passkey: 'secret123',
    confirmPasskey: 'secret123'
  });
  assert.strictEqual(fakeSignup.status, 400, 'Unauthorized ID must return 400');
  assert.ok(fakeSignup.json.error.includes('not found in authorised campus roster'));
  console.log('   ✅ Unauthorized ID "FAKE999" was strictly rejected by server');

  // STEP 3: Log in as FAC001, mark attendance, enter marks, publish, post assignment
  console.log('\nStep 3: Testing Faculty Workflows (Attendance, Marks, Assignments)...');
  const facSession = createSession();
  const facLogin = await facSession.post('/api/auth/login', {
    uid: 'FAC001',
    passkey: 'fac123',
    role: 'FACULTY'
  });
  assert.strictEqual(facLogin.status, 200);
  console.log('   ✅ FAC001 (Prof. Rao) logged in');

  // Mark attendance for CS101
  const todayStr = new Date().toISOString().split('T')[0];
  const attRes = await facSession.post('/api/attendance/session', {
    course_id: 'CS101',
    date: todayStr,
    time_slot: '09:00-09:50',
    records: [
      { student_id: 'STU001', status: 'Present' },
      { student_id: 'STU002', status: 'Present' },
      { student_id: 'STU007', status: 'Absent' }
    ]
  });
  assert.strictEqual(attRes.status, 200);
  assert.strictEqual(attRes.json.success, true);
  console.log('   ✅ FAC001 marked and saved session attendance for CS101');

  // Create assessment & enter marks
  const assRes = await facSession.post('/api/marks/assessment', {
    course_id: 'CS101',
    name: 'Quiz 2: Trees & Graphs',
    max_marks: 25,
    weightage: 15
  });
  assert.strictEqual(assRes.status, 200);
  const newAssId = assRes.json.assessmentId;

  const marksRes = await facSession.post('/api/marks/save', {
    assessment_id: newAssId,
    marks: [
      { student_id: 'STU001', score: 24 },
      { student_id: 'STU002', score: 22 }
    ]
  });
  assert.strictEqual(marksRes.status, 200);
  console.log('   ✅ FAC001 entered student scores for Quiz 2');

  // Publish marks
  const pubRes = await facSession.post('/api/marks/publish', {
    assessment_id: newAssId,
    published: 1
  });
  assert.strictEqual(pubRes.status, 200);
  assert.strictEqual(pubRes.json.published, true);
  console.log('   ✅ FAC001 published Quiz 2 marks to student portal');

  // Post assignment
  const assignRes = await facSession.post('/api/courses/CS101/assignments', {
    title: 'Assignment 3: Binary Search Tree Balancing',
    instructions: 'Implement AVL tree rotations and submit benchmark tests.',
    due_date: new Date(Date.now() + 5 * 86400000).toISOString(),
    max_points: 100
  });
  assert.strictEqual(assignRes.status, 200);
  console.log('   ✅ FAC001 posted Assignment 3 to CS101 Classwork');

  // STEP 4: Log in as student (STU001), verify attendance %, marks, assignment, & live socket sync
  console.log('\nStep 4: Testing Student Portal & Real-Time Socket.IO Synchronization...');
  const stuSession = createSession();
  const stuLogin = await stuSession.post('/api/auth/login', {
    uid: 'STU001',
    passkey: 'stu123',
    role: 'STUDENT'
  });
  assert.strictEqual(stuLogin.status, 200);
  console.log('   ✅ STU001 (Aarav Sharma) logged in');

  // Check attendance
  const stuAtt = await stuSession.get('/api/attendance/course/CS101');
  assert.strictEqual(stuAtt.status, 200);
  assert.ok(stuAtt.json.percentage >= 75);
  console.log(`   ✅ STU001 attendance verified: ${stuAtt.json.percentage}% (${stuAtt.json.presentCount}/${stuAtt.json.totalSessions} sessions)`);

  // Check published marks
  const stuMarks = await stuSession.get('/api/marks/course/CS101');
  assert.strictEqual(stuMarks.status, 200);
  const quiz2 = stuMarks.json.assessments.find(a => a.id === newAssId);
  assert.ok(quiz2, 'Quiz 2 must appear in student published marks');
  assert.strictEqual(quiz2.score, 24);
  console.log('   ✅ STU001 viewed published Quiz 2 score (24/25)');

  // Test real-time Socket.IO status change broadcast
  console.log('   Connecting Socket.IO student client for live broadcast test...');
  const studentSocket = io('http://localhost:3000');

  await new Promise((resolve) => {
    studentSocket.on('connect', resolve);
  });

  const socketUpdatePromise = new Promise((resolve) => {
    studentSocket.on('class:status_changed', (evt) => {
      resolve(evt);
    });
  });

  const timetableState = await facSession.get('/api/timetable/today');
  const targetClass = timetableState.json.classes.find(t => t.faculty_id === 'FAC001') || timetableState.json.classes[0];
  const targetClassId = targetClass.id;

  // FAC001 changes status of Data Structures (Period 1) to "delayed" with note
  const statusUpdateRes = await facSession.post('/api/timetable/status', {
    timetableId: targetClassId,
    st: 'delayed',
    note: 'Arriving in 10 mins from faculty meeting'
  });
  assert.strictEqual(statusUpdateRes.status, 200);

  const receivedEvent = await socketUpdatePromise;
  assert.strictEqual(receivedEvent.classId, targetClassId);
  assert.strictEqual(receivedEvent.status, 'delayed');
  assert.strictEqual(receivedEvent.note, 'Arriving in 10 mins from faculty meeting');
  studentSocket.disconnect();
  console.log('   ✅ Real-time Socket.IO broadcast received instantly on student client with status "delayed" and note');

  // STEP 5: Confirm student cannot access unauthorized courses or admin endpoints (expect 403)
  console.log('\nStep 5: Testing Security Route Guards (Role & Ownership Enforcements)...');
  const adminAccessAttempt = await stuSession.get('/api/admin/roster');
  assert.strictEqual(adminAccessAttempt.status, 403, 'Student accessing admin roster must return 403');
  console.log('   ✅ Student access to /api/admin/roster rejected with 403 Forbidden');

  const facultyActionAttempt = await stuSession.post('/api/timetable/status', {
    timetableId: targetClassId,
    st: 'cancelled'
  });
  assert.strictEqual(facultyActionAttempt.status, 403, 'Student trying to alter timetable must return 403');
  console.log('   ✅ Student altering timetable rejected with 403 Forbidden');

  // STEP 6: Admin Roster & Passkey Reset
  console.log('\nStep 6: Testing Admin Passkey Reset & Forced Password Update...');
  const adminSession = createSession();
  await adminSession.post('/api/auth/login', {
    uid: 'ADMIN001',
    passkey: 'admin123',
    role: 'ADMIN'
  });

  // Reset STU002 passkey
  const resetRes = await adminSession.post('/api/admin/reset-passkey', {
    uid: 'STU002',
    tempPasskey: 'temp999'
  });
  assert.strictEqual(resetRes.status, 200);
  console.log('   ✅ Admin reset STU002 passkey to temporary key');

  // STU002 logs in with temporary passkey and is flagged must_change_pass = true
  const stu2Session = createSession();
  const stu2Login = await stu2Session.post('/api/auth/login', {
    uid: 'STU002',
    passkey: 'temp999',
    role: 'STUDENT'
  });
  assert.strictEqual(stu2Login.status, 200);
  assert.strictEqual(stu2Login.json.user.must_change_pass, true);
  console.log('   ✅ STU002 logged in with temporary passkey; must_change_pass is true');

  // STU002 changes passkey to new private key
  const changeRes = await stu2Session.post('/api/auth/change-passkey', {
    newPasskey: 'newpass123'
  });
  assert.strictEqual(changeRes.status, 200);
  console.log('   ✅ STU002 changed temporary passkey to private passkey');

  console.log('\n===============================================================');
  console.log('🎉 ALL 6 VERIFICATION PHASES COMPLETED WITH 100% SUCCESS!');
  console.log('===============================================================\n');
  process.exit(0);
}

runEndToEndVerification().catch(err => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
