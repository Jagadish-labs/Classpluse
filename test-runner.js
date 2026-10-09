const http = require('http');
const { io } = require('socket.io-client');
const assert = require('assert');

function createSession() {
  let cookie = '';

  async function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(`http://localhost:3000${path}`);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {})
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        if (res.headers['set-cookie']) {
          cookie = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
        }
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (e) { /* non-JSON */ }
          resolve({ status: res.statusCode, data, json, headers: res.headers, cookie });
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    cookie: () => cookie,
    clearCookie: () => { cookie = ''; }
  };
}

async function runTests() {
  console.log('🧪 ClassPulse audit test script (cookies + fetch)\n');

  const health = await createSession().get('/api/health');
  assert.strictEqual(health.status, 200, 'App must be running on :3000');
  assert.strictEqual(health.json.status, 'ok');
  console.log('   ✅ Server is up');

  const admin = createSession();
  const adminLogin = await admin.post('/api/auth/login', { uid: 'ADMIN001', passkey: 'admin123', role: 'ADMIN' });
  assert.strictEqual(adminLogin.status, 200, 'ADMIN001 login');
  const resetRes = await admin.post('/api/admin/reset-demo');
  assert.strictEqual(resetRes.status, 200, 'Reset Demo Data');
  assert.strictEqual(resetRes.json.success, true);
  console.log('   ✅ Reset Demo Data restored seed');

  console.log('\n1. Signup rules...');
  const guest = createSession();
  const notRoster = await guest.post('/api/auth/signup', {
    uid: 'FAKE999', name: 'Nobody', passkey: 'secret1', confirmPasskey: 'secret1'
  });
  assert.strictEqual(notRoster.status, 400);
  assert.ok(String(notRoster.json.error).toLowerCase().includes('roster'));

  const shortPk = await guest.post('/api/auth/signup', {
    uid: 'STU101', name: 'Demo Student', passkey: '12345', confirmPasskey: '12345'
  });
  assert.strictEqual(shortPk.status, 400);

  const okSignup = await guest.post('/api/auth/signup', {
    uid: 'STU101', name: 'Demo Student', passkey: 'demo123', confirmPasskey: 'demo123'
  });
  assert.strictEqual(okSignup.status, 200, 'Unregistered roster ID can create passkey');

  const again = await createSession().post('/api/auth/signup', {
    uid: 'STU101', name: 'Demo Student', passkey: 'demo123', confirmPasskey: 'demo123'
  });
  assert.strictEqual(again.status, 400, 'Already registered ID is blocked');

  const taken = await createSession().post('/api/auth/signup', {
    uid: 'STU001', name: 'Aarav Sharma', passkey: 'stu123', confirmPasskey: 'stu123'
  });
  assert.strictEqual(taken.status, 400);
  console.log('   ✅ Roster reject / min 6 chars / first signup / already-registered');

  console.log('\n2. Wrong-passkey lockout (per ID, not per IP)...');
  const attacker = createSession();
  for (let i = 0; i < 5; i++) {
    const fail = await attacker.post('/api/auth/login', { uid: 'STU004', passkey: 'wrong-pass', role: 'STUDENT' });
    assert.strictEqual(fail.status, 401, `failure ${i + 1} should be 401`);
  }
  const locked = await attacker.post('/api/auth/login', { uid: 'STU004', passkey: 'wrong-pass', role: 'STUDENT' });
  assert.strictEqual(locked.status, 429, '6th wrong passkey for same ID must 429');

  const stu1 = createSession();
  const stu1Login = await stu1.post('/api/auth/login', { uid: 'STU001', passkey: 'stu123', role: 'STUDENT' });
  assert.strictEqual(stu1Login.status, 200, 'Shared IP must not lock other IDs');
  console.log('   ✅ 5 wrong keys lock STU004; STU001 still logs in from same IP');

  console.log('\n3. Student 403 on faculty/admin routes...');
  const facPost = await stu1.post('/api/timetable/status', { timetableId: 1, st: 'absent', note: 'hack' });
  assert.strictEqual(facPost.status, 403);
  const notice = await stu1.post('/api/timetable/notice', { text: 'hack' });
  assert.strictEqual(notice.status, 403);
  const att = await stu1.post('/api/attendance/session', { course_id: 'CS101', date: '2026-10-09', time_slot: '09:00-09:50', records: [] });
  assert.strictEqual(att.status, 403);
  const roster = await stu1.get('/api/admin/roster');
  assert.strictEqual(roster.status, 403);
  const impact = await stu1.get('/api/admin/impact');
  assert.strictEqual(impact.status, 403);
  console.log('   ✅ Student blocked from faculty/admin APIs');

  console.log('\n4. One student cannot read another student\'s data...');
  const marks = await stu1.get('/api/marks/course/CS101');
  assert.strictEqual(marks.status, 200);
  assert.ok(!marks.json.studentsGrid, 'Student must not receive class marks grid');
  const otherUid = JSON.stringify(marks.json).includes('STU002');
  assert.ok(!otherUid, 'Marks payload must not name another student');

  const assignList = await stu1.get('/api/courses/CS101/assignments');
  assert.strictEqual(assignList.status, 200);
  const firstAssign = assignList.json.assignments[0];
  const subs = await stu1.get(`/api/assignments/${firstAssign.id}/submissions`);
  assert.strictEqual(subs.status, 403);

  const notifs = await stu1.get('/api/notifications');
  assert.strictEqual(notifs.status, 200);
  for (const n of notifs.json.notifications) {
    assert.strictEqual(n.uid, 'STU001');
  }

  const traversal = await stu1.get('/api/files/..%2Fserver.js');
  assert.ok(traversal.status === 403 || traversal.status === 404);
  console.log('   ✅ Cross-student marks/submissions blocked; path traversal rejected');

  console.log('\n5. Live status change reaches a second client...');
  const faculty = createSession();
  const facLogin = await faculty.post('/api/auth/login', { uid: 'FAC001', passkey: 'fac123', role: 'FACULTY' });
  assert.strictEqual(facLogin.status, 200);

  const clientA = io('http://localhost:3000', { extraHeaders: { Cookie: stu1.cookie() } });
  const clientB = io('http://localhost:3000', { extraHeaders: { Cookie: faculty.cookie() } });
  await Promise.all([
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('socket A timeout')), 4000);
      clientA.on('connect', () => { clearTimeout(t); resolve(); });
    }),
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('socket B timeout')), 4000);
      clientB.on('connect', () => { clearTimeout(t); resolve(); });
    })
  ]);

  const seen = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('did not receive class:status_changed')), 5000);
    clientB.on('class:status_changed', (evt) => {
      clearTimeout(t);
      resolve(evt);
    });
  });

  const statusRes = await faculty.post('/api/timetable/status', {
    timetableId: 1,
    st: 'absent',
    note: 'Medical leave - study ch 4'
  });
  assert.strictEqual(statusRes.status, 200);
  const evt = await seen;
  assert.strictEqual(evt.status, 'absent');
  assert.strictEqual(evt.note, 'Medical leave - study ch 4');
  clientA.disconnect();
  clientB.disconnect();
  console.log('   ✅ Second client received live Faculty Absent');

  console.log('\n6. Reset Demo Data restores seed...');
  const reset2 = await admin.post('/api/admin/reset-demo');
  assert.strictEqual(reset2.status, 200);
  const state = await admin.get('/api/state');
  assert.strictEqual(state.status, 200);
  assert.strictEqual(state.json.notice, '');
  assert.ok(state.json.classes.length >= 6);
  assert.ok(state.json.classes.every(c => c.st === 'ongoing' && c.note === ''));

  const stu101Again = await createSession().post('/api/auth/signup', {
    uid: 'STU101', name: 'Demo Student', passkey: 'demo123', confirmPasskey: 'demo123'
  });
  assert.strictEqual(stu101Again.status, 200, 'After reset, STU101 must be unregistered again');

  const stu2 = createSession();
  const stu2Login = await stu2.post('/api/auth/login', { uid: 'STU002', passkey: 'stu123', role: 'STUDENT' });
  assert.strictEqual(stu2Login.status, 200, 'Seed passkeys restored');
  console.log('   ✅ Seed restored (statuses, notice, STU101, demo logins)');

  console.log('\n🎉 ALL AUDIT TESTS PASSED\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
