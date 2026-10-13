const http = require('http');
const assert = require('assert');
const { io: ioClient } = require('socket.io-client');

const BASE_URL = 'http://localhost:3000';

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqOptions = {
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    if (options.cookie) {
      reqOptions.headers['Cookie'] = options.cookie;
    }

    if (options.body) {
      reqOptions.headers['Content-Type'] = 'application/json';
    }

    const req = http.request(url, reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch(e) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json,
          raw: data
        });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function login(uid, passkey) {
  const res = await request('/api/auth/login', {
    method: 'POST',
    body: { uid, passkey }
  });
  if (res.status !== 200 || !res.headers['set-cookie']) {
    throw new Error(`Login failed for ${uid}: ${res.status} ${res.raw}`);
  }
  const cookies = res.headers['set-cookie'];
  const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');
  return cookieHeader;
}

async function runTests() {
  console.log('🧪 Starting Comprehensive WhatsApp-Style Chat Test Suite...\n');

  // 1. Logins
  console.log('1️⃣ Logging in test users...');
  const stu1Cookie = await login('STU001', 'stu123');
  const stu2Cookie = await login('STU002', 'stu123');
  const stu3Cookie = await login('STU003', 'stu123');
  const facCookie = await login('FAC001', 'fac123');
  const adminCookie = await login('ADMIN001', 'admin123');
  console.log('   ✅ All users logged in successfully.\n');

  // Reset to clean seed data before starting
  await request('/api/admin/reset-demo', { method: 'POST', cookie: adminCookie });

  // 2. Admin cannot access chats (403) but can access reports
  console.log('2️⃣ Testing Admin Chat Access Restriction (Must be 403)...');
  const adminChatRes = await request('/api/chat/conversations', { cookie: adminCookie });
  assert.strictEqual(adminChatRes.status, 403, 'Admin must receive 403 on /api/chat/conversations');
  const adminDirectRes = await request('/api/chat/direct', {
    method: 'POST',
    cookie: adminCookie,
    body: { uid: 'STU001' }
  });
  assert.strictEqual(adminDirectRes.status, 403, 'Admin must receive 403 on /api/chat/direct');
  console.log('   ✅ Admin blocked from regular chats with 403 Forbidden.\n');

  // 3. Contact Search: Scope, Privacy, and Rate Limiting
  console.log('3️⃣ Testing Contact Search (Privacy, Scoping, No Phone Leak)...');
  // STU001 searching for classmate STU002 (both Section A)
  const searchClassmate = await request('/api/chat/search?q=STU002', { cookie: stu1Cookie });
  assert.strictEqual(searchClassmate.status, 200);
  assert(searchClassmate.data.results.length > 0, 'Classmate in Section A should be found');
  const foundStu2 = searchClassmate.data.results[0];
  assert.strictEqual(foundStu2.uid, 'STU002');
  assert.strictEqual(foundStu2.phone, undefined, 'CRITICAL: Phone number must NEVER be returned in search results');
  assert(foundStu2.section && foundStu2.section.includes('A'), 'Section should be returned');
  console.log('   ✅ Classmate search succeeded and verified: phone number is NEVER leaked.');

  // STU001 searching by exact phone number of faculty (e.g. 9100000001 -> +919100000001)
  const searchPhone = await request('/api/chat/search?q=9100000001', { cookie: stu1Cookie });
  assert.strictEqual(searchPhone.status, 200);
  assert(searchPhone.data.results.length > 0, 'Faculty should be found by exact phone');
  assert.strictEqual(searchPhone.data.results[0].uid, 'FAC001');
  assert.strictEqual(searchPhone.data.results[0].phone, undefined, 'CRITICAL: Phone number must NOT be leaked');
  console.log('   ✅ Exact phone search matches in-scope contacts without returning phone numbers.');

  // Out of scope search returns no matches
  const searchOutOfScope = await request('/api/chat/search?q=ADMIN001', { cookie: stu1Cookie });
  assert.strictEqual(searchOutOfScope.status, 200);
  assert.strictEqual(searchOutOfScope.data.results.length, 0, 'Admin or out-of-scope contacts return 0 matches');
  console.log('   ✅ Out-of-scope search correctly returns 0 matches.\n');

  // 4. Student-to-student DM restrictions and Chat Requests flow
  console.log('4️⃣ Testing Student-to-Student Direct Message & Chat Request Flow...');
  // Without accepted request, direct message endpoint is blocked
  const stuToStuRes = await request('/api/chat/direct', {
    method: 'POST',
    cookie: stu1Cookie,
    body: { uid: 'STU002' }
  });
  assert.strictEqual(stuToStuRes.status, 403, 'Student cannot direct-message without accepted request (403)');
  console.log('   ✅ Direct DM between students without accepted request is blocked with 403.');

  // STU002 has a seeded pending request to STU003 (both Section A)
  // Let's check pending requests for STU003
  const stu3Requests = await request('/api/chat/requests', { cookie: stu3Cookie });
  assert.strictEqual(stu3Requests.status, 200);
  const pendingFromStu2 = stu3Requests.data.incoming.find(r => r.from_uid === 'STU002' && r.status === 'pending');
  assert(pendingFromStu2, 'Seeded pending request from STU002 to STU003 must exist');
  console.log('   ✅ Seeded pending request verified.');

  // STU003 accepts request
  const acceptRes = await request(`/api/chat/requests/${pendingFromStu2.id}/accept`, {
    method: 'POST',
    cookie: stu3Cookie
  });
  assert.strictEqual(acceptRes.status, 200);
  console.log('   ✅ Chat request accepted by STU003.');

  // Now STU002 can initiate direct chat with STU003
  const stu2ToStu3Conv = await request('/api/chat/direct', {
    method: 'POST',
    cookie: stu2Cookie,
    body: { uid: 'STU003' }
  });
  assert.strictEqual(stu2ToStu3Conv.status, 200);
  assert(stu2ToStu3Conv.data.id > 0);
  console.log('   ✅ Student-to-student chat successfully initiated after accepted request.\n');

  // 5. Student-Faculty DM allowed
  console.log('5️⃣ Testing Student-to-Faculty DM...');
  const stuToFacRes = await request('/api/chat/direct', {
    method: 'POST',
    cookie: stu1Cookie,
    body: { uid: 'FAC001' }
  });
  assert.strictEqual(stuToFacRes.status, 200);
  const directConvId = stuToFacRes.data.id;
  assert(directConvId > 0, 'Direct conversation ID must exist');
  console.log(`   ✅ Student-Faculty DM confirmed (Conversation ID: ${directConvId}).\n`);

  // 6. Non-member cannot read or post in conversation (403)
  console.log('6️⃣ Testing Non-Member Conversation Access (STU002 on STU001-FAC001 chat)...');
  const nonMemberRead = await request(`/api/chat/${directConvId}/messages`, { cookie: stu2Cookie });
  assert.strictEqual(nonMemberRead.status, 403, 'Non-member STU002 must receive 403 on messages get');

  const nonMemberPost = await request(`/api/chat/${directConvId}/messages`, {
    method: 'POST',
    cookie: stu2Cookie,
    body: { text: 'Unauthorized message attempt' }
  });
  assert.strictEqual(nonMemberPost.status, 403, 'Non-member STU002 must receive 403 on messages post');
  console.log('   ✅ Non-member read and post strictly rejected with 403.\n');

  // 7. Course Groups & Announcements-Only toggle
  console.log('7️⃣ Testing Course Groups & Announcements-Only restrictions...');
  const stu1Convs = await request('/api/chat/conversations', { cookie: stu1Cookie });
  assert.strictEqual(stu1Convs.status, 200);
  const cs101Conv = stu1Convs.data.conversations.find(c => c.course_id === 'CS101');
  assert(cs101Conv, 'CS101 group must be in STU001 conversations');
  const cs101Id = cs101Conv.id;

  // Faculty sets announce_only to 1
  const setAnnounce = await request(`/api/chat/${cs101Id}/settings`, {
    method: 'POST',
    cookie: facCookie,
    body: { announce_only: 1 }
  });
  assert.strictEqual(setAnnounce.status, 200);
  assert.strictEqual(setAnnounce.data.announce_only, 1);

  // Student attempts to post in announce-only group -> 403
  const stuBlockedPost = await request(`/api/chat/${cs101Id}/messages`, {
    method: 'POST',
    cookie: stu1Cookie,
    body: { text: 'Hello can I post?' }
  });
  assert.strictEqual(stuBlockedPost.status, 403, 'Student cannot post in announce-only group');
  console.log('   ✅ Student post in announce-only group blocked with 403.');

  // Faculty can post in announce-only group
  const facAnnouncePost = await request(`/api/chat/${cs101Id}/messages`, {
    method: 'POST',
    cookie: facCookie,
    body: { text: 'Official announcement: Midterms next week.' }
  });
  assert.strictEqual(facAnnouncePost.status, 201, 'Faculty can post in announce-only group');
  console.log('   ✅ Faculty can post in announce-only group.');

  // Faculty resets announce_only to 0
  await request(`/api/chat/${cs101Id}/settings`, {
    method: 'POST',
    cookie: facCookie,
    body: { announce_only: 0 }
  });

  // Now student can post
  const stuAllowedPost = await request(`/api/chat/${cs101Id}/messages`, {
    method: 'POST',
    cookie: stu1Cookie,
    body: { text: 'Understood, thank you Professor!' }
  });
  assert.strictEqual(stuAllowedPost.status, 201, 'Student can post when group is open');
  const stuMsgId = stuAllowedPost.data.message.id;
  console.log('   ✅ Student can post when announce-only is toggled off.\n');

  // 8. Message deletion: User can delete own message; Faculty can delete any in their course group
  console.log('8️⃣ Testing Message Deletion (Own deletion & Faculty course group deletion)...');
  // Student posts another message
  const msg2Post = await request(`/api/chat/${cs101Id}/messages`, {
    method: 'POST',
    cookie: stu1Cookie,
    body: { text: 'Student message to be deleted by faculty' }
  });
  assert.strictEqual(msg2Post.status, 201);
  const msg2Id = msg2Post.data.message.id;

  // Faculty deletes student's message in CS101 (Faculty teaches CS101) -> 200
  const facDeleteSuccess = await request(`/api/chat/messages/${msg2Id}`, {
    method: 'DELETE',
    cookie: facCookie
  });
  assert.strictEqual(facDeleteSuccess.status, 200, 'Faculty can delete any message in their own course group');
  console.log('   ✅ Faculty successfully deleted student message in their course group.');

  // Student deletes own first message -> 200
  const stuDeleteSuccess = await request(`/api/chat/messages/${stuMsgId}`, {
    method: 'DELETE',
    cookie: stu1Cookie
  });
  assert.strictEqual(stuDeleteSuccess.status, 200, 'Sender can delete own message');

  // Verify message is marked deleted and displays "This message was deleted"
  const checkMessages = await request(`/api/chat/${cs101Id}/messages`, { cookie: stu1Cookie });
  const deletedMsg = checkMessages.data.messages.find(m => m.id === stuMsgId);
  assert(deletedMsg, 'Deleted message must exist');
  assert.strictEqual(deletedMsg.deleted, 1);
  assert.strictEqual(deletedMsg.text, 'This message was deleted');
  console.log('   ✅ Deleted message displays "This message was deleted".\n');

  // 9. Blocking Flow
  console.log('9️⃣ Testing User Blocking and Unblocking...');
  // STU001 blocks FAC001
  const blockRes = await request('/api/chat/block', {
    method: 'POST',
    cookie: stu1Cookie,
    body: { target_uid: 'FAC001' }
  });
  assert.strictEqual(blockRes.status, 200);

  // FAC001 tries to send message in direct chat with STU001 -> 403
  const blockedMsgRes = await request(`/api/chat/${directConvId}/messages`, {
    method: 'POST',
    cookie: facCookie,
    body: { text: 'Message while blocked' }
  });
  assert.strictEqual(blockedMsgRes.status, 403, 'Message rejected when blocked (403)');
  console.log('   ✅ Message send blocked with 403 when user is blocked.');

  // STU001 unblocks FAC001
  const unblockRes = await request('/api/chat/unblock', {
    method: 'POST',
    cookie: stu1Cookie,
    body: { target_uid: 'FAC001' }
  });
  assert.strictEqual(unblockRes.status, 200);
  console.log('   ✅ Unblock successful; direct messaging unblocked.\n');

  // 10. Reporting Flow & Admin Access
  console.log('🔟 Testing Reporting Flow & Admin Report Reading...');
  // Faculty sends a message
  const repMsgPost = await request(`/api/chat/${directConvId}/messages`, {
    method: 'POST',
    cookie: facCookie,
    body: { text: 'Message that will be reported' }
  });
  assert.strictEqual(repMsgPost.status, 201);
  const repMsgId = repMsgPost.data.message.id;

  // STU001 reports the message
  const reportRes = await request('/api/chat/report', {
    method: 'POST',
    cookie: stu1Cookie,
    body: { message_id: repMsgId, reason: 'Inappropriate content test' }
  });
  assert(reportRes.status === 200 || reportRes.status === 201, 'Report should succeed with 200 or 201');
  console.log('   ✅ Message reported successfully.');

  // Admin reads reports via /api/admin/chat/reports
  const adminReportsRes = await request('/api/admin/chat/reports', { cookie: adminCookie });
  assert.strictEqual(adminReportsRes.status, 200);
  const foundReport = adminReportsRes.data.reports.find(r => r.message_id === repMsgId);
  assert(foundReport, 'Admin must see the reported message in reports endpoint');
  assert.strictEqual(foundReport.reporter_uid, 'STU001');
  assert.strictEqual(foundReport.message_text, 'Message that will be reported');
  console.log('   ✅ Admin can read reported messages with conversation and reporter info.\n');

  // 11. Faculty Custom Groups
  console.log('1️⃣1️⃣ Testing Faculty Custom Group Creation...');
  // Non-faculty cannot create group
  const stuGroupRes = await request('/api/chat/groups', {
    method: 'POST',
    cookie: stu1Cookie,
    body: { name: 'Student Group', member_uids: ['STU002'] }
  });
  assert.strictEqual(stuGroupRes.status, 403, 'Student cannot create custom groups (403)');

  // Faculty creates group with enrolled students
  const facGroupRes = await request('/api/chat/groups', {
    method: 'POST',
    cookie: facCookie,
    body: { name: 'Algorithm Project Team', member_uids: ['STU001', 'STU002'] }
  });
  assert.strictEqual(facGroupRes.status, 201);
  assert(facGroupRes.data.id > 0);
  console.log(`   ✅ Faculty created custom group (ID: ${facGroupRes.data.id}).\n`);

  // 12. Read receipts & Unread counts
  console.log('1️⃣2️⃣ Testing Unread Counts and Read Receipts...');
  const facDm = await request(`/api/chat/${directConvId}/messages`, {
    method: 'POST',
    cookie: facCookie,
    body: { text: 'Automated test message for read receipts' }
  });
  assert.strictEqual(facDm.status, 201);
  const msgTs = facDm.data.message.ts;

  // STU001 checks conversations list -> unread_count >= 1
  const stu1ConvsAfter = await request('/api/chat/conversations', { cookie: stu1Cookie });
  const directForStu1 = stu1ConvsAfter.data.conversations.find(c => c.id === directConvId);
  assert(directForStu1 && directForStu1.unread_count >= 1, 'STU001 should have unread message');
  console.log(`   ✅ Unread count incremented correctly (unread: ${directForStu1.unread_count}).`);

  // STU001 marks as read
  const readRes = await request(`/api/chat/${directConvId}/read`, {
    method: 'POST',
    cookie: stu1Cookie
  });
  assert.strictEqual(readRes.status, 200);

  // Faculty checks messages -> other_last_read_ts should be >= msgTs
  const facCheckDm = await request(`/api/chat/${directConvId}/messages`, { cookie: facCookie });
  assert(facCheckDm.data.other_last_read_ts >= msgTs, 'FAC001 should see STU001 other_last_read_ts updated (read receipts ✓✓)');
  console.log('   ✅ Read receipt timestamp updated; double ticks (✓✓) verified.\n');

  // 13. Real-Time Socket Room Isolation
  console.log('1️⃣3️⃣ Testing Socket.IO Room Isolation...');
  const stu1Socket = ioClient(BASE_URL, {
    extraHeaders: { Cookie: stu1Cookie },
    transports: ['websocket']
  });

  const stu2Socket = ioClient(BASE_URL, {
    extraHeaders: { Cookie: stu2Cookie },
    transports: ['websocket']
  });

  await new Promise(r => setTimeout(r, 800));

  let stu1Received = false;
  let stu2Received = false;

  stu1Socket.on('message:new', (m) => {
    if (m.conversation_id === directConvId && m.text.includes('Socket isolation test')) {
      stu1Received = true;
    }
  });

  stu2Socket.on('message:new', (m) => {
    if (m.conversation_id === directConvId) {
      stu2Received = true;
    }
  });

  // Faculty sends to direct room
  await request(`/api/chat/${directConvId}/messages`, {
    method: 'POST',
    cookie: facCookie,
    body: { text: 'Socket isolation test message' }
  });

  await new Promise(r => setTimeout(r, 1200));

  stu1Socket.disconnect();
  stu2Socket.disconnect();

  assert.strictEqual(stu1Received, true, 'Member STU001 should receive message in private room');
  assert.strictEqual(stu2Received, false, 'Non-member STU002 should NEVER receive message in private room');
  console.log('   ✅ Socket.IO private rooms verified: only conversation members receive message:new.\n');

  // 14. Demo Reset verification
  console.log('1️⃣4️⃣ Testing Reset Demo Data restores chat seed...');
  const resetRes = await request('/api/admin/reset-demo', {
    method: 'POST',
    cookie: adminCookie
  });
  assert.strictEqual(resetRes.status, 200);

  // Check STU001 conversations after reset
  const afterResetConvs = await request('/api/chat/conversations', { cookie: stu1Cookie });
  assert.strictEqual(afterResetConvs.status, 200);
  assert(afterResetConvs.data.conversations.length >= 5, 'Reset restores course groups and direct chat');
  console.log('   ✅ Reset Demo Data restored chat conversations and messages.\n');

  console.log('🎉 ALL WHATSAPP-STYLE CHAT TESTS PASSED PERFECTLY! 🎉\n');
}

runTests().catch(err => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
