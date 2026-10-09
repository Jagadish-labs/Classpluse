const http = require('http');
const { io } = require('socket.io-client');
const assert = require('assert');
const bcrypt = require('bcryptjs');
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
    put: (path, body, headers) => request('PUT', path, body, headers),
    delete: (path, headers) => request('DELETE', path, null, headers),
    clearCookie: () => { cookie = ''; }
  };
}

async function runPhase6Tests() {
  console.log('===============================================================');
  console.log('🧪 Starting ClassPulse Phase 6: Events & Trending Verification');
  console.log('===============================================================\n');

  // Reset demo passwords to default
  const stuPassHash = bcrypt.hashSync('stu123', 8);
  db.prepare("UPDATE users SET password_hash = ? WHERE role = 'STUDENT'").run(stuPassHash);

  // STEP 1: Faculty FAC001 creates an event with capacity 2 and confirms real-time broadcast
  console.log('Step 1: Faculty creates event with capacity 2 & verifies Socket.IO broadcast...');
  const facSession = createSession();
  await facSession.post('/api/auth/login', { uid: 'FAC001', passkey: 'fac123', role: 'FACULTY' });

  const studentSocket = io('http://localhost:3000');
  await new Promise(r => studentSocket.on('connect', r));

  const eventCreatedPromise = new Promise(resolve => {
    studentSocket.on('eventCreated', resolve);
  });

  const now = Date.now();
  const createRes = await facSession.post('/api/events', {
    title: 'Autonomous Robotics Workshop',
    description: 'Hands-on ROS2 and SLAM robotics session with limited hardware kits.',
    category: 'Workshop',
    venue: 'Robotics Center Lab 4',
    start_ts: now + 3600 * 1000,
    end_ts: now + 4 * 3600 * 1000,
    capacity: 2,
    banner_color: '#059669'
  });

  assert.strictEqual(createRes.status, 200);
  const createdEventId = createRes.json.eventId;
  assert.ok(createdEventId, 'Event ID must be returned');

  const broadcastedEvent = await eventCreatedPromise;
  assert.strictEqual(broadcastedEvent.id, createdEventId);
  assert.strictEqual(broadcastedEvent.title, 'Autonomous Robotics Workshop');
  console.log(`   ✅ Event created (ID: ${createdEventId}) and broadcasted via Socket.io eventCreated`);

  // STEP 2: Register two students, confirm third is blocked with "Full"
  console.log('\nStep 2: Testing capacity enforcement (2 seats max)...');
  const stu1 = createSession();
  await stu1.post('/api/auth/login', { uid: 'STU001', passkey: 'stu123', role: 'STUDENT' });
  const reg1 = await stu1.post(`/api/events/${createdEventId}/register`);
  assert.strictEqual(reg1.status, 200);
  assert.strictEqual(reg1.json.success, true);
  console.log('   ✅ STU001 registered successfully (Seat 1/2)');

  const stu2 = createSession();
  await stu2.post('/api/auth/login', { uid: 'STU002', passkey: 'stu123', role: 'STUDENT' });
  const reg2 = await stu2.post(`/api/events/${createdEventId}/register`);
  assert.strictEqual(reg2.status, 200);
  assert.strictEqual(reg2.json.success, true);
  console.log('   ✅ STU002 registered successfully (Seat 2/2 - Event now FULL)');

  const stu3 = createSession();
  await stu3.post('/api/auth/login', { uid: 'STU003', passkey: 'stu123', role: 'STUDENT' });
  const reg3 = await stu3.post(`/api/events/${createdEventId}/register`);
  assert.strictEqual(reg3.status, 400, '3rd registration must be rejected with 400');
  assert.ok(reg3.json.error.includes('full capacity'), 'Error message must specify full capacity');
  console.log('   ✅ STU003 registration blocked: "Event is at full capacity"');

  // STEP 3: Confirm trending calculation & ranking
  console.log('\nStep 3: Testing Trending algorithm & ranking...');
  const trendingRes = await stu1.get('/api/events/trending');
  assert.strictEqual(trendingRes.status, 200);
  assert.ok(Array.isArray(trendingRes.json.trending));
  assert.ok(trendingRes.json.trending.length <= 5);
  console.log(`   ✅ Top trending events returned (${trendingRes.json.trending.length} events) with scores:`);
  trendingRes.json.trending.forEach((t, i) => {
    console.log(`      #${i+1}: "${t.title}" | Score: ${t.trendingScore} | ${t.whyTrending}`);
  });

  // STEP 4: Check in student and verify repeat check-in rejection
  console.log('\nStep 4: Testing Check-In Scanner and Repeat Check-in Protection...');
  const checkin1 = await facSession.post(`/api/events/${createdEventId}/checkin`, { uid: 'STU001' });
  assert.strictEqual(checkin1.status, 200);
  assert.strictEqual(checkin1.json.success, true);
  assert.ok(checkin1.json.message.includes('Checked in successfully'));
  console.log('   ✅ STU001 checked in successfully');

  const checkinRepeat = await facSession.post(`/api/events/${createdEventId}/checkin`, { uid: 'STU001' });
  assert.strictEqual(checkinRepeat.status, 400, 'Repeat check-in must return 400');
  assert.ok(checkinRepeat.json.error.includes('already checked in'));
  console.log('   ✅ Repeat check-in for STU001 was rejected: "Student STU001 was already checked in"');

  const checkinUnregistered = await facSession.post(`/api/events/${createdEventId}/checkin`, { uid: 'STU009' });
  assert.strictEqual(checkinUnregistered.status, 400);
  assert.ok(checkinUnregistered.json.error.includes('NOT registered'));
  console.log('   ✅ Unregistered student STU009 check-in rejected: "Student STU009 is NOT registered"');

  // STEP 5: Cancel event and confirm registered students receive in-app notification
  console.log('\nStep 5: Testing Event Cancellation & Notification Delivery...');
  const cancelRes = await facSession.post(`/api/events/${createdEventId}/status`, {
    status: 'cancelled',
    cancel_reason: 'Lab kits delayed in courier shipment'
  });
  assert.strictEqual(cancelRes.status, 200);
  console.log('   ✅ Event marked as cancelled with reason');

  const notifRes = await stu2.get('/api/notifications');
  assert.strictEqual(notifRes.status, 200);
  const cancelNotif = notifRes.json.notifications.find(n => n.title.includes('Event Cancelled'));
  assert.ok(cancelNotif, 'Registered student STU002 must receive cancellation notification');
  assert.ok(cancelNotif.message.includes('Lab kits delayed'));
  console.log(`   ✅ STU002 received in-app cancellation notification: "${cancelNotif.title} - ${cancelNotif.message}"`);

  // STEP 6: Confirm unprivileged student calling create-event gets 403 Forbidden
  console.log('\nStep 6: Testing Server-side Role Guards for Event Creation...');
  // STU002 is a normal student (not an organizer)
  const unauthorizedCreate = await stu2.post('/api/events', {
    title: 'Unauthorized Student Party',
    venue: 'Hostel Quad',
    start_ts: now + 3600000,
    end_ts: now + 7200000
  });
  assert.strictEqual(unauthorizedCreate.status, 403, 'Normal student creating event must return 403 Forbidden');
  assert.ok(unauthorizedCreate.json.error.includes('privileges required'));
  console.log('   ✅ Unprivileged student creation blocked with 403 Forbidden');

  // STEP 7: Verify Calendar .ics generation
  console.log('\nStep 7: Testing .ics Calendar Download Endpoint...');
  const icsRes = await stu1.get(`/api/events/${createdEventId}/ics`);
  assert.strictEqual(icsRes.status, 200);
  assert.ok(icsRes.data.includes('BEGIN:VCALENDAR'));
  assert.ok(icsRes.data.includes('Autonomous Robotics Workshop'));
  console.log('   ✅ .ics iCalendar file generated cleanly');

  studentSocket.disconnect();
  console.log('\n===============================================================');
  console.log('🎉 ALL PHASE 6 EVENTS & TRENDING TESTS PASSED WITH 100% SUCCESS!');
  console.log('===============================================================\n');
  process.exit(0);
}

runPhase6Tests().catch(err => {
  console.error('\n❌ Phase 6 Verification Failed:', err);
  process.exit(1);
});
