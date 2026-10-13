const http = require('http');
const assert = require('assert');
const { db, seedDatabase } = require('./db');
const { normalizePhone, looksLikePhone } = require('./auth');

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

async function runMobileAuthVerification() {
  console.log('===============================================================');
  console.log('🧪 Starting Mobile Number Authentication Verification Suite...');
  console.log('===============================================================\n');

  // Test 1: Unit tests on normalizePhone
  console.log('1. Testing Phone Normalization Function...');
  assert.strictEqual(normalizePhone('9000000001'), '+919000000001');
  assert.strictEqual(normalizePhone('+919000000001'), '+919000000001');
  assert.strictEqual(normalizePhone('+91 90000 00001'), '+919000000001');
  assert.strictEqual(normalizePhone('91-90000-00001'), '+919000000001');
  assert.strictEqual(normalizePhone('09000000001'), '+919000000001');
  assert.strictEqual(normalizePhone('5000000001'), null, 'Must reject numbers starting with < 6');
  assert.strictEqual(normalizePhone('90000001'), null, 'Must reject < 10 digits');
  assert.strictEqual(normalizePhone('900000000001'), null, 'Must reject > 10 digits');
  assert.strictEqual(normalizePhone('STU001'), null, 'Must reject non-phone strings');
  console.log('   ✅ Phone normalization handles all valid formats and rejects invalid ones');

  // Reseed test database for pristine test run
  seedDatabase(true);

  // Test 2: Login by ID works
  console.log('\n2. Testing Login by College ID...');
  const studentSession = createSession();
  const idLoginRes = await studentSession.post('/api/auth/login', {
    uid: 'STU001',
    passkey: 'stu123'
  });
  assert.strictEqual(idLoginRes.status, 200, `Expected 200, got ${idLoginRes.status}`);
  assert.strictEqual(idLoginRes.json.user.uid, 'STU001');
  assert.strictEqual(idLoginRes.json.user.phone, '+919000000001', 'Own phone returned to user on login');
  console.log('   ✅ Login by College ID succeeded (STU001)');

  // Test 3: Login by Phone without +91 works
  console.log('\n3. Testing Login by Phone without +91 (10 digits)...');
  const phoneSession1 = createSession();
  const phoneLoginRes1 = await phoneSession1.post('/api/auth/login', {
    identifier: '9000000001',
    passkey: 'stu123'
  });
  assert.strictEqual(phoneLoginRes1.status, 200, `Expected 200, got ${phoneLoginRes1.status}`);
  assert.strictEqual(phoneLoginRes1.json.user.uid, 'STU001');
  assert.strictEqual(phoneLoginRes1.json.user.name, 'Aarav Sharma');
  console.log('   ✅ Login by 10-digit phone number succeeded (9000000001)');

  // Test 4: Login by Phone with +91 and spaces/dashes works
  console.log('\n4. Testing Login by Phone with +91, spaces and dashes...');
  const phoneSession2 = createSession();
  const phoneLoginRes2 = await phoneSession2.post('/api/auth/login', {
    uid: '+91 90000-00001',
    passkey: 'stu123'
  });
  assert.strictEqual(phoneLoginRes2.status, 200, `Expected 200, got ${phoneLoginRes2.status}`);
  assert.strictEqual(phoneLoginRes2.json.user.uid, 'STU001');
  console.log('   ✅ Login by phone with "+91 90000-00001" succeeded');

  // Test 5: Wrong passkey fails with generic error message
  console.log('\n5. Testing Generic Failure Message on Wrong Passkey...');
  const wrongPassResId = await studentSession.post('/api/auth/login', {
    uid: 'STU001',
    passkey: 'wrongpass123'
  });
  assert.strictEqual(wrongPassResId.status, 401);
  assert.strictEqual(wrongPassResId.json.error, 'Invalid ID/number or passkey');

  const wrongPassResPhone = await studentSession.post('/api/auth/login', {
    identifier: '9000000001',
    passkey: 'wrongpass123'
  });
  assert.strictEqual(wrongPassResPhone.status, 401);
  assert.strictEqual(wrongPassResPhone.json.error, 'Invalid ID/number or passkey');

  const nonExistentPhone = await studentSession.post('/api/auth/login', {
    identifier: '9888888888',
    passkey: 'stu123'
  });
  assert.strictEqual(nonExistentPhone.status, 401);
  assert.strictEqual(nonExistentPhone.json.error, 'Invalid ID/number or passkey');
  console.log('   ✅ Wrong passkey and non-existent identifiers return exact generic message: "Invalid ID/number or passkey"');

  // Test 6: Admin adds member to roster with duplicate phone -> rejected
  console.log('\n6. Testing Duplicate Phone Rejection on Roster Add...');
  const adminSession = createSession();
  const adminLogin = await adminSession.post('/api/auth/login', {
    uid: 'ADMIN001',
    passkey: 'admin123'
  });
  assert.strictEqual(adminLogin.status, 200);

  // Try adding a member with STU001\'s phone
  const dupPhoneRes = await adminSession.post('/api/admin/roster', {
    uid: 'STU099',
    role: 'STUDENT',
    name: 'Duplicate Phone Student',
    dept: 'CSE',
    section: 'CSE-A',
    phone: '9000000001' // already assigned to STU001
  });
  assert.strictEqual(dupPhoneRes.status, 400);
  assert(dupPhoneRes.json.error.includes('already registered'), `Expected already registered error, got: ${dupPhoneRes.json.error}`);

  // Try adding with invalid phone format -> rejected
  const invalidPhoneRes = await adminSession.post('/api/admin/roster', {
    uid: 'STU099',
    role: 'STUDENT',
    name: 'Invalid Phone Student',
    dept: 'CSE',
    section: 'CSE-A',
    phone: '12345'
  });
  assert.strictEqual(invalidPhoneRes.status, 400);
  assert(invalidPhoneRes.json.error.includes('Invalid mobile number'), `Expected invalid mobile error, got: ${invalidPhoneRes.json.error}`);
  console.log('   ✅ Duplicate and invalid phone numbers are strictly rejected with HTTP 400');

  // Test 7: First-time signup with wrong phone fails
  console.log('\n7. Testing Signup with Wrong Phone Number...');
  const signupWrongPhoneRes = await studentSession.post('/api/auth/signup', {
    uid: 'STU101',
    name: 'Demo Student',
    phone: '9999999999', // Roster has 9000000101
    passkey: 'pass123',
    confirmPasskey: 'pass123'
  });
  assert.strictEqual(signupWrongPhoneRes.status, 400);
  assert(signupWrongPhoneRes.json.error.includes('mismatch') || signupWrongPhoneRes.json.error.includes('Invalid'), `Expected mismatch error, got: ${signupWrongPhoneRes.json.error}`);

  // Signup with missing phone when roster has phone -> fails
  const signupMissingPhoneRes = await studentSession.post('/api/auth/signup', {
    uid: 'STU101',
    name: 'Demo Student',
    passkey: 'pass123',
    confirmPasskey: 'pass123'
  });
  assert.strictEqual(signupMissingPhoneRes.status, 400);
  console.log('   ✅ Signup with mismatched or missing phone number is rejected');

  // Test 8: First-time signup with correct matching phone succeeds
  console.log('\n8. Testing Signup with Correct Matching Phone Number...');
  const signupCorrectRes = await studentSession.post('/api/auth/signup', {
    uid: 'STU101',
    name: 'Demo Student',
    phone: '+91 90000-00101', // Roster has +919000000101
    passkey: 'mypass123',
    confirmPasskey: 'mypass123'
  });
  assert.strictEqual(signupCorrectRes.status, 200, `Expected 200, got ${signupCorrectRes.status} (${JSON.stringify(signupCorrectRes.json)})`);
  assert.strictEqual(signupCorrectRes.json.user.uid, 'STU101');
  assert.strictEqual(signupCorrectRes.json.user.phone, '+919000000101');

  // Verify newly registered user can now login with phone!
  const newLoginByPhone = await createSession().post('/api/auth/login', {
    identifier: '9000000101',
    passkey: 'mypass123'
  });
  assert.strictEqual(newLoginByPhone.status, 200);
  assert.strictEqual(newLoginByPhone.json.user.uid, 'STU101');
  console.log('   ✅ Signup with matching phone succeeded; user can immediately log in by phone');

  // Test 9: Student privacy isolation - student cannot see other users\' phone numbers in any API response
  console.log('\n9. Testing Privacy Isolation (Students Cannot See Phone Numbers)...');
  const stu1Session = createSession();
  await stu1Session.post('/api/auth/login', { uid: 'STU001', passkey: 'stu123' });

  // 9a. /api/courses
  const coursesRes = await stu1Session.get('/api/courses');
  assert.strictEqual(coursesRes.status, 200);
  assert(!JSON.stringify(coursesRes.json).includes('+91'), 'Courses API must not leak phone numbers');

  // 9b. /api/courses/CS101/people
  const membersRes = await stu1Session.get('/api/courses/CS101/people');
  assert.strictEqual(membersRes.status, 200);
  assert(!JSON.stringify(membersRes.json).includes('+91'), 'Course members API must not leak phone numbers');
  if (membersRes.json.students) {
    for (const s of membersRes.json.students) {
      assert.strictEqual(s.phone, undefined, 'Student objects must not contain phone');
    }
  }

  // 9c. /api/admin/roster blocked for students
  const studentRosterRes = await stu1Session.get('/api/admin/roster');
  assert.strictEqual(studentRosterRes.status, 403, 'Students must be blocked with 403 from admin roster');

  // 9d. User CAN see their own phone in /api/auth/me
  const meRes = await stu1Session.get('/api/auth/me');
  assert.strictEqual(meRes.status, 200);
  assert.strictEqual(meRes.json.user.phone, '+919000000001', 'User must see their own phone number');

  // 9e. Admin CAN see phone numbers in /api/admin/roster
  const adminRosterRes = await adminSession.get('/api/admin/roster');
  assert.strictEqual(adminRosterRes.status, 200);
  const foundStu001InRoster = adminRosterRes.json.roster.find(r => r.uid === 'STU001');
  assert(foundStu001InRoster, 'STU001 should be in roster');
  assert.strictEqual(foundStu001InRoster.phone, '+919000000001', 'Admin sees normalized phone number');
  console.log('   ✅ Phone numbers strictly isolated: visible only to user profile and admin roster');

  console.log('\n===============================================================');
  console.log('🎉 ALL MOBILE NUMBER AUTHENTICATION TESTS PASSED (100%)!');
  console.log('===============================================================\n');
}

runMobileAuthVerification().catch((err) => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
