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
    cookie: () => cookie,
    clearCookie: () => { cookie = ''; }
  };
}

async function runNotificationsTest() {
  console.log('======================================================================');
  console.log('🔔 Verifying Automatic Real-Time Notifications & Bell UI Suite');
  console.log('======================================================================\n');

  // STEP 0: Reset demo data first to guarantee clean seed state
  console.log('Step 0: Log in as ADMIN and perform clean Reset Demo Data...');
  const admin = createSession();
  const adminLogin = await admin.post('/api/auth/login', { uid: 'ADMIN001', passkey: 'admin123', role: 'ADMIN' });
  assert.strictEqual(adminLogin.status, 200, 'Admin login must succeed');

  const resetRes = await admin.post('/api/admin/reset-demo');
  assert.strictEqual(resetRes.status, 200, 'Reset demo data must succeed');
  console.log('   ✅ Clean seed data restored and demo notifications initialized\n');

  // STEP 1: Verify Seed Notifications for STU001
  console.log('Step 1: Checking STU001 initial seeded notifications & unread count...');
  const stu1 = createSession();
  const stu1Login = await stu1.post('/api/auth/login', { uid: 'STU001', passkey: 'stu123', role: 'STUDENT' });
  assert.strictEqual(stu1Login.status, 200);

  const initialNotifRes = await stu1.get('/api/notifications');
  assert.strictEqual(initialNotifRes.status, 200);
  assert.ok(initialNotifRes.json.notifications.length >= 3, 'STU001 must have seeded notifications');
  assert.strictEqual(initialNotifRes.json.unreadCount, 2, 'STU001 must have 2 unread notifications initially');
  console.log(`   ✅ STU001 has ${initialNotifRes.json.notifications.length} notifications, unread count = ${initialNotifRes.json.unreadCount}`);

  // Connect STU001 Socket.IO client with session cookie
  console.log('   Connecting Socket.IO client for STU001...');
  const stu1Socket = io('http://localhost:3000', {
    extraHeaders: { Cookie: stu1.cookie() }
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('stu1Socket connection timed out')), 4000);
    stu1Socket.on('connect', () => { clearTimeout(t); resolve(); });
  });
  stu1Socket.emit('joinUser', { uid: 'STU001', role: 'STUDENT' });

  // STEP 2: Faculty changes a class status -> notify enrolled students ("Data Structures: Faculty Absent. You are free.")
  console.log('\nStep 2: Testing Trigger 1: Faculty changes class status to "absent"...');
  const fac = createSession();
  const facLogin = await fac.post('/api/auth/login', { uid: 'FAC001', passkey: 'fac123', role: 'FACULTY' });
  assert.strictEqual(facLogin.status, 200);

  const stu1ClassNotifPromise = new Promise((resolve) => {
    stu1Socket.on('notification:new', (notif) => {
      if (notif.type === 'class_status') resolve(notif);
    });
  });

  const stu1UnreadPromise1 = new Promise((resolve) => {
    stu1Socket.on('notifications:unread_update', (data) => resolve(data));
  });

  // Change Period 1 (Data Structures) status to absent
  const statusRes = await fac.post('/api/timetable/status', {
    timetableId: 1,
    st: 'absent',
    note: ''
  });
  assert.strictEqual(statusRes.status, 200);

  const classNotif = await stu1ClassNotifPromise;
  await stu1UnreadPromise1;
  assert.strictEqual(classNotif.uid, 'STU001');
  assert.strictEqual(classNotif.type, 'class_status');
  assert.strictEqual(classNotif.message, 'Data Structures: Faculty Absent. You are free.');
  console.log(`   ✅ Real-time notification received via Socket.IO: "${classNotif.title} - ${classNotif.message}"`);

  // STEP 3: Faculty grades and returns a submission -> notify that student with the grade
  console.log('\nStep 3: Testing Trigger 2: Faculty grades & returns submission...');
  // Find an existing submission or submit Lab 4
  const enrollments = await stu1.get('/api/courses/CS101/assignments');
  const assignId = enrollments.json.assignments[0].id;

  // Ensure STU001 has a submission
  await stu1.post(`/api/assignments/${assignId}/submit`, {
    text_submission: 'Completed Lab assignment.'
  });

  const subsRes = await fac.get(`/api/assignments/${assignId}/submissions`);
  const stuSub = subsRes.json.submissions.find(s => s.student_uid === 'STU001');
  assert.ok(stuSub, 'STU001 submission must exist');

  const stu1GradeNotifPromise = new Promise((resolve) => {
    stu1Socket.on('notification:new', (notif) => {
      if (notif.type === 'grade_returned') resolve(notif);
    });
  });

  const gradeRes = await fac.post(`/api/submissions/${stuSub.id}/grade`, {
    points: 95,
    feedback: 'Excellent work!'
  });
  assert.strictEqual(gradeRes.status, 200);

  const gradeNotif = await stu1GradeNotifPromise;
  assert.strictEqual(gradeNotif.uid, 'STU001');
  assert.strictEqual(gradeNotif.type, 'grade_returned');
  assert.ok(gradeNotif.message.includes('95/'), 'Notification message must include the score');
  console.log(`   ✅ Real-time grade notification received: "${gradeNotif.title} - ${gradeNotif.message}"`);

  // STEP 4: A student's attendance in a subject drops below 75% -> notify once per subject (no duplicates)
  console.log('\nStep 4: Testing Trigger 3: Student attendance drops below 75% (notify once per subject)...');
  // Log in as STU004 (who has normal attendance, let's mark absent multiple sessions to drop below 75%)
  const stu4 = createSession();
  await stu4.post('/api/auth/login', { uid: 'STU004', passkey: 'stu123', role: 'STUDENT' });
  const stu4Socket = io('http://localhost:3000', { extraHeaders: { Cookie: stu4.cookie() } });
  await new Promise((resolve) => stu4Socket.on('connect', resolve));
  stu4Socket.emit('joinUser', { uid: 'STU004', role: 'STUDENT' });

  let stu4NotifCount = 0;
  stu4Socket.on('notification:new', (notif) => {
    if (notif.type === 'attendance_shortage') stu4NotifCount++;
  });

  // Mark absent sessions for STU004 in CS101 (where FAC001 is faculty)
  for (let i = 1; i <= 25; i++) {
    const attPostRes = await fac.post('/api/attendance/session', {
      course_id: 'CS101',
      date: `2026-08-${String(i).padStart(2, '0')}`,
      time_slot: '11:00-12:00',
      records: [{ student_id: 'STU004', status: 'Absent' }]
    });
    assert.strictEqual(attPostRes.status, 200, 'Attendance post must succeed');
  }

  // Allow socket events to propagate
  await new Promise(r => setTimeout(r, 500));

  // Verify STU004 notifications in database
  const stu4Notifs = await stu4.get('/api/notifications');
  const shortageNotifs = stu4Notifs.json.notifications.filter(n => n.type === 'attendance_shortage' && (n.course_id === 'CS101' || n.title.includes('CS301') || n.title.includes('CS101')));
  assert.strictEqual(shortageNotifs.length, 1, 'Must notify EXACTLY ONCE per subject, no duplicates!');
  console.log(`   ✅ Attendance shortage notification received once: "${shortageNotifs[0].title} - ${shortageNotifs[0].message}"`);
  console.log('   ✅ Subsequent sessions did NOT create duplicate shortage notifications');

  // STEP 5: A notice is posted -> notify all students
  console.log('\nStep 5: Testing Trigger 4: Notice posted -> notify all students...');
  const stu1NoticePromise = new Promise((resolve) => {
    stu1Socket.on('notification:new', (notif) => {
      if (notif.type === 'notice') resolve(notif);
    });
  });

  const noticeText = 'Campus Library open 24/7 during final exam week.';
  const noticeRes = await fac.post('/api/timetable/notice', { notice: noticeText });
  assert.strictEqual(noticeRes.status, 200);

  const noticeNotif = await stu1NoticePromise;
  assert.strictEqual(noticeNotif.type, 'notice');
  assert.strictEqual(noticeNotif.message, noticeText);
  console.log(`   ✅ STU001 received real-time notice notification: "${noticeNotif.title} - ${noticeNotif.message}"`);

  // STEP 6: Mark All As Read & Unread Count Badge Live Update
  console.log('\nStep 6: Testing "Mark all as read" API & live badge update...');
  const beforeRead = await stu1.get('/api/notifications');
  assert.ok(beforeRead.json.unreadCount > 0, 'Should have unread notifications before marking all as read');
  console.log(`   Unread count before marking all as read: ${beforeRead.json.unreadCount}`);

  const unreadUpdatePromise = new Promise((resolve) => {
    stu1Socket.on('notifications:unread_update', (data) => resolve(data));
  });

  const markReadRes = await stu1.post('/api/notifications/read', {});
  assert.strictEqual(markReadRes.status, 200);
  assert.strictEqual(markReadRes.json.unreadCount, 0);

  const unreadUpdateData = await unreadUpdatePromise;
  assert.strictEqual(unreadUpdateData.unreadCount, 0, 'Socket event must broadcast unreadCount = 0');

  const afterRead = await stu1.get('/api/notifications');
  assert.strictEqual(afterRead.json.unreadCount, 0, 'Unread count must be 0 after marking all as read');
  console.log('   ✅ Mark all as read cleared all unreads and broadcasted unreadCount: 0 live');

  // STEP 7: Reset Demo Data clears and reseeds notifications
  console.log('\nStep 7: Testing Reset Demo Data clears and reseeds notifications...');
  const stu1ResetPromise = new Promise((resolve) => {
    stu1Socket.on('notifications:unread_update', () => resolve());
  });

  const reset2Res = await admin.post('/api/admin/reset-demo');
  assert.strictEqual(reset2Res.status, 200);

  await stu1ResetPromise;

  const resetNotifs = await stu1.get('/api/notifications');
  assert.strictEqual(resetNotifs.status, 200);
  assert.strictEqual(resetNotifs.json.unreadCount, 2, 'STU001 must have clean seed unread count = 2 after reset');
  const classStatusNotif = resetNotifs.json.notifications.find(n => n.type === 'class_status');
  assert.ok(classStatusNotif, 'Seed class_status notification must be present');
  assert.strictEqual(classStatusNotif.message, 'Data Structures: Faculty Absent. You are free.');
  console.log('   ✅ Reset Demo Data cleared custom notifications and reseeded clean initial state');

  stu1Socket.disconnect();
  stu4Socket.disconnect();

  console.log('\n🎉 ALL REAL-TIME NOTIFICATION AUDIT TESTS PASSED SUCCESSFULLY!\n');
}

module.exports = { runNotificationsTest };

if (require.main === module) {
  runNotificationsTest().catch((err) => {
    console.error('\n❌ Notification test failed:', err);
    process.exit(1);
  });
}
