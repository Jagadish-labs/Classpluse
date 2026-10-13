const assert = require('assert');
const http = require('http');

const BASE_URL = 'http://localhost:3000';

function fetchUrl(path, cookie = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const headers = {};
    if (cookie) {
      headers['Cookie'] = cookie;
    }

    http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body
        });
      });
    }).on('error', reject);
  });
}

function postJson(path, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const data = JSON.stringify(payload);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];
        let cookie = null;
        if (setCookie && setCookie.length > 0) {
          cookie = setCookie[0].split(';')[0];
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          cookie,
          json: body ? JSON.parse(body) : null
        });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function runVerification() {
  console.log('🚀 Running Landing Page Integration Verification...\n');

  // Test 1: GET / with no cookie -> Landing page (contains "One screen that tells you")
  console.log('1. Testing GET / with no cookie...');
  const resNoCookie = await fetchUrl('/');
  assert.strictEqual(resNoCookie.status, 200, 'GET / must return HTTP 200');
  assert.ok(resNoCookie.body.includes('One screen that tells you'), 'GET / without cookie must contain "One screen that tells you"');
  console.log('   ✅ GET / without cookie returned Landing Page ("One screen that tells you" present)');

  // Test 2: Login to get a valid session cookie
  console.log('\n2. Testing login (POST /api/auth/login)...');
  const loginRes = await postJson('/api/auth/login', { uid: 'STU001', passkey: 'stu123', role: 'STUDENT' });
  assert.strictEqual(loginRes.status, 200, 'Login must succeed with 200');
  assert.ok(loginRes.cookie, 'Login response must set auth cookie');
  console.log(`   ✅ Login succeeded! Received cookie: ${loginRes.cookie}`);

  // Test 3: GET / with a valid session cookie -> App page (contains id="app")
  console.log('\n3. Testing GET / with valid session cookie...');
  const resWithCookie = await fetchUrl('/', loginRes.cookie);
  assert.strictEqual(resWithCookie.status, 200, 'GET / with session must return HTTP 200');
  assert.ok(resWithCookie.body.includes('id="app"'), 'GET / with cookie must return App page (containing id="app")');
  console.log('   ✅ GET / with valid session cookie returned App Page');

  // Test 4: GET /app -> Always returns App page (200)
  console.log('\n4. Testing GET /app...');
  const resApp = await fetchUrl('/app');
  assert.strictEqual(resApp.status, 200, 'GET /app must return HTTP 200');
  assert.ok(resApp.body.includes('id="app"'), 'GET /app must return App page (containing id="app")');
  console.log('   ✅ GET /app returned App Page');

  // Test 5: GET /landing -> Always returns Landing page (200)
  console.log('\n5. Testing GET /landing (even with valid session)...');
  const resLanding = await fetchUrl('/landing', loginRes.cookie);
  assert.strictEqual(resLanding.status, 200, 'GET /landing must return HTTP 200');
  assert.ok(resLanding.body.includes('One screen that tells you'), 'GET /landing must return Landing page');
  console.log('   ✅ GET /landing returned Landing Page');

  // Test 6: GET /api/timetable/today without session -> 401 Unauthorized
  console.log('\n6. Testing GET /api/timetable/today without session...');
  const resUnauthApi = await fetchUrl('/api/timetable/today');
  assert.strictEqual(resUnauthApi.status, 401, 'GET /api/... without session must return HTTP 401');
  console.log('   ✅ GET /api/... without session returned HTTP 401 Unauthorized');

  // Test 7: GET /share -> Loads share page (200)
  console.log('\n7. Testing GET /share...');
  const resShare = await fetchUrl('/share');
  assert.strictEqual(resShare.status, 200, 'GET /share must return HTTP 200');
  assert.ok(resShare.body.includes('ClassPulse Mobile Connect') || resShare.body.includes('QR'), 'GET /share must load share page');
  console.log('   ✅ GET /share loaded successfully');

  console.log('\n===============================================================');
  console.log('🎉 ALL INTEGRATION VERIFICATION TESTS PASSED SUCCESSFULLY!');
  console.log('===============================================================\n');
}

runVerification().catch(err => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
