const http = require('http');
const { io } = require('socket.io-client');
const { db } = require('./db');

function createSession() {
  let cookie = '';
  async function request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(`http://localhost:3000${path}`);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { 'Cookie': cookie } : {})
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
          try { json = JSON.parse(data); } catch (e) {}
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
  return {
    post: (path, body) => request('POST', path, body),
    cookie: () => cookie
  };
}

async function runTest() {
  // Remove STU002 from CS101 enrollment for this test
  db.prepare("DELETE FROM enrollments WHERE course_id = 'CS101' AND student_id = 'STU002'").run();

  console.log('--- Logging in users ---');
  const stu1 = createSession();
  await stu1.post('/api/auth/login', { uid: 'STU001', passkey: 'stu123', role: 'STUDENT' });

  const stu2 = createSession();
  await stu2.post('/api/auth/login', { uid: 'STU002', passkey: 'stu123', role: 'STUDENT' });

  const fac = createSession();
  await fac.post('/api/auth/login', { uid: 'FAC001', passkey: 'fac123', role: 'FACULTY' });

  console.log('--- Connecting Sockets ---');
  const socket1 = io('http://localhost:3000', { extraHeaders: { Cookie: stu1.cookie() } });
  const socket2 = io('http://localhost:3000', { extraHeaders: { Cookie: stu2.cookie() } });

  await Promise.all([
    new Promise(res => socket1.on('connect', res)),
    new Promise(res => socket2.on('connect', res))
  ]);

  socket1.emit('joinUser', { uid: 'STU001', role: 'STUDENT' });
  socket2.emit('joinUser', { uid: 'STU002', role: 'STUDENT' });

  const events1 = [];
  const events2 = [];

  socket1.onAny((eventName, ...args) => {
    events1.push({ eventName, args });
  });

  socket2.onAny((eventName, ...args) => {
    events2.push({ eventName, args });
  });

  await new Promise(r => setTimeout(r, 500));
  events1.length = 0;
  events2.length = 0;

  console.log('--- Faculty updating class status for CS101 (STU001 enrolled, STU002 NOT enrolled) ---');
  const statusRes = await fac.post('/api/timetable/status', {
    timetableId: 1,
    st: 'absent',
    note: 'Testing status update'
  });
  console.log('Status change response status:', statusRes.status);

  await new Promise(r => setTimeout(r, 1500));

  console.log('\n=== STU001 (Enrolled) Events Received ===');
  events1.forEach(e => console.log(`- ${e.eventName}:`, JSON.stringify(e.args)));

  console.log('\n=== STU002 (Not Enrolled) Events Received ===');
  events2.forEach(e => console.log(`- ${e.eventName}:`, JSON.stringify(e.args)));

  socket1.disconnect();
  socket2.disconnect();

  // Restore STU002 enrollment
  db.prepare("INSERT OR IGNORE INTO enrollments (course_id, student_id) VALUES ('CS101', 'STU002')").run();
}

runTest().catch(console.error);
