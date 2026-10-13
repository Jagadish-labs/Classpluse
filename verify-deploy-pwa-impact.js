const http = require('http');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

async function runDeployPwaImpactVerification() {
  console.log('===============================================================');
  console.log('🚀 Running Deploy + PWA + Impact Automated Verifications');
  console.log('===============================================================\n');

  const anon = createSession();

  // 1. Check /healthz
  console.log('1. Testing GET /healthz (Unauthenticated)...');
  const healthzRes = await anon.get('/healthz');
  assert.strictEqual(healthzRes.status, 200, '/healthz must return HTTP 200');
  assert.deepStrictEqual(healthzRes.json, { ok: true }, '/healthz must return { ok: true }');
  console.log('   ✅ GET /healthz returned { ok: true }');

  // 2. Check /api/health (existing compatibility)
  console.log('\n2. Testing GET /api/health...');
  const healthRes = await anon.get('/api/health');
  assert.strictEqual(healthRes.status, 200);
  assert.strictEqual(healthRes.json.status, 'ok');
  console.log('   ✅ GET /api/health returned ok with class count:', healthRes.json.classesCount);

  // 3. Check PWA Manifest
  console.log('\n3. Testing PWA Web App Manifest (/manifest.webmanifest)...');
  const manifestRes = await anon.get('/manifest.webmanifest');
  assert.strictEqual(manifestRes.status, 200, 'Manifest must return 200');
  assert.ok(manifestRes.json, 'Manifest must be valid JSON');
  assert.strictEqual(manifestRes.json.name, 'ClassPulse');
  assert.strictEqual(manifestRes.json.short_name, 'ClassPulse');
  assert.strictEqual(manifestRes.json.start_url, '/');
  assert.strictEqual(manifestRes.json.display, 'standalone');
  assert.strictEqual(manifestRes.json.theme_color, '#4f46e5');
  assert.strictEqual(manifestRes.json.background_color, '#ffffff');
  assert.ok(Array.isArray(manifestRes.json.icons), 'Manifest must contain icons array');
  const has192 = manifestRes.json.icons.some(i => i.sizes === '192x192');
  const has512 = manifestRes.json.icons.some(i => i.sizes === '512x512');
  assert.ok(has192, 'Manifest must contain 192 icon');
  assert.ok(has512, 'Manifest must contain 512 icon');
  console.log('   ✅ Manifest valid with theme #4f46e5 and icons 192/512');

  // 4. Check PWA Icons on disk
  console.log('\n4. Verifying PWA Icons in public/icons/...');
  const icon192 = path.join(__dirname, 'public', 'icons', 'icon-192.png');
  const icon512 = path.join(__dirname, 'public', 'icons', 'icon-512.png');
  assert.ok(fs.existsSync(icon192), 'icon-192.png must exist');
  assert.ok(fs.existsSync(icon512), 'icon-512.png must exist');
  assert.ok(fs.statSync(icon192).size > 500, 'icon-192.png must be non-empty valid image');
  assert.ok(fs.statSync(icon512).size > 1000, 'icon-512.png must be non-empty valid image');
  console.log('   ✅ icon-192.png (', fs.statSync(icon192).size, 'bytes) and icon-512.png (', fs.statSync(icon512).size, 'bytes) verified');

  // 5. Check Service Worker
  console.log('\n5. Testing Service Worker (/sw.js)...');
  const swRes = await anon.get('/sw.js');
  assert.strictEqual(swRes.status, 200, '/sw.js must return 200');
  assert.ok(swRes.data.includes('classpulse-shell-v'), 'SW contains shell cache name');
  assert.ok(swRes.data.includes('/api/'), 'SW contains API intercept logic');
  assert.ok(swRes.data.includes('You are offline. Reconnect to see live class status.'), 'SW contains offline fallback page');
  console.log('   ✅ Service Worker properly configured with offline page and network pass-through');

  // 6. Test Impact Dashboard API Security
  console.log('\n6. Testing /api/admin/impact Security & Permissions...');
  const unauthImpact = await anon.get('/api/admin/impact');
  assert.strictEqual(unauthImpact.status, 401, 'Unauthenticated request must be rejected with 401');

  // Login Student STU001
  const studentSession = createSession();
  await studentSession.post('/api/auth/login', { uid: 'STU001', passkey: 'stu123', role: 'STUDENT' });
  const studentImpact = await studentSession.get('/api/admin/impact');
  assert.strictEqual(studentImpact.status, 403, 'Student request to impact must be rejected with 403');
  console.log('   ✅ 401 unauth and 403 student protection verified for impact API');

  // Login Admin ADMIN001
  const adminSession = createSession();
  const adminLogin = await adminSession.post('/api/auth/login', { uid: 'ADMIN001', passkey: 'admin123', role: 'ADMIN' });
  assert.strictEqual(adminLogin.status, 200, 'Admin login should succeed');

  const adminImpact = await adminSession.get('/api/admin/impact');
  assert.strictEqual(adminImpact.status, 200, 'Admin request to impact must succeed');
  const m = adminImpact.json;
  console.log('\n7. Verifying Real Impact Metrics Computed:');
  console.log('   - Class Status Updates Today:', m.updatesToday);
  console.log('   - Class Status Updates This Week:', m.updatesThisWeek);
  console.log('   - Lifetime Persistent Counter:', m.totalUpdates);
  console.log('   - Student Minutes Saved Today:', m.minutesSavedToday);
  console.log('   - Student Minutes Saved This Week:', m.minutesSavedThisWeek);
  console.log('   - Assignments On-Time vs Late:', `${m.assignmentsOnTime} on-time vs ${m.assignmentsLate} late`);
  console.log('   - Avg Attendance & Students <75%:', `${m.avgAttendance}% avg (${m.studentsBelow75} students <75%)`);
  console.log('   - Event Regs & Check-ins This Week:', `${m.eventRegistrationsThisWeek} regs, ${m.eventCheckinsThisWeek} check-ins`);
  console.log('   - Assumption text:', m.assumption);

  assert.ok(m.updatesThisWeek > 0, 'updatesThisWeek must be > 0');
  assert.ok(m.minutesSavedThisWeek > 0, 'minutesSavedThisWeek must be > 0');
  assert.ok(m.assignmentsOnTime > 0, 'assignmentsOnTime must be > 0');
  assert.ok(m.avgAttendance > 0, 'avgAttendance must be > 0');
  assert.ok(m.eventRegistrationsThisWeek > 0, 'eventRegistrationsThisWeek must be > 0');
  assert.ok(m.assumption.includes('Delayed') && m.assumption.includes('Absent'), 'assumption text must explain wait time formula');
  console.log('   ✅ All impact metrics populated with real computed data');

  // 8. Test Status Update mutates Minutes Saved and Counter
  console.log('\n8. Testing Live Status Update impact mutation...');
  const initialCounter = m.totalUpdates;
  const initialMins = m.minutesSavedThisWeek;

  const facultySession = createSession();
  await facultySession.post('/api/auth/login', { uid: 'FAC001', passkey: 'fac123', role: 'FACULTY' });

  // Update status of period 1 (CS101) to Delayed
  const updateRes = await facultySession.post('/api/timetable/status', {
    timetableId: 1,
    st: 'delayed',
    note: 'Traffic on highway'
  });
  assert.strictEqual(updateRes.status, 200, 'Faculty status update should succeed');

  const afterImpact = await adminSession.get('/api/admin/impact');
  assert.strictEqual(afterImpact.status, 200);
  assert.strictEqual(afterImpact.json.totalUpdates, initialCounter + 1, 'Counter must increment by 1');
  assert.ok(afterImpact.json.minutesSavedThisWeek >= initialMins + 120, 'Delayed update should add at least 120 minutes saved (12 students * 10 mins)');
  console.log('   ✅ Counter incremented to', afterImpact.json.totalUpdates, 'and minutes saved increased by +', afterImpact.json.minutesSavedThisWeek - initialMins);

  // 9. Verify deployment files
  console.log('\n9. Checking deployment configuration files...');
  assert.ok(fs.existsSync(path.join(__dirname, 'Dockerfile')), 'Dockerfile must exist');
  assert.ok(fs.existsSync(path.join(__dirname, '.dockerignore')), '.dockerignore must exist');
  assert.ok(fs.existsSync(path.join(__dirname, 'render.yaml')), 'render.yaml must exist');
  const dockerfileContent = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf-8');
  assert.ok(dockerfileContent.includes('node:20-alpine'), 'Dockerfile must use node:20-alpine');
  assert.ok(dockerfileContent.includes('npm ci --omit=dev'), 'Dockerfile must use npm ci --omit=dev');
  assert.ok(dockerfileContent.includes('EXPOSE 3000'), 'Dockerfile must expose 3000');
  assert.ok(dockerfileContent.includes('CMD ["npm", "start"]'), 'Dockerfile must CMD npm start');

  const dockerignoreContent = fs.readFileSync(path.join(__dirname, '.dockerignore'), 'utf-8');
  assert.ok(dockerignoreContent.includes('node_modules'), '.dockerignore must contain node_modules');
  assert.ok(dockerignoreContent.includes('data.json'), '.dockerignore must contain data.json');
  assert.ok(dockerignoreContent.includes('uploads'), '.dockerignore must contain uploads');

  const renderYamlContent = fs.readFileSync(path.join(__dirname, 'render.yaml'), 'utf-8');
  assert.ok(renderYamlContent.includes('/healthz'), 'render.yaml must have /healthz healthCheckPath');
  assert.ok(renderYamlContent.includes('SECRET'), 'render.yaml must configure SECRET');
  assert.ok(renderYamlContent.includes('DEMO'), 'render.yaml must configure DEMO');
  console.log('   ✅ Dockerfile, .dockerignore, and render.yaml verified');

  console.log('\n🎉 ALL DEPLOY + PWA + IMPACT VERIFICATION TESTS PASSED SUCCESSFULLY!\n');
}

runDeployPwaImpactVerification().catch((err) => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
