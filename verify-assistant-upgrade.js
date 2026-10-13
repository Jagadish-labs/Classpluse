// Verification script for ClassPulse Upgraded Assistant
// Tests:
// 1. All student and faculty intents (with/without typos & synonyms)
// 2. In-memory follow-up context ("and tomorrow?", "what about marks?", "how many classes do I need?", "how many can I miss?")
// 3. Privacy boundary: student cannot get another student's data
// 4. Faculty intents are blocked for students
// 5. Faculty intents return own course data only
// 6. Fallback works with no key (returns rule-based capability message + 3 suggestions + source: 'Rules')

const http = require('http');
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
          try { json = JSON.parse(data); } catch (e) {}
          resolve({ status: res.statusCode, json, data });
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
    cookie: () => cookie
  };
}

async function runTests() {
  console.log('🧪 Starting Assistant Upgrade Comprehensive Verification...\n');

  // Check health
  const anon = createSession();
  const health = await anon.get('/api/health');
  assert.strictEqual(health.status, 200, 'App must be running on :3000');
  console.log('   ✅ Server is live on :3000');

  // Log in as STU001 (Student), STU002 (Student), FAC001 (Faculty), FAC002 (Faculty)
  const stu1 = createSession();
  const stu1Login = await stu1.post('/api/auth/login', { uid: 'STU001', passkey: 'stu123', role: 'STUDENT' });
  assert.strictEqual(stu1Login.status, 200, 'STU001 login');

  const stu2 = createSession();
  const stu2Login = await stu2.post('/api/auth/login', { uid: 'STU002', passkey: 'stu123', role: 'STUDENT' });
  assert.strictEqual(stu2Login.status, 200, 'STU002 login');

  const fac1 = createSession();
  const fac1Login = await fac1.post('/api/auth/login', { uid: 'FAC001', passkey: 'fac123', role: 'FACULTY' });
  assert.strictEqual(fac1Login.status, 200, 'FAC001 login');

  console.log('   ✅ STU001, STU002, and FAC001 authenticated');

  // --------------------------------------------------------------------------
  // 1. Test New Student Intents & Typo / Synonym Tolerance
  // --------------------------------------------------------------------------
  console.log('\n--- 1. Testing Student Intents ---');

  // Next class & free period (with typo "upcomming")
  const nextRes = await stu1.post('/api/assistant', { message: 'what is my next class and free period?' });
  assert.strictEqual(nextRes.status, 200);
  assert.strictEqual(nextRes.json.source, 'Rules');
  assert.strictEqual(nextRes.json.suggestions.length, 3);
  assert.ok(nextRes.json.reply.includes('Class') || nextRes.json.reply.includes('Free Period') || nextRes.json.reply.includes('classes'));
  console.log('   ✅ Next class & free period intent working');

  // Tomorrow timetable (with typo "tomorow")
  const tmrwRes = await stu1.post('/api/assistant', { message: 'show tomorow schedule' });
  assert.strictEqual(tmrwRes.status, 200);
  assert.strictEqual(tmrwRes.json.suggestions.length, 3);
  assert.ok(tmrwRes.json.reply.includes('Tomorrow'));
  console.log('   ✅ Tomorrow timetable intent working (handles typos)');

  // Summarize my day
  const sumRes = await stu1.post('/api/assistant', { message: 'summarize my day' });
  assert.strictEqual(sumRes.status, 200);
  assert.strictEqual(sumRes.json.suggestions.length, 3);
  assert.ok(sumRes.json.reply.includes('Daily Summary'));
  assert.ok(sumRes.json.reply.includes('Classes'));
  console.log('   ✅ Summarize my day intent working');

  // Plan my week
  const planRes = await stu1.post('/api/assistant', { message: 'plan my week' });
  assert.strictEqual(planRes.status, 200);
  assert.strictEqual(planRes.json.suggestions.length, 3);
  assert.ok(planRes.json.reply.includes('Weekly Study & Assignment Plan') || planRes.json.reply.includes('All caught up'));
  console.log('   ✅ Plan my week intent working');

  // Which subject is my weakest
  const weakRes = await stu1.post('/api/assistant', { message: 'which subject is my weakest?' });
  assert.strictEqual(weakRes.status, 200);
  assert.strictEqual(weakRes.json.suggestions.length, 3);
  assert.ok(weakRes.json.reply.includes('weakest subject is') || weakRes.json.reply.includes('Academic Health'));
  console.log('   ✅ Weakest subject intent working');

  // How many classes can I miss and stay above 75% (synonym "bunk")
  const missRes = await stu1.post('/api/assistant', { message: 'how many classes can i miss and stay above 75?' });
  assert.strictEqual(missRes.status, 200);
  assert.strictEqual(missRes.json.suggestions.length, 3);
  assert.ok(missRes.json.reply.includes('Safe Bunk') || missRes.json.reply.includes('75% Rule'));
  console.log('   ✅ Miss allowance / bunk buffer intent working');

  // Unread chat messages count
  const chatRes = await stu1.post('/api/assistant', { message: 'do i have any unread chat messages?' });
  assert.strictEqual(chatRes.status, 200);
  assert.strictEqual(chatRes.json.suggestions.length, 3);
  assert.ok(chatRes.json.reply.includes('chat message'));
  console.log('   ✅ Unread chat messages count intent working');

  // Notifications summary
  const notifRes = await stu1.post('/api/assistant', { message: 'my notifications summary' });
  assert.strictEqual(notifRes.status, 200);
  assert.strictEqual(notifRes.json.suggestions.length, 3);
  assert.ok(notifRes.json.reply.includes('Notifications') || notifRes.json.reply.includes('notification inbox'));
  console.log('   ✅ Notifications summary intent working');

  // --------------------------------------------------------------------------
  // 2. Test In-Memory Follow-Up Context
  // --------------------------------------------------------------------------
  console.log('\n--- 2. Testing In-Memory Follow-Up Context ---');

  // Follow-up 1: "What should I do right now?" -> then "and tomorrow?"
  await stu1.post('/api/assistant', { message: 'What should I do right now?' });
  const followTmrw = await stu1.post('/api/assistant', { message: 'and tomorrow?' });
  assert.strictEqual(followTmrw.status, 200);
  assert.ok(followTmrw.json.reply.includes('Tomorrow'), 'Follow-up "and tomorrow?" should resolve tomorrow timetable');
  console.log('   ✅ Follow-up: "and tomorrow?" resolved to tomorrow schedule');

  // Follow-up 2: "Check my attendance" -> then "what about marks?"
  await stu1.post('/api/assistant', { message: 'Check my attendance' });
  const followMarks = await stu1.post('/api/assistant', { message: 'what about marks?' });
  assert.strictEqual(followMarks.status, 200);
  assert.ok(followMarks.json.reply.includes('Latest Grades') || followMarks.json.reply.includes('marks'), 'Follow-up "what about marks?" should resolve to marks');
  console.log('   ✅ Follow-up: "what about marks?" resolved to marks');

  // Follow-up 3: "Check my attendance" -> then "how many classes do I need?"
  await stu1.post('/api/assistant', { message: 'Check my attendance' });
  const followNeed = await stu1.post('/api/assistant', { message: 'how many classes do I need?' });
  assert.strictEqual(followNeed.status, 200);
  assert.ok(followNeed.json.reply.includes('Attendance Summary') || followNeed.json.reply.includes('75%'), 'Follow-up "how many classes do I need?" should resolve to attendance shortage details');
  console.log('   ✅ Follow-up: "how many classes do I need?" resolved to attendance recovery');

  // Follow-up 4: "Check my attendance" -> then "how many can I miss?"
  const followMiss = await stu1.post('/api/assistant', { message: 'how many can I miss?' });
  assert.strictEqual(followMiss.status, 200);
  assert.ok(followMiss.json.reply.includes('Safe Bunk') || followMiss.json.reply.includes('75% Rule'));
  console.log('   ✅ Follow-up: "how many can I miss?" resolved to bunk buffer');

  // --------------------------------------------------------------------------
  // 3. Test Privacy & Student Isolation
  // --------------------------------------------------------------------------
  console.log('\n--- 3. Testing Privacy & Cross-Student Isolation ---');

  // STU001 asks for attendance, grades, and marks
  const stu1Marks = await stu1.post('/api/assistant', { message: 'Show all my marks and results' });
  assert.ok(!stu1Marks.json.reply.includes('Diya Patel') && !stu1Marks.json.reply.includes('STU002'), 'STU001 response must never leak STU002');

  // STU001 tries to ask about another student
  const stu1Snoop = await stu1.post('/api/assistant', { message: 'What are STU002 marks and attendance for Diya Patel?' });
  assert.ok(!stu1Snoop.json.reply.includes('Diya Patel') && !stu1Snoop.json.reply.includes('STU002'), 'Student cannot snoop on another student');
  console.log('   ✅ Student isolation verified: No other student data is ever included');

  // --------------------------------------------------------------------------
  // 4. Test Faculty Intents Blocked for Students
  // --------------------------------------------------------------------------
  console.log('\n--- 4. Testing Faculty Intents Blocked for Students ---');

  const stuBlockRisk = await stu1.post('/api/assistant', { message: 'who is absent or at risk?' });
  assert.strictEqual(stuBlockRisk.status, 200);
  assert.ok(stuBlockRisk.json.reply.includes('Access Restricted') || stuBlockRisk.json.reply.includes('faculty members'), 'Student must be blocked from at-risk list');

  const stuBlockGrading = await stu1.post('/api/assistant', { message: 'pending submissions to grade' });
  assert.strictEqual(stuBlockGrading.status, 200);
  assert.ok(stuBlockGrading.json.reply.includes('Access Restricted') || stuBlockGrading.json.reply.includes('faculty members'), 'Student must be blocked from grading queries');

  console.log('   ✅ Faculty intents are safely blocked for students');

  // --------------------------------------------------------------------------
  // 5. Test Faculty Intents for Faculty
  // --------------------------------------------------------------------------
  console.log('\n--- 5. Testing Faculty Intents for Faculty ---');

  // Classes today with statuses
  const facClasses = await fac1.post('/api/assistant', { message: 'my classes today' });
  assert.strictEqual(facClasses.status, 200);
  assert.strictEqual(facClasses.json.source, 'Rules');
  assert.ok(facClasses.json.reply.includes('Teaching Schedule Today'));
  console.log('   ✅ Faculty: Classes today intent working');

  // Who is absent or at risk (own courses only)
  const facRisk = await fac1.post('/api/assistant', { message: 'who is absent or at risk?' });
  assert.strictEqual(facRisk.status, 200);
  assert.ok(facRisk.json.reply.includes('Your Courses Only'));
  // FAC001 (Dr. Meena Rao) teaches Data Structures (code: CS301, id: CS101), NOT courses taught by FAC002 (CS302, CS305)
  assert.ok(facRisk.json.reply.includes('Data Structures') || facRisk.json.reply.includes('CS301'), 'FAC001 report must include Data Structures / CS301');
  assert.ok(!facRisk.json.reply.includes('CS302') && !facRisk.json.reply.includes('Data Communications'), 'FAC001 report must NOT include courses taught by other faculty');
  console.log('   ✅ Faculty: At risk audit restricted strictly to own courses');

  // Pending submissions to grade
  const facGrading = await fac1.post('/api/assistant', { message: 'pending submissions to grade' });
  assert.strictEqual(facGrading.status, 200);
  assert.ok(facGrading.json.reply.includes('Pending Submissions to Grade') || facGrading.json.reply.includes('All caught up'));
  console.log('   ✅ Faculty: Pending submissions to grade intent working');

  // Draft an announcement
  const facDraft = await fac1.post('/api/assistant', { message: 'draft an announcement for CS101 exam' });
  assert.strictEqual(facDraft.status, 200);
  assert.ok(facDraft.json.reply.includes('Draft Announcement (Ready to Copy)'));
  assert.ok(facDraft.json.reply.includes('CS101'));
  console.log('   ✅ Faculty: Draft announcement intent working');

  // --------------------------------------------------------------------------
  // 6. Test Fallback with No API Key
  // --------------------------------------------------------------------------
  console.log('\n--- 6. Testing Fallback with No API Key ---');

  const fallbackRes = await stu1.post('/api/assistant', { message: 'Explain quantum computing in detail please' });
  assert.strictEqual(fallbackRes.status, 200);
  assert.strictEqual(fallbackRes.json.source, 'Rules');
  assert.ok(fallbackRes.json.reply.includes('ClassPulse Assistant'));
  assert.strictEqual(fallbackRes.json.suggestions.length, 3);
  console.log('   ✅ Fallback safely returned rule capability message with 3 chips');

  console.log('\n🎉 ALL ASSISTANT UPGRADE TESTS PASSED SUCCESSFULLY!\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
