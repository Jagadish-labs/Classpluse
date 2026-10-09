const http = require('http');
const { io } = require('socket.io-client');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');

function createSession() {
  let cookie = '';

  async function request(method, pathUrl, body = null, headers = {}, isMultipart = false) {
    return new Promise((resolve, reject) => {
      const url = new URL(`http://localhost:3000${pathUrl}`);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: method,
        headers: {
          ...(isMultipart ? {} : { 'Content-Type': 'application/json' }),
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
        if (Buffer.isBuffer(body) || typeof body === 'string') {
          req.write(body);
        } else {
          req.write(JSON.stringify(body));
        }
      }
      req.end();
    });
  }

  return {
    get: (p, h) => request('GET', p, null, h),
    post: (p, b, h, isMulti) => request('POST', p, b, h, isMulti),
    delete: (p, h) => request('DELETE', p, null, h),
    clearCookie: () => { cookie = ''; }
  };
}

// Multipart helper for node http
function makeMultipartBody(fields = {}, fileField = null) {
  const boundary = '----ClassPulseFormBoundary' + Math.random().toString(36).substring(2);
  let chunks = [];

  for (const [key, val] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`));
  }

  if (fileField) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\nContent-Type: ${fileField.contentType || 'application/octet-stream'}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(fileField.content) ? fileField.content : Buffer.from(fileField.content));
    chunks.push(Buffer.from('\r\n'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': body.length
  };

  return { body, headers };
}

async function runClassroomTests() {
  console.log('===============================================================');
  console.log('🧪 Starting ClassPulse Google Classroom & File Verification...');
  console.log('===============================================================\n');

  // STEP 1: Log in Faculty FAC001 and Student STU001
  console.log('Step 1: Authenticating Faculty & Student sessions...');
  const fac = createSession();
  const stu = createSession();

  const facLogin = await fac.post('/api/auth/login', { uid: 'FAC001', passkey: 'fac123', role: 'FACULTY' });
  assert.strictEqual(facLogin.status, 200);

  const stuLogin = await stu.post('/api/auth/login', { uid: 'STU001', passkey: 'stu123', role: 'STUDENT' });
  assert.strictEqual(stuLogin.status, 200);
  console.log('   ✅ FAC001 & STU001 authenticated');

  // STEP 2: Course Access & People tab
  console.log('\nStep 2: Testing Course Access & People Tab...');
  const courseRes = await stu.get('/api/courses/CS101');
  assert.strictEqual(courseRes.status, 200);
  assert.strictEqual(courseRes.json.course.id, 'CS101');

  const peopleRes = await stu.get('/api/courses/CS101/people');
  assert.strictEqual(peopleRes.status, 200);
  assert.strictEqual(peopleRes.json.faculty.uid, 'FAC001');
  assert.ok(peopleRes.json.students.length >= 12);
  console.log(`   ✅ People tab verified: Teacher (${peopleRes.json.faculty.name}) & ${peopleRes.json.students.length} students`);

  // STEP 3: Stream Announcements (Post with attachment, read, delete)
  console.log('\nStep 3: Testing Stream Announcements (Post with file & delete)...');
  const dummyFile = {
    name: 'attachment',
    filename: 'syllabus_update.pdf',
    contentType: 'application/pdf',
    content: 'PDF-1.4 Mock Syllabus Content for CS101'
  };
  const annForm = makeMultipartBody({ text: 'Important: Mid-semester review slides and updated syllabus posted.' }, dummyFile);
  const annPost = await fac.post('/api/courses/CS101/announcements', annForm.body, annForm.headers, true);
  assert.strictEqual(annPost.status, 200);
  const annId = annPost.json.announcementId;
  assert.ok(annId);

  const annList = await stu.get('/api/courses/CS101/announcements');
  assert.strictEqual(annList.status, 200);
  assert.strictEqual(annList.json.announcements[0].id, annId);
  assert.ok(annList.json.announcements[0].attachment_path);
  console.log('   ✅ Announcement created with attached file and read by student (newest first)');

  // Student trying to delete faculty announcement should return 403
  const unauthDel = await stu.delete(`/api/announcements/${annId}`);
  assert.strictEqual(unauthDel.status, 403, 'Student cannot delete faculty announcements');
  console.log('   ✅ Unauthorized deletion of announcement blocked with 403');

  // Faculty can delete own announcement
  const authDel = await fac.delete(`/api/announcements/${annId}`);
  assert.strictEqual(authDel.status, 200);
  console.log('   ✅ Faculty deleted announcement successfully');

  // STEP 4: Classwork Materials & Assignments
  console.log('\nStep 4: Testing Classwork Creation (Materials & Assignments)...');
  const matForm = makeMultipartBody({
    title: 'Lab 4 Setup Guide',
    description: 'Docker and GCC compiler toolchain setup instructions.',
    link_url: 'https://docs.college.edu/cs101/lab4'
  });
  const matRes = await fac.post('/api/courses/CS101/materials', matForm.body, matForm.headers, true);
  assert.strictEqual(matRes.status, 200);
  const matId = matRes.json.materialId;

  // Post assignment due in 3 days
  const assForm = makeMultipartBody({
    title: 'Lab 4: Binary Trees & Heaps',
    instructions: 'Implement Min-Heap and Max-Heap priority queues in C++.',
    due_date: new Date(Date.now() + 3 * 86400000).toISOString(),
    max_points: 100
  });
  const assPost = await fac.post('/api/courses/CS101/assignments', assForm.body, assForm.headers, true);
  assert.strictEqual(assPost.status, 200);
  const lab4Id = assPost.json.assignmentId;
  console.log(`   ✅ Material (ID: ${matId}) & Assignment (ID: ${lab4Id}) created`);

  // STEP 5: Student Submissions & File Replacement
  console.log('\nStep 5: Testing Student Submissions & Safe File Replacement...');
  const subFile1 = {
    name: 'submission_file',
    filename: 'STU001_Lab4_draft.zip',
    contentType: 'application/zip',
    content: 'PK_MOCK_ZIP_CONTENT_V1'
  };
  const subForm1 = makeMultipartBody({ text_submission: 'Initial draft submission with heap header files.' }, subFile1);
  const subRes1 = await stu.post(`/api/assignments/${lab4Id}/submit`, subForm1.body, subForm1.headers, true);
  assert.strictEqual(subRes1.status, 200);
  assert.strictEqual(subRes1.json.status, 'Submitted');

  // Verify file saved on disk
  const subRecord1 = db.prepare('SELECT file_path FROM submissions WHERE assignment_id = ? AND student_id = ?').get(lab4Id, 'STU001');
  const savedFile1 = path.join(__dirname, 'uploads', path.basename(subRecord1.file_path));
  assert.ok(fs.existsSync(savedFile1), 'Uploaded file 1 must exist on disk');
  console.log('   ✅ Initial submission saved with file on disk');

  // Resubmit with new file -> verify old file is deleted from disk
  const subFile2 = {
    name: 'submission_file',
    filename: 'STU001_Lab4_final.zip',
    contentType: 'application/zip',
    content: 'PK_MOCK_ZIP_CONTENT_V2_COMPLETE'
  };
  const subForm2 = makeMultipartBody({ text_submission: 'Final complete implementation with benchmark tests.' }, subFile2);
  const subRes2 = await stu.post(`/api/assignments/${lab4Id}/submit`, subForm2.body, subForm2.headers, true);
  assert.strictEqual(subRes2.status, 200);

  // Check old file deleted and new file exists
  assert.ok(!fs.existsSync(savedFile1), 'Old replaced submission file must be deleted from disk');
  const subRecord2 = db.prepare('SELECT file_path FROM submissions WHERE assignment_id = ? AND student_id = ?').get(lab4Id, 'STU001');
  const savedFile2 = path.join(__dirname, 'uploads', path.basename(subRecord2.file_path));
  assert.ok(fs.existsSync(savedFile2), 'New submission file 2 must exist on disk');
  console.log('   ✅ Replaced old submission file deleted from disk; new file saved');

  // STEP 6: Faculty Grading & In-App Notification
  console.log('\nStep 6: Testing Faculty Grading, Return & Student Notification...');
  const subListRes = await fac.get(`/api/assignments/${lab4Id}/submissions`);
  assert.strictEqual(subListRes.status, 200);
  const stuSub = subListRes.json.submissions.find(s => s.student_uid === 'STU001');
  assert.ok(stuSub);

  const gradeRes = await fac.post(`/api/submissions/${stuSub.id}/grade`, {
    points: 98,
    feedback: 'Outstanding implementation and memory profiling.'
  });
  assert.strictEqual(gradeRes.status, 200);
  console.log('   ✅ Faculty graded submission: 98/100 with feedback');

  // Verify student received notification
  const notifRes = await stu.get('/api/notifications');
  assert.strictEqual(notifRes.status, 200);
  const gradeNotif = notifRes.json.notifications.find(n => n.title.includes('Grade Returned') && n.title.includes('Lab 4'));
  assert.ok(gradeNotif, 'Student must receive Grade Returned notification');
  assert.ok(gradeNotif.message.includes('98/100'));
  console.log(`   ✅ Student received notification: "${gradeNotif.title} - ${gradeNotif.message}"`);

  // STEP 7: Student Dashboard Summary (To-Do & Attendance Alerts)
  console.log('\nStep 7: Testing Student Dashboard Summary (To-Do list & Attendance Alerts)...');
  const dashRes = await stu.get('/api/student/dashboard-summary');
  assert.strictEqual(dashRes.status, 200);
  assert.ok(Array.isArray(dashRes.json.todo));
  assert.ok(dashRes.json.todo.length <= 5);
  console.log(`   ✅ Student dashboard summary returned (${dashRes.json.todo.length} pending to-do items)`);

  // STEP 8: Protected File Access & Path Traversal Guard
  console.log('\nStep 8: Testing Safe Protected File Serving & Security Guards...');
  const filenameOnly = path.basename(subRecord2.file_path);

  // Author student can download
  const stuFileDl = await stu.get(`/api/files/${filenameOnly}`);
  assert.strictEqual(stuFileDl.status, 200);
  assert.strictEqual(stuFileDl.data, 'PK_MOCK_ZIP_CONTENT_V2_COMPLETE');
  console.log('   ✅ Authorized student downloaded own submission file');

  // Teaching faculty can download
  const facFileDl = await fac.get(`/api/files/${filenameOnly}`);
  assert.strictEqual(facFileDl.status, 200);
  console.log('   ✅ Course faculty downloaded student submission file');

  // Other student (not author of this submission) cannot access private submission file
  const otherStu = createSession();
  const otherLogin = await otherStu.post('/api/auth/login', { uid: 'STU003', passkey: 'stu123', role: 'STUDENT' });
  assert.strictEqual(otherLogin.status, 200, 'STU003 should log in successfully');
  const otherDl = await otherStu.get(`/api/files/${filenameOnly}`);
  assert.strictEqual(otherDl.status, 403, 'Other student accessing classmate private file must return 403');
  console.log('   ✅ Other student blocked from downloading classmate private submission with 403');

  // Path traversal attempt (encoded)
  const pathTraversal = await stu.get('/api/files/%2e%2e%2f%2e%2e%2fpackage.json');
  assert.strictEqual(pathTraversal.status, 403, 'Path traversal must return 403 Forbidden');
  console.log('   ✅ Path traversal attempt blocked with 403 Forbidden');

  console.log('\n===============================================================');
  console.log('🎉 ALL CLASSROOM & SAFE FILE UPLOAD TESTS PASSED WITH 100%!');
  console.log('===============================================================\n');
  process.exit(0);
}

runClassroomTests().catch(err => {
  console.error('\n❌ Classroom Verification Failed:', err);
  process.exit(1);
});
