const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const bcrypt = require('bcryptjs');

const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');

const { db, seedDatabase, getImpactMetrics, recordImpactUpdate } = require('./db');
const { resolveActiveClass, computeActionLine, getDirectiveSummary } = require('./directive');
const {
  JWT_SECRET,
  COOKIE_NAME,
  rateLimitLogin,
  recordFailedLogin,
  clearFailedLogins,
  generateToken,
  setAuthCookie,
  clearAuthCookie,
  authenticate,
  requireRole,
  requireEventOrganizer,
  requireCourseAccess,
  requireStudentSelfOrStaff
} = require('./auth');

if (!process.env.SECRET && !process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('⚠️ WARNING: SECRET environment variable is missing in production! Please set SECRET for production deployments.');
}

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DATA_JSON_FILE = path.join(DATA_DIR, 'data.json');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer Storage Configuration (5MB Limit, Allowed Exts)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${uniqueSuffix}-${safeName}`);
  }
});

const ALLOWED_EXTS = ['.pdf', '.png', '.jpg', '.jpeg', '.doc', '.docx', '.ppt', '.pptx', '.txt', '.zip'];

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Allowed: ${ALLOWED_EXTS.join(', ')}`));
    }
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Network Helpers
function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address !== '127.0.0.1') {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function sanitize(str, max = 80) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, max);
}

function addStatusLog(text) {
  const clean = sanitize(text, 140);
  const now = Date.now();
  db.prepare('INSERT INTO status_logs (text, ts) VALUES (?, ?)').run(clean, now);
  // Keep last 20 logs
  db.exec(`
    DELETE FROM status_logs WHERE id NOT IN (
      SELECT id FROM status_logs ORDER BY id DESC LIMIT 20
    )
  `);
}

function getFullTimetableState() {
  const timetable = db.prepare('SELECT * FROM timetable ORDER BY s ASC').all();
  const noticeRow = db.prepare('SELECT value FROM system_state WHERE key = ?').get('notice');
  const demoRow = db.prepare('SELECT value FROM system_state WHERE key = ?').get('demo_class_id');
  const logs = db.prepare('SELECT * FROM status_logs ORDER BY id DESC LIMIT 20').all();

  return {
    notice: noticeRow ? noticeRow.value : '',
    demo: demoRow && demoRow.value ? Number(demoRow.value) : null,
    classes: timetable,
    log: logs.map(l => ({ t: l.text, ts: l.ts }))
  };
}

// ============================================================================
// AUTHENTICATION ROUTES (Phase 1)
// ============================================================================

// POST /api/auth/login (Rate limited)
app.post('/api/auth/login', rateLimitLogin, (req, res) => {
  const { uid, passkey, role } = req.body;
  if (!uid || !passkey) {
    return res.status(400).json({ error: 'College ID and passkey are required' });
  }

  const cleanUid = sanitize(uid, 20).toUpperCase();
  const user = db.prepare('SELECT * FROM users WHERE uid = ?').get(cleanUid);

  if (!user) {
    recordFailedLogin(cleanUid);
    return res.status(401).json({ error: 'Invalid College ID or user not activated' });
  }

  if (role && user.role !== role) {
    recordFailedLogin(cleanUid);
    return res.status(401).json({ error: `Account role mismatch. Expected ${role}, found ${user.role}` });
  }

  const isMatch = bcrypt.compareSync(passkey, user.password_hash);
  if (!isMatch) {
    recordFailedLogin(cleanUid);
    return res.status(401).json({ error: 'Incorrect passkey. Please try again.' });
  }

  clearFailedLogins(cleanUid);
  const token = generateToken(user);
  setAuthCookie(res, token);

  res.json({
    success: true,
    user: {
      uid: user.uid,
      role: user.role,
      name: user.name,
      dept: user.dept,
      section: user.section,
      is_organizer: Boolean(user.is_organizer),
      must_change_pass: Boolean(user.must_change_pass)
    }
  });
});

// POST /api/auth/signup (First-time Activation)
app.post('/api/auth/signup', (req, res) => {
  const { uid, name, passkey, confirmPasskey } = req.body;
  if (!uid || !name || !passkey || !confirmPasskey) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  if (passkey !== confirmPasskey) {
    return res.status(400).json({ error: 'Passkeys do not match' });
  }

  if (passkey.length < 6) {
    return res.status(400).json({ error: 'Passkey must be at least 6 characters long' });
  }

  const cleanUid = sanitize(uid, 20).toUpperCase();
  const cleanName = sanitize(name, 80);

  // Check Roster
  const rosterEntry = db.prepare('SELECT * FROM roster WHERE uid = ?').get(cleanUid);
  if (!rosterEntry) {
    return res.status(400).json({ error: 'College ID not found in authorised campus roster.' });
  }

  if (rosterEntry.registered) {
    return res.status(400).json({ error: 'This ID has already been activated. Please log in.' });
  }

  // Verify Name match (case-insensitive)
  if (rosterEntry.name.trim().toLowerCase() !== cleanName.toLowerCase()) {
    return res.status(400).json({
      error: `Full name does not match campus roster records for ID ${cleanUid}.`
    });
  }

  // Hash passkey and register
  const hash = bcrypt.hashSync(passkey, 8);
  const now = Date.now();

  const registerTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO users (uid, role, name, dept, section, password_hash, must_change_pass, is_organizer, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(rosterEntry.uid, rosterEntry.role, rosterEntry.name, rosterEntry.dept, rosterEntry.section, hash, rosterEntry.is_organizer || 0, now);

    db.prepare('UPDATE roster SET registered = 1 WHERE uid = ?').run(rosterEntry.uid);
  });

  registerTx();

  const user = db.prepare('SELECT * FROM users WHERE uid = ?').get(cleanUid);
  const token = generateToken(user);
  setAuthCookie(res, token);

  res.json({
    success: true,
    message: 'Account activated successfully!',
    user: {
      uid: user.uid,
      role: user.role,
      name: user.name,
      dept: user.dept,
      section: user.section,
      is_organizer: Boolean(user.is_organizer),
      must_change_pass: false
    }
  });
});

// GET /api/auth/me
app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({
    user: {
      uid: req.user.uid,
      role: req.user.role,
      name: req.user.name,
      dept: req.user.dept,
      section: req.user.section,
      is_organizer: Boolean(req.user.is_organizer),
      must_change_pass: Boolean(req.user.must_change_pass)
    }
  });
});

// POST /api/auth/change-passkey
app.post('/api/auth/change-passkey', authenticate, (req, res) => {
  const { oldPasskey, newPasskey } = req.body;
  if (!newPasskey || newPasskey.length < 6) {
    return res.status(400).json({ error: 'New passkey must be at least 6 characters' });
  }

  const user = db.prepare('SELECT * FROM users WHERE uid = ?').get(req.user.uid);
  if (!user.must_change_pass) {
    if (!oldPasskey || !bcrypt.compareSync(oldPasskey, user.password_hash)) {
      return res.status(400).json({ error: 'Current passkey is incorrect' });
    }
  }

  const newHash = bcrypt.hashSync(newPasskey, 8);
  db.prepare('UPDATE users SET password_hash = ?, must_change_pass = 0 WHERE uid = ?').run(newHash, req.user.uid);

  res.json({ success: true, message: 'Passkey updated successfully' });
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true, message: 'Logged out' });
});

// ============================================================================
// LIVE CLASS STATUS & TIMETABLE (Phase 1)
// ============================================================================

const STATUS_LABELS = {
  ongoing: 'Class Ongoing',
  delayed: 'Faculty Delayed',
  absent: 'Faculty Absent',
  sub: 'Substitute Assigned',
  cancelled: 'Class Cancelled',
  resched: 'Rescheduled'
};

// ============================================================================
// AUTOMATIC REAL-TIME NOTIFICATIONS SYSTEM
// ============================================================================

function notifyEnrolledStudentsClassStatus(item, st, note) {
  if (!item) return;
  let studentIds = [];
  if (item.course_id) {
    const rows = db.prepare('SELECT student_id FROM enrollments WHERE course_id = ?').all(item.course_id);
    studentIds = rows.map(r => r.student_id);
  }
  if (!studentIds.length) {
    studentIds = db.prepare("SELECT uid FROM users WHERE role = 'STUDENT'").all().map(r => r.uid);
  }

  const statusLabel = STATUS_LABELS[st] || st;
  let actionText = '';
  if (st === 'absent' || st === 'cancelled') {
    actionText = 'You are free.';
  } else if (st === 'delayed') {
    actionText = `Please wait near ${item.room}.`;
  } else if (st === 'sub') {
    actionText = `Substitute in ${item.room}.`;
  } else if (st === 'resched') {
    actionText = 'Check new slot.';
  } else if (st === 'ongoing') {
    actionText = `Go to ${item.room}.`;
  }

  const notePart = note ? ` (${note})` : '';
  const message = `${item.sub}: ${statusLabel}. ${actionText}${notePart}`.trim();
  const title = `⏰ Class Update: ${item.sub}`;
  const link = '#/';
  const now = Date.now();

  const insertStmt = db.prepare(`
    INSERT INTO notifications (uid, title, message, link, is_read, created_ts, type, course_id)
    VALUES (?, ?, ?, ?, 0, ?, 'class_status', ?)
  `);

  for (const stuId of studentIds) {
    const res = insertStmt.run(stuId, title, message, link, now, item.course_id || null);
    const notifObj = {
      id: res.lastInsertRowid,
      uid: stuId,
      title,
      message,
      link,
      is_read: 0,
      created_ts: now,
      type: 'class_status',
      course_id: item.course_id || null
    };
    io.to(`user:${stuId}`).emit('notification:new', notifObj);
    io.to(`user:${stuId}`).emit('notifications:unread_update', {});
  }
  io.to('role:STUDENT').emit('notifications:unread_update', {});
}

function notifyStudentSubmissionGraded(sub, pts, cleanFeedback) {
  const now = Date.now();
  const title = `📝 Grade Returned: ${sub.assignment_title}`;
  const message = `Score: ${pts}/${sub.max_points} pts${cleanFeedback ? ' - ' + cleanFeedback : ''}`;
  const link = `#course/${sub.course_id}?tab=classwork`;

  const res = db.prepare(`
    INSERT INTO notifications (uid, title, message, link, is_read, created_ts, type, course_id)
    VALUES (?, ?, ?, ?, 0, ?, 'grade_returned', ?)
  `).run(sub.student_id, title, message, link, now, sub.course_id);

  const notifObj = {
    id: res.lastInsertRowid,
    uid: sub.student_id,
    title,
    message,
    link,
    is_read: 0,
    created_ts: now,
    type: 'grade_returned',
    course_id: sub.course_id
  };

  io.to(`user:${sub.student_id}`).emit('notification:new', notifObj);
  io.to(`user:${sub.student_id}`).emit('notifications:unread_update', {});
  return notifObj;
}

function checkAttendanceShortageForStudents(courseId, studentIds) {
  if (!courseId || !Array.isArray(studentIds) || !studentIds.length) return;
  const course = db.prepare('SELECT id, code, name FROM courses WHERE id = ? OR code = ?').get(courseId, courseId);
  if (!course) return;

  const now = Date.now();
  const insertStmt = db.prepare(`
    INSERT INTO notifications (uid, title, message, link, is_read, created_ts, type, course_id)
    VALUES (?, ?, ?, ?, 0, ?, 'attendance_shortage', ?)
  `);

  for (const stuId of studentIds) {
    const allRecords = db.prepare(`
      SELECT r.status
      FROM attendance_records r
      JOIN attendance_sessions s ON r.session_id = s.id
      WHERE (s.course_id = ? OR s.course_id = ?) AND r.student_id = ?
    `).all(course.id, course.code, stuId);

    const total = allRecords.length;
    if (total === 0) continue;

    const present = allRecords.filter(r => r.status === 'Present' || r.status === 'Late').length;
    const percentage = Math.round((present / total) * 100);

    if (percentage < 75) {
      // Notify once per subject (no duplicates)
      const existing = db.prepare(`
        SELECT 1 FROM notifications
        WHERE uid = ? AND type = 'attendance_shortage' AND (course_id = ? OR course_id = ?)
      `).get(stuId, course.id, course.code);

      if (!existing) {
        const needed = Math.ceil((0.75 * total - present) / 0.25);
        const title = `⚠️ Attendance Shortage: ${course.code}`;
        const message = `Your attendance in ${course.name} (${course.code}) dropped to ${percentage}%. You need ${needed} consecutive classes to reach 75%.`;
        const link = '#/';

        const res = insertStmt.run(stuId, title, message, link, now, course.id);
        const notifObj = {
          id: res.lastInsertRowid,
          uid: stuId,
          title,
          message,
          link,
          is_read: 0,
          created_ts: now,
          type: 'attendance_shortage',
          course_id: course.id
        };

        io.to(`user:${stuId}`).emit('notification:new', notifObj);
        io.to(`user:${stuId}`).emit('notifications:unread_update', {});
      }
    }
  }
}

function notifyAllStudentsNotice(noticeText) {
  if (!noticeText || !noticeText.trim()) return;
  const students = db.prepare("SELECT uid FROM users WHERE role = 'STUDENT'").all();
  const now = Date.now();
  const title = '📢 Campus Notice';
  const message = noticeText.trim();
  const link = '#/';

  const insertStmt = db.prepare(`
    INSERT INTO notifications (uid, title, message, link, is_read, created_ts, type)
    VALUES (?, ?, ?, ?, 0, ?, 'notice')
  `);

  for (const stu of students) {
    const res = insertStmt.run(stu.uid, title, message, link, now);
    const notifObj = {
      id: res.lastInsertRowid,
      uid: stu.uid,
      title,
      message,
      link,
      is_read: 0,
      created_ts: now,
      type: 'notice'
    };
    io.to(`user:${stu.uid}`).emit('notification:new', notifObj);
    io.to(`user:${stu.uid}`).emit('notifications:unread_update', {});
  }
  io.to('role:STUDENT').emit('notifications:unread_update', {});
}

// GET /api/timetable/today
app.get('/api/timetable/today', authenticate, (req, res) => {
  const state = getFullTimetableState();
  res.json(state);
});

// POST /api/timetable/status (Faculty or Admin)
app.post('/api/timetable/status', authenticate, requireRole('FACULTY', 'ADMIN'), (req, res) => {
  const { timetableId, st, note } = req.body;
  if (!timetableId || !st || !STATUS_LABELS[st]) {
    return res.status(400).json({ error: 'Invalid class ID or status code' });
  }

  const item = db.prepare('SELECT * FROM timetable WHERE id = ?').get(Number(timetableId));
  if (!item) {
    return res.status(404).json({ error: 'Class period not found' });
  }

  if (req.user.role === 'FACULTY' && item.faculty_id !== req.user.uid) {
    return res.status(403).json({ error: 'Forbidden: You can only update your own class status' });
  }

  const cleanNote = sanitize(note, 80);
  const now = Date.now();

  db.prepare(`
    UPDATE timetable
    SET st = ?, note = ?, ts = ?
    WHERE id = ?
  `).run(st, cleanNote, now, item.id);

  const noteSuffix = cleanNote ? ` (${cleanNote})` : '';
  addStatusLog(`${item.sub}: ${STATUS_LABELS[st]}${noteSuffix}`);
  recordImpactUpdate(st, item.id, item.course_id, item.sub);

  notifyEnrolledStudentsClassStatus(item, st, cleanNote);

  const updatedState = getFullTimetableState();
  persistDataJson(updatedState);
  io.emit('state:update', updatedState);
  io.emit('impact:updated', getImpactMetrics());
  io.emit('class:status_changed', {
    classId: item.id,
    subject: item.sub,
    status: st,
    statusLabel: STATUS_LABELS[st],
    note: cleanNote,
    updatedBy: req.user.name,
    timestamp: now
  });

  res.json({ success: true, state: updatedState });
});

// POST /api/timetable/notice (Faculty or Admin)
app.post('/api/timetable/notice', authenticate, requireRole('FACULTY', 'ADMIN'), (req, res) => {
  const clean = sanitize(req.body.notice || req.body.text || '', 140);
  if (!clean) {
    return res.status(400).json({ error: 'Notice text is required' });
  }

  db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('notice', clean);
  addStatusLog(`Urgent Notice: ${clean}`);

  notifyAllStudentsNotice(clean);

  const updatedState = getFullTimetableState();
  io.emit('state:update', updatedState);
  io.emit('notice:update', { notice: clean, postedBy: req.user.name });

  res.json({ success: true, state: updatedState });
});

// POST /api/timetable/notice/clear
app.post('/api/timetable/notice/clear', authenticate, requireRole('FACULTY', 'ADMIN'), (req, res) => {
  db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('notice', '');
  addStatusLog('Urgent Notice cleared');

  const updatedState = getFullTimetableState();
  io.emit('state:update', updatedState);
  io.emit('notice:update', { notice: '' });

  res.json({ success: true, state: updatedState });
});

// POST /api/timetable/demo (Admin only)
app.post('/api/timetable/demo', authenticate, requireRole('ADMIN'), (req, res) => {
  const { demoClassId } = req.body;
  const val = (demoClassId !== undefined && demoClassId !== null && demoClassId !== '') ? String(demoClassId) : '';
  db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('demo_class_id', val);

  const updatedState = getFullTimetableState();
  io.emit('state:update', updatedState);

  res.json({ success: true, state: updatedState });
});

// POST /api/timetable/reset (Admin only)
app.post('/api/timetable/reset', authenticate, requireRole('ADMIN'), (req, res) => {
  const now = Date.now();
  db.prepare(`
    UPDATE timetable
    SET st = 'ongoing', note = '', ts = ?
  `).run(now);

  db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('notice', '');
  db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('demo_class_id', '2');
  addStatusLog('Timetable statuses reset to Ongoing by Admin');

  const updatedState = getFullTimetableState();
  io.emit('state:update', updatedState);

  res.json({ success: true, state: updatedState });
});

// ============================================================================
// ATTENDANCE MODULE (Phase 2)
// ============================================================================

// GET /api/attendance/course/:courseId
app.get('/api/attendance/course/:courseId', authenticate, requireCourseAccess, (req, res) => {
  const courseId = req.params.courseId;

  if (req.user.role === 'STUDENT') {
    const sessions = db.prepare(`
      SELECT s.id, s.date, s.time_slot, r.status
      FROM attendance_sessions s
      JOIN attendance_records r ON s.id = r.session_id
      WHERE s.course_id = ? AND r.student_id = ?
      ORDER BY s.date DESC, s.id DESC
    `).all(courseId, req.user.uid);

    const total = sessions.length;
    const presentCount = sessions.filter(s => s.status === 'Present' || s.status === 'Late').length;
    const percentage = total > 0 ? Math.round((presentCount / total) * 100) : 100;

    let neededFor75 = 0;
    if (percentage < 75 && total > 0) {
      neededFor75 = Math.ceil((0.75 * total - presentCount) / 0.25);
    }

    return res.json({
      course: req.course,
      totalSessions: total,
      presentCount,
      percentage,
      belowThreshold: percentage < 75,
      neededFor75,
      sessions
    });
  }

  const students = db.prepare(`
    SELECT u.uid, u.name, u.section
    FROM users u
    JOIN enrollments e ON u.uid = e.student_id
    WHERE e.course_id = ?
    ORDER BY u.uid ASC
  `).all(courseId);

  const sessions = db.prepare(`
    SELECT id, date, time_slot, created_at
    FROM attendance_sessions
    WHERE course_id = ?
    ORDER BY date DESC, id DESC
  `).all(courseId);

  const summary = students.map(stu => {
    const records = db.prepare(`
      SELECT r.status
      FROM attendance_records r
      JOIN attendance_sessions s ON r.session_id = s.id
      WHERE s.course_id = ? AND r.student_id = ?
    `).all(courseId, stu.uid);

    const total = records.length;
    const present = records.filter(r => r.status === 'Present' || r.status === 'Late').length;
    const percentage = total > 0 ? Math.round((present / total) * 100) : 100;

    return {
      uid: stu.uid,
      name: stu.name,
      totalSessions: total,
      presentCount: present,
      percentage,
      belowThreshold: percentage < 75
    };
  });

  res.json({
    course: req.course,
    totalSessions: sessions.length,
    sessions,
    studentsSummary: summary
  });
});

// POST /api/attendance/session (Mark / Edit Attendance)
app.post('/api/attendance/session', authenticate, requireRole('FACULTY', 'ADMIN'), (req, res) => {
  const { course_id, date, time_slot, records } = req.body;
  if (!course_id || !date || !records || !Array.isArray(records)) {
    return res.status(400).json({ error: 'Missing required attendance data' });
  }

  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(course_id);
  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }

  if (req.user.role === 'FACULTY' && course.faculty_id !== req.user.uid) {
    return res.status(403).json({ error: 'Unauthorized: You are not assigned to this course' });
  }

  const cleanDate = sanitize(date, 10);
  const cleanSlot = sanitize(time_slot || '10:00-11:00', 20);
  const now = Date.now();

  const markTx = db.transaction(() => {
    let session = db.prepare('SELECT id FROM attendance_sessions WHERE course_id = ? AND date = ? AND time_slot = ?').get(course_id, cleanDate, cleanSlot);
    let sessionId;

    if (session) {
      sessionId = session.id;
      db.prepare('DELETE FROM attendance_records WHERE session_id = ?').run(sessionId);
    } else {
      const result = db.prepare(`
        INSERT INTO attendance_sessions (course_id, date, time_slot, created_by, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(course_id, cleanDate, cleanSlot, req.user.uid, now);
      sessionId = result.lastInsertRowid;
    }

    const insertRecord = db.prepare(`
      INSERT INTO attendance_records (session_id, student_id, status)
      VALUES (?, ?, ?)
    `);

    for (const r of records) {
      const validStatus = ['Present', 'Absent', 'Late'].includes(r.status) ? r.status : 'Present';
      insertRecord.run(sessionId, r.student_id, validStatus);
    }

    return sessionId;
  });

  const sessionId = markTx();
  checkAttendanceShortageForStudents(course_id, records.map(r => r.student_id));
  res.json({ success: true, message: 'Attendance saved successfully', sessionId });
});

// GET /api/attendance/course/:courseId/export (CSV)
app.get('/api/attendance/course/:courseId/export', authenticate, requireRole('FACULTY', 'ADMIN'), (req, res) => {
  const courseId = req.params.courseId;
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
  if (!course) return res.status(404).send('Course not found');

  const students = db.prepare(`
    SELECT u.uid, u.name, u.section
    FROM users u
    JOIN enrollments e ON u.uid = e.student_id
    WHERE e.course_id = ?
    ORDER BY u.uid ASC
  `).all(courseId);

  let csv = 'Student ID,Full Name,Total Sessions,Present,Absent,Late,Attendance Percentage,Status\n';

  for (const stu of students) {
    const records = db.prepare(`
      SELECT r.status
      FROM attendance_records r
      JOIN attendance_sessions s ON r.session_id = s.id
      WHERE s.course_id = ? AND r.student_id = ?
    `).all(courseId, stu.uid);

    const total = records.length;
    const present = records.filter(r => r.status === 'Present').length;
    const absent = records.filter(r => r.status === 'Absent').length;
    const late = records.filter(r => r.status === 'Late').length;
    const effectivePresent = present + late;
    const pct = total > 0 ? Math.round((effectivePresent / total) * 100) : 100;
    const status = pct < 75 ? 'BELOW 75% WARNING' : 'NORMAL';

    csv += `"${stu.uid}","${stu.name}",${total},${present},${absent},${late},${pct}%,"${status}"\n`;
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${course.code}_Attendance_Report.csv"`);
  res.send(csv);
});

// GET /api/attendance/student/summary
app.get('/api/attendance/student/summary', authenticate, requireRole('STUDENT'), (req, res) => {
  const courses = db.prepare(`
    SELECT c.id, c.code, c.name, u.name as faculty_name
    FROM courses c
    JOIN enrollments e ON c.id = e.course_id
    JOIN users u ON c.faculty_id = u.uid
    WHERE e.student_id = ?
  `).all(req.user.uid);

  const summary = courses.map(c => {
    const records = db.prepare(`
      SELECT r.status
      FROM attendance_records r
      JOIN attendance_sessions s ON r.session_id = s.id
      WHERE s.course_id = ? AND r.student_id = ?
    `).all(c.id, req.user.uid);

    const total = records.length;
    const present = records.filter(r => r.status === 'Present' || r.status === 'Late').length;
    const percentage = total > 0 ? Math.round((present / total) * 100) : 100;

    let neededFor75 = 0;
    if (percentage < 75 && total > 0) {
      neededFor75 = Math.ceil((0.75 * total - present) / 0.25);
    }

    return {
      courseId: c.id,
      code: c.code,
      name: c.name,
      faculty: c.faculty_name,
      total,
      present,
      percentage,
      belowThreshold: percentage < 75,
      neededFor75
    };
  });

  res.json({ courses: summary });
});

// ============================================================================
// MARKS & ASSESSMENTS MODULE (Phase 3)
// ============================================================================

// GET /api/marks/course/:courseId
app.get('/api/marks/course/:courseId', authenticate, requireCourseAccess, (req, res) => {
  const courseId = req.params.courseId;

  if (req.user.role === 'STUDENT') {
    const assessments = db.prepare(`
      SELECT a.id, a.name, a.max_marks, a.weightage, m.score
      FROM assessments a
      LEFT JOIN marks m ON a.id = m.assessment_id AND m.student_id = ?
      WHERE a.course_id = ? AND a.published = 1
      ORDER BY a.id ASC
    `).all(req.user.uid, courseId);

    const enriched = assessments.map(a => {
      const avg = db.prepare('SELECT AVG(score) as avgScore FROM marks WHERE assessment_id = ?').get(a.id);
      return {
        ...a,
        classAverage: avg && avg.avgScore !== null ? Number(avg.avgScore.toFixed(1)) : null,
        percentage: a.score !== null ? Math.round((a.score / a.max_marks) * 100) : null
      };
    });

    let totalScore = 0;
    let totalMax = 0;
    enriched.forEach(a => {
      if (a.score !== null) {
        totalScore += a.score;
        totalMax += a.max_marks;
      }
    });

    const overallPercentage = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : null;

    return res.json({
      course: req.course,
      assessments: enriched,
      overallPercentage
    });
  }

  const assessments = db.prepare('SELECT * FROM assessments WHERE course_id = ? ORDER BY id ASC').all(courseId);
  const students = db.prepare(`
    SELECT u.uid, u.name
    FROM users u
    JOIN enrollments e ON u.uid = e.student_id
    WHERE e.course_id = ?
    ORDER BY u.uid ASC
  `).all(courseId);

  const grid = students.map(stu => {
    const studentMarks = {};
    let stuTotal = 0;
    let stuMax = 0;

    assessments.forEach(a => {
      const m = db.prepare('SELECT score FROM marks WHERE assessment_id = ? AND student_id = ?').get(a.id, stu.uid);
      const score = m ? m.score : null;
      studentMarks[a.id] = score;
      if (score !== null) {
        stuTotal += score;
        stuMax += a.max_marks;
      }
    });

    const pct = stuMax > 0 ? Math.round((stuTotal / stuMax) * 100) : 0;
    return {
      uid: stu.uid,
      name: stu.name,
      marks: studentMarks,
      totalPercentage: pct,
      below40: pct < 40
    };
  });

  const assessmentStats = assessments.map(a => {
    const stats = db.prepare(`
      SELECT
        AVG(score) as avg,
        MAX(score) as max,
        MIN(score) as min,
        COUNT(score) as count
      FROM marks
      WHERE assessment_id = ?
    `).get(a.id);

    return {
      id: a.id,
      name: a.name,
      max_marks: a.max_marks,
      weightage: a.weightage,
      published: Boolean(a.published),
      avg: stats.avg !== null ? Number(stats.avg.toFixed(1)) : 0,
      max: stats.max !== null ? stats.max : 0,
      min: stats.min !== null ? stats.min : 0
    };
  });

  res.json({
    course: req.course,
    assessments: assessmentStats,
    studentsGrid: grid,
    studentsBelow40: grid.filter(g => g.below40)
  });
});

// POST /api/marks/assessment (Create assessment)
app.post('/api/marks/assessment', authenticate, requireRole('FACULTY', 'ADMIN'), (req, res) => {
  const { course_id, name, max_marks, weightage } = req.body;
  if (!course_id || !name || !max_marks) {
    return res.status(400).json({ error: 'Course, assessment name, and max marks are required' });
  }

  const cleanName = sanitize(name, 60);
  const max = Number(max_marks);
  const wt = weightage ? Number(weightage) : 20;

  if (isNaN(max) || max <= 0) {
    return res.status(400).json({ error: 'Max marks must be a positive number' });
  }

  const result = db.prepare(`
    INSERT INTO assessments (course_id, name, max_marks, weightage, published, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(course_id, cleanName, max, wt, Date.now());

  res.json({ success: true, assessmentId: result.lastInsertRowid });
});

// POST /api/marks/save (Enter / update student scores)
app.post('/api/marks/save', authenticate, requireRole('FACULTY', 'ADMIN'), (req, res) => {
  const { assessment_id, marks } = req.body;
  if (!assessment_id || !marks || !Array.isArray(marks)) {
    return res.status(400).json({ error: 'Assessment ID and marks array required' });
  }

  const assessment = db.prepare('SELECT * FROM assessments WHERE id = ?').get(Number(assessment_id));
  if (!assessment) {
    return res.status(404).json({ error: 'Assessment not found' });
  }

  const saveTx = db.transaction(() => {
    const upsert = db.prepare(`
      INSERT INTO marks (assessment_id, student_id, score)
      VALUES (?, ?, ?)
      ON CONFLICT(assessment_id, student_id) DO UPDATE SET score = excluded.score
    `);

    for (const m of marks) {
      const score = Number(m.score);
      if (!isNaN(score)) {
        if (score < 0 || score > assessment.max_marks) {
          throw new Error(`Score for ${m.student_id} must be between 0 and ${assessment.max_marks}`);
        }
        upsert.run(assessment.id, m.student_id, score);
      }
    }
  });

  try {
    saveTx();
    res.json({ success: true, message: 'Marks saved successfully' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/marks/publish
app.post('/api/marks/publish', authenticate, requireRole('FACULTY', 'ADMIN'), (req, res) => {
  const { assessment_id, published } = req.body;
  if (!assessment_id) {
    return res.status(400).json({ error: 'Assessment ID required' });
  }

  const pubVal = published ? 1 : 0;
  db.prepare('UPDATE assessments SET published = ? WHERE id = ?').run(pubVal, Number(assessment_id));

  res.json({ success: true, published: Boolean(pubVal) });
});

// GET /api/marks/course/:courseId/export (CSV)
app.get('/api/marks/course/:courseId/export', authenticate, requireRole('FACULTY', 'ADMIN'), (req, res) => {
  const courseId = req.params.courseId;
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
  if (!course) return res.status(404).send('Course not found');

  const assessments = db.prepare('SELECT * FROM assessments WHERE course_id = ? ORDER BY id ASC').all(courseId);
  const students = db.prepare(`
    SELECT u.uid, u.name
    FROM users u
    JOIN enrollments e ON u.uid = e.student_id
    WHERE e.course_id = ?
    ORDER BY u.uid ASC
  `).all(courseId);

  let header = 'Student ID,Full Name';
  assessments.forEach(a => {
    header += `,"${a.name} (Max ${a.max_marks})"`;
  });
  header += ',Total %,Status\n';

  let rows = '';
  students.forEach(stu => {
    let row = `"${stu.uid}","${stu.name}"`;
    let totalScore = 0;
    let totalMax = 0;

    assessments.forEach(a => {
      const m = db.prepare('SELECT score FROM marks WHERE assessment_id = ? AND student_id = ?').get(a.id, stu.uid);
      const score = m ? m.score : '';
      row += `,${score}`;
      if (m) {
        totalScore += m.score;
        totalMax += a.max_marks;
      }
    });

    const pct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
    const status = pct < 40 ? 'CRITICAL (<40%)' : 'PASS';
    row += `,${pct}%,"${status}"\n`;
    rows += row;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${course.code}_Marks_Gradebook.csv"`);
  res.send(header + rows);
});

// ============================================================================
// GOOGLE CLASSROOM FEATURES (Phase 4)
// ============================================================================

// GET /api/courses
app.get('/api/courses', authenticate, (req, res) => {
  let courses;
  if (req.user.role === 'ADMIN') {
    courses = db.prepare(`
      SELECT c.*, u.name as faculty_name
      FROM courses c
      JOIN users u ON c.faculty_id = u.uid
      ORDER BY c.code ASC
    `).all();
  } else if (req.user.role === 'FACULTY') {
    courses = db.prepare(`
      SELECT c.*, u.name as faculty_name
      FROM courses c
      JOIN users u ON c.faculty_id = u.uid
      WHERE c.faculty_id = ?
      ORDER BY c.code ASC
    `).all(req.user.uid);
  } else {
    courses = db.prepare(`
      SELECT c.*, u.name as faculty_name
      FROM courses c
      JOIN enrollments e ON c.id = e.course_id
      JOIN users u ON c.faculty_id = u.uid
      WHERE e.student_id = ?
      ORDER BY c.code ASC
    `).all(req.user.uid);
  }

  res.json({ courses });
});

// GET /api/courses/:courseId
app.get('/api/courses/:courseId', authenticate, requireCourseAccess, (req, res) => {
  const course = db.prepare(`
    SELECT c.*, u.name as faculty_name, u.dept as faculty_dept
    FROM courses c
    JOIN users u ON c.faculty_id = u.uid
    WHERE c.id = ?
  `).get(req.params.courseId);

  const enrolledCount = db.prepare('SELECT count(*) as count FROM enrollments WHERE course_id = ?').get(req.params.courseId).count;

  res.json({
    course: {
      ...course,
      enrolledCount
    }
  });
});

// --- Stream / Announcements ---
app.get('/api/courses/:courseId/announcements', authenticate, requireCourseAccess, (req, res) => {
  const announcements = db.prepare(`
    SELECT * FROM announcements
    WHERE course_id = ?
    ORDER BY created_at DESC
  `).all(req.params.courseId);

  res.json({ announcements });
});

app.post('/api/courses/:courseId/announcements', authenticate, requireRole('FACULTY', 'ADMIN'), upload.single('attachment'), (req, res) => {
  const courseId = req.params.courseId;
  const { text } = req.body;
  const clean = sanitize(text, 500);

  if (!clean) {
    return res.status(400).json({ error: 'Announcement text is required' });
  }

  const attachPath = req.file ? `/api/files/${req.file.filename}` : null;
  const attachName = req.file ? req.file.originalname : null;

  const result = db.prepare(`
    INSERT INTO announcements (course_id, faculty_id, faculty_name, text, attachment_path, attachment_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(courseId, req.user.uid, req.user.name, clean, attachPath, attachName, Date.now());

  io.emit('announcement:created', {
    courseId,
    announcementId: result.lastInsertRowid,
    facultyName: req.user.name,
    text: clean
  });

  res.json({ success: true, announcementId: result.lastInsertRowid });
});

// DELETE /api/announcements/:id (Faculty delete their own post)
app.delete('/api/announcements/:id', authenticate, requireRole('FACULTY', 'ADMIN'), (req, res) => {
  const annId = Number(req.params.id);
  const ann = db.prepare('SELECT * FROM announcements WHERE id = ?').get(annId);
  if (!ann) return res.status(404).json({ error: 'Announcement not found' });

  if (req.user.role === 'FACULTY' && ann.faculty_id !== req.user.uid) {
    return res.status(403).json({ error: 'Forbidden: You can only delete your own announcements' });
  }

  if (ann.attachment_path) {
    const filename = path.basename(ann.attachment_path);
    const filePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
  }

  db.prepare('DELETE FROM announcements WHERE id = ?').run(annId);
  io.emit('announcement:deleted', { id: annId, courseId: ann.course_id });

  res.json({ success: true, message: 'Announcement deleted successfully' });
});

// --- Materials ---
app.get('/api/courses/:courseId/materials', authenticate, requireCourseAccess, (req, res) => {
  const materials = db.prepare('SELECT * FROM materials WHERE course_id = ? ORDER BY created_at DESC').all(req.params.courseId);
  res.json({ materials });
});

app.post('/api/courses/:courseId/materials', authenticate, requireRole('FACULTY', 'ADMIN'), upload.single('material_file'), (req, res) => {
  const courseId = req.params.courseId;
  const { title, description, link_url } = req.body;

  const cleanTitle = sanitize(title, 80);
  const cleanDesc = sanitize(description, 250);
  const cleanLink = sanitize(link_url, 200);

  if (!cleanTitle) {
    return res.status(400).json({ error: 'Material title is required' });
  }

  const filePath = req.file ? `/api/files/${req.file.filename}` : null;
  const fileName = req.file ? req.file.originalname : null;

  const result = db.prepare(`
    INSERT INTO materials (course_id, faculty_id, title, description, link_url, file_path, file_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(courseId, req.user.uid, cleanTitle, cleanDesc, cleanLink || null, filePath, fileName, Date.now());

  io.emit('material:created', {
    courseId,
    materialId: result.lastInsertRowid,
    title: cleanTitle
  });

  res.json({ success: true, materialId: result.lastInsertRowid });
});

// DELETE /api/materials/:id
app.delete('/api/materials/:id', authenticate, requireRole('FACULTY', 'ADMIN'), (req, res) => {
  const matId = Number(req.params.id);
  const mat = db.prepare('SELECT * FROM materials WHERE id = ?').get(matId);
  if (!mat) return res.status(404).json({ error: 'Material not found' });

  if (req.user.role === 'FACULTY' && mat.faculty_id !== req.user.uid) {
    return res.status(403).json({ error: 'Forbidden: You can only delete your own materials' });
  }

  if (mat.file_path) {
    const filename = path.basename(mat.file_path);
    const filePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
  }

  db.prepare('DELETE FROM materials WHERE id = ?').run(matId);
  io.emit('material:deleted', { id: matId, courseId: mat.course_id });

  res.json({ success: true, message: 'Material deleted successfully' });
});

// --- Assignments ---
app.get('/api/courses/:courseId/assignments', authenticate, requireCourseAccess, (req, res) => {
  const courseId = req.params.courseId;
  const assignments = db.prepare('SELECT * FROM assignments WHERE course_id = ? ORDER BY due_date ASC').all(courseId);

  const enriched = assignments.map(a => {
    let submission = null;
    let submissionsCount = 0;

    if (req.user.role === 'STUDENT') {
      submission = db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?').get(a.id, req.user.uid);
    } else {
      submissionsCount = db.prepare("SELECT count(*) as count FROM submissions WHERE assignment_id = ? AND status != 'Assigned'").get(a.id).count;
    }

    const dueDate = new Date(a.due_date);
    const now = new Date();
    const isOverdue = now > dueDate;
    const isDueSoon = !isOverdue && (dueDate - now) < (24 * 3600 * 1000);

    return {
      ...a,
      isOverdue,
      isDueSoon,
      submission,
      submissionsCount
    };
  });

  res.json({ assignments: enriched });
});

app.post('/api/courses/:courseId/assignments', authenticate, requireRole('FACULTY', 'ADMIN'), upload.single('attachment'), (req, res) => {
  const courseId = req.params.courseId;
  const { title, instructions, due_date, max_points } = req.body;

  const cleanTitle = sanitize(title, 80);
  const cleanInst = sanitize(instructions, 500);
  const pts = max_points ? Number(max_points) : 100;

  if (!cleanTitle || !due_date) {
    return res.status(400).json({ error: 'Title and due date are required' });
  }

  const attachPath = req.file ? `/api/files/${req.file.filename}` : null;
  const attachName = req.file ? req.file.originalname : null;

  const result = db.prepare(`
    INSERT INTO assignments (course_id, faculty_id, title, instructions, due_date, max_points, attachment_path, attachment_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(courseId, req.user.uid, cleanTitle, cleanInst, due_date, pts, attachPath, attachName, Date.now());

  const aId = result.lastInsertRowid;

  const enrolledStudents = db.prepare('SELECT student_id FROM enrollments WHERE course_id = ?').all(courseId);
  const initSub = db.prepare(`
    INSERT INTO submissions (assignment_id, student_id, status)
    VALUES (?, ?, 'Assigned')
  `);
  for (const s of enrolledStudents) {
    initSub.run(aId, s.student_id);
  }

  io.emit('assignment:created', {
    courseId,
    assignmentId: aId,
    title: cleanTitle,
    dueDate: due_date
  });

  res.json({ success: true, assignmentId: aId });
});

// --- Submissions ---
app.get('/api/assignments/:assignmentId/submissions', authenticate, requireRole('FACULTY', 'ADMIN'), (req, res) => {
  const aId = Number(req.params.assignmentId);
  const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const submissions = db.prepare(`
    SELECT s.*, u.name as student_name, u.uid as student_uid
    FROM submissions s
    JOIN users u ON s.student_id = u.uid
    WHERE s.assignment_id = ?
    ORDER BY u.uid ASC
  `).all(aId);

  res.json({ assignment, submissions });
});

app.post('/api/assignments/:assignmentId/submit', authenticate, requireRole('STUDENT'), upload.single('submission_file'), (req, res) => {
  const aId = Number(req.params.assignmentId);
  const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(aId);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const { text_submission } = req.body;
  const cleanText = sanitize(text_submission, 500);

  // If student is replacing an existing file submission, delete old file from disk
  const existingSub = db.prepare('SELECT file_path FROM submissions WHERE assignment_id = ? AND student_id = ?').get(aId, req.user.uid);
  if (req.file && existingSub && existingSub.file_path) {
    const oldFilename = path.basename(existingSub.file_path);
    const oldFilePath = path.join(UPLOADS_DIR, oldFilename);
    if (fs.existsSync(oldFilePath)) {
      try { fs.unlinkSync(oldFilePath); } catch (e) {}
    }
  }

  const filePath = req.file ? `/api/files/${req.file.filename}` : null;
  const fileName = req.file ? req.file.originalname : null;

  const now = new Date();
  const dueDate = new Date(assignment.due_date);
  const status = now > dueDate ? 'Late' : 'Submitted';

  db.prepare(`
    INSERT INTO submissions (assignment_id, student_id, text_submission, file_path, file_name, status, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(assignment_id, student_id) DO UPDATE SET
      text_submission = COALESCE(excluded.text_submission, submissions.text_submission),
      file_path = COALESCE(excluded.file_path, submissions.file_path),
      file_name = COALESCE(excluded.file_name, submissions.file_name),
      status = excluded.status,
      submitted_at = excluded.submitted_at
  `).run(aId, req.user.uid, cleanText || null, filePath, fileName, status, Date.now());

  io.emit('submission:updated', {
    assignmentId: aId,
    courseId: assignment.course_id,
    studentId: req.user.uid,
    status
  });

  res.json({ success: true, message: 'Assignment submitted successfully!', status });
});

app.post('/api/submissions/:submissionId/grade', authenticate, requireRole('FACULTY', 'ADMIN'), (req, res) => {
  const subId = Number(req.params.submissionId);
  const { points, feedback } = req.body;

  const sub = db.prepare(`
    SELECT s.*, a.title as assignment_title, a.course_id, a.max_points
    FROM submissions s
    JOIN assignments a ON s.assignment_id = a.id
    WHERE s.id = ?
  `).get(subId);

  if (!sub) return res.status(404).json({ error: 'Submission not found' });

  const pts = Number(points);
  if (isNaN(pts) || pts < 0 || pts > sub.max_points) {
    return res.status(400).json({ error: `Points must be between 0 and ${sub.max_points}` });
  }

  const cleanFeedback = sanitize(feedback, 300);

  db.prepare(`
    UPDATE submissions
    SET points = ?, feedback = ?, status = 'Graded', graded_at = ?
    WHERE id = ?
  `).run(pts, cleanFeedback, Date.now(), subId);

  // Create notification and emit in real time to student
  notifyStudentSubmissionGraded(sub, pts, cleanFeedback);

  io.emit('submission:graded', {
    submissionId: subId,
    studentId: sub.student_id,
    assignmentId: sub.assignment_id,
    courseId: sub.course_id,
    points: pts,
    feedback: cleanFeedback
  });

  res.json({ success: true, message: 'Submission returned with grade and feedback' });
});

// --- People Tab ---
app.get('/api/courses/:courseId/people', authenticate, requireCourseAccess, (req, res) => {
  const faculty = db.prepare(`
    SELECT u.uid, u.name, u.dept, u.role
    FROM users u
    JOIN courses c ON u.uid = c.faculty_id
    WHERE c.id = ?
  `).get(req.params.courseId);

  const students = db.prepare(`
    SELECT u.uid, u.name, u.dept, u.section
    FROM users u
    JOIN enrollments e ON u.uid = e.student_id
    WHERE e.course_id = ?
    ORDER BY u.uid ASC
  `).all(req.params.courseId);

  res.json({ faculty, students });
});

// --- Student To-Do & Alerts ---
app.get('/api/student/dashboard-summary', authenticate, requireRole('STUDENT'), (req, res) => {
  const todo = db.prepare(`
    SELECT a.id, a.title, a.due_date, a.max_points, c.code, c.name as course_name, s.status, c.id as course_id
    FROM assignments a
    JOIN courses c ON a.course_id = c.id
    JOIN enrollments e ON c.id = e.course_id
    LEFT JOIN submissions s ON a.id = s.assignment_id AND s.student_id = ?
    WHERE e.student_id = ? AND (s.status IS NULL OR s.status = 'Assigned')
    ORDER BY a.due_date ASC
    LIMIT 5
  `).all(req.user.uid, req.user.uid);

  const courses = db.prepare(`
    SELECT c.id, c.code, c.name
    FROM courses c
    JOIN enrollments e ON c.id = e.course_id
    WHERE e.student_id = ?
  `).all(req.user.uid);

  const alerts = [];
  courses.forEach(c => {
    const records = db.prepare(`
      SELECT r.status
      FROM attendance_records r
      JOIN attendance_sessions s ON r.session_id = s.id
      WHERE s.course_id = ? AND r.student_id = ?
    `).all(c.id, req.user.uid);

    const total = records.length;
    const present = records.filter(r => r.status === 'Present' || r.status === 'Late').length;
    const percentage = total > 0 ? Math.round((present / total) * 100) : 100;

    if (percentage < 75 && total > 0) {
      const needed = Math.ceil((0.75 * total - present) / 0.25);
      alerts.push({
        courseId: c.id,
        code: c.code,
        name: c.name,
        percentage,
        neededClasses: needed
      });
    }
  });

  res.json({ todo, alerts });
});

// ============================================================================
// STUDENT CHAT ASSISTANT ("Ask ClassPulse" - Rule-Based)
// ============================================================================
app.post('/api/assistant', authenticate, requireRole('STUDENT'), (req, res) => {
  const rawMsg = (req.body && req.body.message) ? String(req.body.message) : '';
  const msg = rawMsg.toLowerCase().trim();

  let reply = '';
  let suggestions = [];

  // Keywords lists for intent matching
  const attendanceKeywords = ['attendance', 'short', '75', 'bunk'];
  const assignmentKeywords = ['assignment', 'deadline', 'due', 'pending', 'todo'];
  const marksKeywords = ['marks', 'grade', 'result', 'score'];
  const eventKeywords = ['event', 'seat', 'register'];
  const rightNowKeywords = ['right now', 'what should i do', 'class', 'today'];

  if (attendanceKeywords.some(k => msg.includes(k))) {
    // Intent 2: Attendance % per subject, flag < 75%, and consecutive classes needed
    const courses = db.prepare(`
      SELECT c.id, c.code, c.name, u.name as faculty_name
      FROM courses c
      JOIN enrollments e ON c.id = e.course_id
      JOIN users u ON c.faculty_id = u.uid
      WHERE e.student_id = ?
    `).all(req.user.uid);

    if (courses.length === 0) {
      reply = "You are not enrolled in any courses yet.";
    } else {
      const summary = courses.map(c => {
        const records = db.prepare(`
          SELECT r.status
          FROM attendance_records r
          JOIN attendance_sessions s ON r.session_id = s.id
          WHERE s.course_id = ? AND r.student_id = ?
        `).all(c.id, req.user.uid);

        const total = records.length;
        const present = records.filter(r => r.status === 'Present' || r.status === 'Late').length;
        const percentage = total > 0 ? Math.round((present / total) * 100) : 100;
        let neededFor75 = 0;
        if (percentage < 75 && total > 0) {
          neededFor75 = Math.ceil((0.75 * total - present) / 0.25);
        }
        return {
          code: c.code,
          name: c.name,
          total,
          present,
          percentage,
          belowThreshold: percentage < 75 && total > 0,
          neededFor75
        };
      });

      const shortages = summary.filter(s => s.belowThreshold);
      const lines = summary.map(s => {
        if (s.belowThreshold) {
          return `⚠️ **${s.name} (${s.code})**: **${s.percentage}%** (${s.present}/${s.total} attended)\n   🚨 **Shortage Alert!** You need **${s.neededFor75}** consecutive classes to reach 75%.`;
        } else {
          return `✅ **${s.name} (${s.code})**: **${s.percentage}%** (${s.present}/${s.total} attended)`;
        }
      });

      const header = shortages.length > 0
        ? `📊 **Attendance Summary (${shortages.length} Shortage Alert${shortages.length > 1 ? 's' : ''}):**\n\n`
        : `📊 **Attendance Summary (All ≥ 75%):**\n\n`;

      reply = header + lines.join('\n\n');
    }

    suggestions = [
      "What should I do right now?",
      "Pending assignments",
      "Latest grades"
    ];

  } else if (assignmentKeywords.some(k => msg.includes(k))) {
    // Intent 3: Pending assignments sorted by due date
    const pending = db.prepare(`
      SELECT a.id, a.title, a.due_date, a.max_points, c.code, c.name as course_name, s.status, c.id as course_id
      FROM assignments a
      JOIN courses c ON a.course_id = c.id
      JOIN enrollments e ON c.id = e.course_id
      LEFT JOIN submissions s ON a.id = s.assignment_id AND s.student_id = ?
      WHERE e.student_id = ? AND (s.status IS NULL OR s.status = 'Assigned')
      ORDER BY a.due_date ASC
    `).all(req.user.uid, req.user.uid);

    if (pending.length === 0) {
      reply = "🎉 **All caught up!** You have no pending assignments due right now.";
    } else {
      const now = Date.now();
      const list = pending.map((a, i) => {
        const d = new Date(a.due_date);
        const isOverdue = now > d.getTime();
        const isSoon = !isOverdue && (d.getTime() - now) < (24 * 3600 * 1000);
        const tag = isOverdue ? '🚨 Overdue' : isSoon ? '⏰ Due Soon' : '📝 Assigned';
        const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return `${i + 1}. **${a.title}** (${a.course_name} - ${a.code})\n   • Due: **${dateStr}** [${tag}]\n   • Max Points: ${a.max_points}`;
      });
      reply = `📝 **Pending Assignments (${pending.length}):**\n\n` + list.join('\n\n');
    }

    suggestions = [
      "What should I do right now?",
      "Check my attendance",
      "Latest grades"
    ];

  } else if (marksKeywords.some(k => msg.includes(k))) {
    // Intent 4: Latest grades
    const publishedMarks = db.prepare(`
      SELECT a.name, a.max_marks, m.score, c.code, c.name as course_name, a.created_at
      FROM marks m
      JOIN assessments a ON m.assessment_id = a.id
      JOIN courses c ON a.course_id = c.id
      JOIN enrollments e ON c.id = e.course_id
      WHERE m.student_id = ? AND e.student_id = ? AND a.published = 1
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 10
    `).all(req.user.uid, req.user.uid);

    const gradedSubmissions = db.prepare(`
      SELECT a.title as name, a.max_points as max_marks, s.points as score, c.code, c.name as course_name, s.graded_at as created_at, s.feedback
      FROM submissions s
      JOIN assignments a ON s.assignment_id = a.id
      JOIN courses c ON a.course_id = c.id
      WHERE s.student_id = ? AND s.status = 'Graded'
      ORDER BY s.graded_at DESC
      LIMIT 10
    `).all(req.user.uid);

    const allGrades = [
      ...publishedMarks.map(m => ({ ...m, type: 'Assessment' })),
      ...gradedSubmissions.map(s => ({ ...s, type: 'Assignment' }))
    ].sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 10);

    if (allGrades.length === 0) {
      reply = "📊 No published assessment marks or graded assignments found yet.";
    } else {
      const items = allGrades.map((g, i) => {
        const pct = g.max_marks > 0 ? Math.round((g.score / g.max_marks) * 100) : 0;
        const feedbackStr = g.feedback ? `\n   • Feedback: "${g.feedback}"` : '';
        return `${i + 1}. **${g.name}** (${g.code})\n   • Type: ${g.type} | Score: **${g.score}/${g.max_marks}** (${pct}%)${feedbackStr}`;
      });
      reply = `📊 **Latest Grades & Results:**\n\n` + items.join('\n\n');
    }

    suggestions = [
      "Check my attendance",
      "Pending assignments",
      "What should I do right now?"
    ];

  } else if (eventKeywords.some(k => msg.includes(k))) {
    // Intent 5: Upcoming events with seats left
    const now = Date.now();
    const rows = db.prepare(`
      SELECT * FROM events
      WHERE status IN ('upcoming', 'live') AND end_ts >= ?
      ORDER BY start_ts ASC
    `).all(now);

    const enriched = rows.map(r => enrichEventForUser(r, req.user.uid));
    const withSeats = enriched.filter(e => e.seatsLeft === null || e.seatsLeft > 0);

    if (withSeats.length === 0) {
      reply = "🎟️ No upcoming events with open seats right now. Check back soon!";
    } else {
      const items = withSeats.slice(0, 5).map((e, i) => {
        const dateStr = new Date(e.start_ts).toLocaleDateString([], {
          weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        const seatsStr = e.seatsLeft !== null ? `${e.seatsLeft} seat(s) left` : 'Unlimited seats';
        const regStr = e.isRegistered ? ' • ✅ Registered' : '';
        return `${i + 1}. **${e.title}** [${e.category}]\n   • 📍 Venue: ${e.venue} | ⏰ ${dateStr}\n   • 🎟️ Availability: **${seatsStr}**${regStr}`;
      });
      reply = `🎉 **Upcoming Events with Seats Left:**\n\n` + items.join('\n\n');
    }

    suggestions = [
      "What should I do right now?",
      "Check my attendance",
      "Pending assignments"
    ];

  } else if (rightNowKeywords.some(k => msg.includes(k))) {
    // Intent 1: Current class status & hero directive text (reuses directive logic)
    const state = getFullTimetableState();
    const { cls, mode, action } = getDirectiveSummary(state);

    if (mode === 'finished') {
      reply = `🎉 **DAY COMPLETE**: All scheduled classes have finished for today.\n\n📋 **Directive**: ${action.primary} ${action.secondary || ''}`;
    } else if (!cls || mode === 'empty') {
      reply = `📅 No active classes scheduled today.\n\n📋 **Directive**: ${action.primary}`;
    } else {
      const label = STATUS_LABELS[cls.st] || cls.st;
      reply = `⏰ **Current Class: ${cls.sub}** (${cls.s} - ${cls.e})\n` +
              `📍 **Room**: ${cls.room} | 👨‍🏫 **Faculty**: ${cls.fac}\n` +
              `● **Status**: ${label}${cls.note ? ` ("${cls.note}")` : ''}\n\n` +
              `📋 **Directive**: ${action.primary}\n` +
              (action.secondary ? `${action.secondary}` : '');
    }

    suggestions = [
      "Check my attendance",
      "Pending assignments",
      "Upcoming events"
    ];

  } else {
    // Fallback: friendly message listing capabilities
    reply = "Hi! I'm your **ClassPulse Assistant**. I can help you with:\n\n" +
      "• ⏰ **Right now directive & class status** (e.g. \"What should I do right now?\", \"today's class\")\n" +
      "• 📊 **Attendance shortage & percentage** (e.g. \"Check my attendance\", \"Do I have short attendance?\")\n" +
      "• 📝 **Pending assignments & deadlines** (e.g. \"Pending assignments\", \"Upcoming due dates\")\n" +
      "• 📈 **Latest grades & marks** (e.g. \"Show my grades\", \"Latest marks\")\n" +
      "• 🎟️ **Campus events & seat availability** (e.g. \"Upcoming events with seats left\")\n\n" +
      "How can I help you today?";

    suggestions = [
      "What should I do right now?",
      "Check my attendance",
      "Pending assignments"
    ];
  }

  res.json({ reply, suggestions });
});

// ============================================================================
// PHASE 6: CAMPUS EVENTS & TRENDING MODULE
// ============================================================================

const ALLOWED_CATEGORIES = ['Tech', 'Cultural', 'Sports', 'Workshop', 'Placement', 'Club', 'Fest', 'Seminar'];

function enrichEventForUser(event, userUid) {
  const regCount = db.prepare('SELECT count(*) as count FROM event_registrations WHERE event_id = ?').get(event.id).count;
  const interestedCount = db.prepare('SELECT count(*) as count FROM event_reactions WHERE event_id = ?').get(event.id).count;
  const views24h = db.prepare('SELECT count(*) as count FROM event_views WHERE event_id = ? AND ts >= ?').get(event.id, Date.now() - 24 * 3600 * 1000).count;

  let isRegistered = false;
  let isCheckedIn = false;
  let isInterested = false;

  if (userUid) {
    const reg = db.prepare('SELECT checked_in FROM event_registrations WHERE event_id = ? AND uid = ?').get(event.id, userUid);
    if (reg) {
      isRegistered = true;
      isCheckedIn = Boolean(reg.checked_in);
    }
    const react = db.prepare('SELECT 1 FROM event_reactions WHERE event_id = ? AND uid = ?').get(event.id, userUid);
    if (react) isInterested = true;
  }

  const seatsLeft = event.capacity ? Math.max(0, event.capacity - regCount) : null;
  const isFull = event.capacity ? regCount >= event.capacity : false;

  // Calculate trending score
  // Formula: score = (reg*3 + int*2 + views*0.5) * recencyBoost
  const now = Date.now();
  let recencyBoost = 0.5;
  const diffHours = (event.start_ts - now) / (3600 * 1000);

  if (event.status === 'live' || (diffHours >= -2 && diffHours <= 48)) {
    recencyBoost = 1.5;
  } else if (diffHours > 48 && diffHours <= 168) { // 7 days
    recencyBoost = 1.0;
  }

  const rawScore = (regCount * 3) + (interestedCount * 2) + (views24h * 0.5);
  const trendingScore = Number((rawScore * recencyBoost).toFixed(1));

  // Why trending label
  let whyTrending = '';
  if (regCount >= 5) {
    whyTrending = `${regCount} registered 🔥`;
  } else if (interestedCount >= 3) {
    whyTrending = `${interestedCount} interested ⭐`;
  } else if (views24h > 0) {
    whyTrending = `${views24h} views today 🚀`;
  } else {
    whyTrending = 'Popular on campus ⚡';
  }

  return {
    ...event,
    registration_required: Boolean(event.registration_required),
    regCount,
    interestedCount,
    views24h,
    isRegistered,
    isCheckedIn,
    isInterested,
    seatsLeft,
    isFull,
    trendingScore,
    whyTrending
  };
}

// GET /api/events
app.get('/api/events', authenticate, (req, res) => {
  const { category, dateFilter, search, status } = req.query;

  let query = 'SELECT * FROM events WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    query += ' AND status = ?';
    params.push(status);
  }

  if (category && category !== 'All') {
    query += ' AND category = ?';
    params.push(category);
  }

  if (search && search.trim()) {
    query += ' AND (title LIKE ? OR description LIKE ? OR venue LIKE ? OR organizer_name LIKE ?)';
    const s = `%${search.trim()}%`;
    params.push(s, s, s, s);
  }

  const now = Date.now();
  if (dateFilter === 'today') {
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    query += ' AND start_ts <= ? AND end_ts >= ?';
    params.push(endOfDay.getTime(), now - 24 * 3600 * 1000);
  } else if (dateFilter === 'week') {
    query += ' AND start_ts <= ? AND end_ts >= ?';
    params.push(now + 7 * 86400000, now - 24 * 3600 * 1000);
  }

  query += ' ORDER BY start_ts ASC';

  const rows = db.prepare(query).all(...params);
  const enriched = rows.map(r => enrichEventForUser(r, req.user.uid));

  res.json({ events: enriched });
});

// GET /api/events/happening-now
app.get('/api/events/happening-now', authenticate, (req, res) => {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM events
    WHERE status = 'live' OR (status != 'cancelled' AND start_ts <= ? AND end_ts >= ?)
    ORDER BY end_ts ASC
  `).all(now, now);

  const enriched = rows.map(r => enrichEventForUser(r, req.user.uid));
  res.json({ happeningNow: enriched });
});

// GET /api/events/trending (Top 5)
app.get('/api/events/trending', authenticate, (req, res) => {
  const rows = db.prepare("SELECT * FROM events WHERE status != 'ended' AND status != 'cancelled'").all();
  const enriched = rows.map(r => enrichEventForUser(r, req.user.uid));

  enriched.sort((a, b) => b.trendingScore - a.trendingScore);
  const top5 = enriched.slice(0, 5);

  res.json({ trending: top5 });
});

// GET /api/events/my-events
app.get('/api/events/my-events', authenticate, (req, res) => {
  const rows = db.prepare(`
    SELECT e.*, r.ts as registration_ts, r.checked_in, r.checkin_ts
    FROM events e
    JOIN event_registrations r ON e.id = r.event_id
    WHERE r.uid = ?
    ORDER BY e.start_ts ASC
  `).all(req.user.uid);

  const enriched = rows.map(r => enrichEventForUser(r, req.user.uid));
  res.json({ myEvents: enriched });
});

// GET /api/events/:id
app.get('/api/events/:id', authenticate, (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  // Record daily view
  const todayStr = new Date().toISOString().split('T')[0];
  db.prepare(`
    INSERT OR IGNORE INTO event_views (event_id, uid, date, ts)
    VALUES (?, ?, ?, ?)
  `).run(eventId, req.user.uid, todayStr, Date.now());

  const enriched = enrichEventForUser(event, req.user.uid);
  res.json({ event: enriched });
});

// POST /api/events (Create Event)
app.post('/api/events', authenticate, requireEventOrganizer, (req, res) => {
  const {
    title, description, category, venue, start_ts, end_ts,
    banner_color, capacity, registration_required
  } = req.body;

  const cleanTitle = sanitize(title, 80);
  const cleanDesc = sanitize(description, 1000);
  const cleanCat = ALLOWED_CATEGORIES.includes(category) ? category : 'Tech';
  const cleanVenue = sanitize(venue, 80);
  const sTs = Number(start_ts);
  const eTs = Number(end_ts);
  const cap = (capacity !== undefined && capacity !== null && capacity !== '') ? Number(capacity) : null;
  const reqReg = registration_required === false ? 0 : 1;

  if (!cleanTitle || !cleanVenue || !sTs || !eTs) {
    return res.status(400).json({ error: 'Title, Venue, Start Time, and End Time are required' });
  }

  if (eTs <= sTs) {
    return res.status(400).json({ error: 'Event End Time must be strictly after Start Time' });
  }

  if (cap !== null && (isNaN(cap) || cap <= 0)) {
    return res.status(400).json({ error: 'Capacity must be a positive number' });
  }

  const now = Date.now();
  let status = 'upcoming';
  if (now >= sTs && now < eTs) status = 'live';
  if (now >= eTs) status = 'ended';

  const result = db.prepare(`
    INSERT INTO events (
      title, description, category, venue, start_ts, end_ts,
      organizer_name, organizer_uid, banner_color, capacity,
      registration_required, status, update_note, created_ts
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
  `).run(
    cleanTitle, cleanDesc, cleanCat, cleanVenue, sTs, eTs,
    req.user.name, req.user.uid, banner_color || '#2563eb', cap,
    reqReg, status, now
  );

  const eventId = result.lastInsertRowid;
  const createdEvent = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);

  io.emit('eventCreated', enrichEventForUser(createdEvent, null));

  res.json({ success: true, eventId, event: createdEvent });
});

// PUT /api/events/:id (Edit Event)
app.put('/api/events/:id', authenticate, requireEventOrganizer, (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  if (req.user.role !== 'ADMIN' && event.organizer_uid !== req.user.uid) {
    return res.status(403).json({ error: 'Forbidden: You can only edit your own events' });
  }

  const { title, description, category, venue, start_ts, end_ts, banner_color, capacity } = req.body;

  const cleanTitle = sanitize(title || event.title, 80);
  const cleanDesc = sanitize(description || event.description, 1000);
  const cleanCat = ALLOWED_CATEGORIES.includes(category) ? category : event.category;
  const cleanVenue = sanitize(venue || event.venue, 80);
  const sTs = Number(start_ts || event.start_ts);
  const eTs = Number(end_ts || event.end_ts);
  const cap = (capacity !== undefined && capacity !== null && capacity !== '') ? Number(capacity) : event.capacity;

  if (eTs <= sTs) {
    return res.status(400).json({ error: 'End time must be after start time' });
  }

  db.prepare(`
    UPDATE events
    SET title = ?, description = ?, category = ?, venue = ?, start_ts = ?, end_ts = ?, banner_color = ?, capacity = ?
    WHERE id = ?
  `).run(cleanTitle, cleanDesc, cleanCat, cleanVenue, sTs, eTs, banner_color || event.banner_color, cap, eventId);

  const updated = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  io.emit('eventUpdated', enrichEventForUser(updated, null));

  res.json({ success: true, event: updated });
});

// POST /api/events/:id/status (Change Status)
app.post('/api/events/:id/status', authenticate, requireEventOrganizer, (req, res) => {
  const eventId = Number(req.params.id);
  const { status, cancel_reason } = req.body;

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  if (req.user.role !== 'ADMIN' && event.organizer_uid !== req.user.uid) {
    return res.status(403).json({ error: 'Forbidden: You can only change status for your own events' });
  }

  const validStatuses = ['upcoming', 'live', 'ended', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const cleanReason = sanitize(cancel_reason, 120);

  db.prepare(`
    UPDATE events
    SET status = ?, update_note = COALESCE(?, update_note)
    WHERE id = ?
  `).run(status, cleanReason ? `Cancelled: ${cleanReason}` : null, eventId);

  const updated = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);

  // If cancelled, notify all registered students!
  if (status === 'cancelled') {
    const registrations = db.prepare('SELECT uid FROM event_registrations WHERE event_id = ?').all(eventId);
    const insertNotif = db.prepare(`
      INSERT INTO notifications (uid, title, message, link, created_ts)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const r of registrations) {
      insertNotif.run(
        r.uid,
        `❌ Event Cancelled: ${event.title}`,
        cleanReason || 'This event was cancelled by the organizer.',
        `#event/${eventId}`,
        Date.now()
      );
    }

    io.emit('eventCancelled', { eventId, reason: cleanReason, title: event.title });
  } else {
    io.emit('eventUpdated', enrichEventForUser(updated, null));
  }

  res.json({ success: true, event: updated });
});

// POST /api/events/:id/note (Post Update Note)
app.post('/api/events/:id/note', authenticate, requireEventOrganizer, (req, res) => {
  const eventId = Number(req.params.id);
  const { note } = req.body;
  const cleanNote = sanitize(note, 140);

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  db.prepare('UPDATE events SET update_note = ? WHERE id = ?').run(cleanNote, eventId);

  // Notify registered students
  const registrations = db.prepare('SELECT uid FROM event_registrations WHERE event_id = ?').all(eventId);
  const insertNotif = db.prepare(`
    INSERT INTO notifications (uid, title, message, link, created_ts)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const r of registrations) {
    insertNotif.run(
      r.uid,
      `📢 Event Update: ${event.title}`,
      cleanNote,
      `#event/${eventId}`,
      Date.now()
    );
  }

  const updated = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  io.emit('eventUpdated', enrichEventForUser(updated, null));

  res.json({ success: true, note: cleanNote });
});

// POST /api/events/:id/register
app.post('/api/events/:id/register', authenticate, (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  if (event.status === 'cancelled' || event.status === 'ended') {
    return res.status(400).json({ error: 'Cannot register for cancelled or ended events' });
  }

  const regTx = db.transaction(() => {
    // Check if already registered
    const existing = db.prepare('SELECT 1 FROM event_registrations WHERE event_id = ? AND uid = ?').get(eventId, req.user.uid);
    if (existing) {
      return { alreadyRegistered: true };
    }

    // Check capacity
    if (event.capacity) {
      const currentCount = db.prepare('SELECT count(*) as count FROM event_registrations WHERE event_id = ?').get(eventId).count;
      if (currentCount >= event.capacity) {
        throw new Error('Event is at full capacity');
      }
    }

    db.prepare(`
      INSERT INTO event_registrations (event_id, uid, ts, checked_in)
      VALUES (?, ?, ?, 0)
    `).run(eventId, req.user.uid, Date.now());

    return { success: true };
  });

  try {
    const out = regTx();
    const newCount = db.prepare('SELECT count(*) as count FROM event_registrations WHERE event_id = ?').get(eventId).count;
    io.emit('registrationCount', { eventId, regCount: newCount });

    res.json({ success: true, message: 'Successfully registered for event!', regCount: newCount });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/events/:id/unregister
app.post('/api/events/:id/unregister', authenticate, (req, res) => {
  const eventId = Number(req.params.id);
  db.prepare('DELETE FROM event_registrations WHERE event_id = ? AND uid = ?').run(eventId, req.user.uid);

  const newCount = db.prepare('SELECT count(*) as count FROM event_registrations WHERE event_id = ?').get(eventId).count;
  io.emit('registrationCount', { eventId, regCount: newCount });

  res.json({ success: true, message: 'Unregistered from event' });
});

// POST /api/events/:id/react (Toggle Interested)
app.post('/api/events/:id/react', authenticate, (req, res) => {
  const eventId = Number(req.params.id);
  const existing = db.prepare('SELECT 1 FROM event_reactions WHERE event_id = ? AND uid = ?').get(eventId, req.user.uid);

  let isInterested = false;
  if (existing) {
    db.prepare('DELETE FROM event_reactions WHERE event_id = ? AND uid = ?').run(eventId, req.user.uid);
  } else {
    db.prepare('INSERT INTO event_reactions (event_id, uid, ts) VALUES (?, ?, ?)').run(eventId, req.user.uid, Date.now());
    isInterested = true;
  }

  const newCount = db.prepare('SELECT count(*) as count FROM event_reactions WHERE event_id = ?').get(eventId).count;
  res.json({ success: true, isInterested, interestedCount: newCount });
});

// GET /api/events/:id/registrations (Faculty/Organizer View)
app.get('/api/events/:id/registrations', authenticate, requireEventOrganizer, (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const registrations = db.prepare(`
    SELECT r.uid, r.ts, r.checked_in, r.checkin_ts, u.name, u.dept, u.section
    FROM event_registrations r
    JOIN users u ON r.uid = u.uid
    WHERE r.event_id = ?
    ORDER BY r.ts ASC
  `).all(eventId);

  const totalRegistered = registrations.length;
  const totalCheckedIn = registrations.filter(r => r.checked_in).length;

  res.json({
    event,
    totalRegistered,
    totalCheckedIn,
    registrations
  });
});

// GET /api/events/:id/export (CSV)
app.get('/api/events/:id/export', authenticate, requireEventOrganizer, (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).send('Event not found');

  const registrations = db.prepare(`
    SELECT r.uid, r.ts, r.checked_in, r.checkin_ts, u.name, u.dept, u.section
    FROM event_registrations r
    JOIN users u ON r.uid = u.uid
    WHERE r.event_id = ?
    ORDER BY r.ts ASC
  `).all(eventId);

  let csv = 'Student ID,Full Name,Department,Section,Registered Date,Checked In,Check-in Time\n';
  for (const r of registrations) {
    const regDate = new Date(r.ts).toISOString();
    const checkDate = r.checkin_ts ? new Date(r.checkin_ts).toISOString() : 'N/A';
    csv += `"${r.uid}","${r.name}","${r.dept}","${r.section}","${regDate}","${r.checked_in ? 'YES' : 'NO'}","${checkDate}"\n`;
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="Event_${eventId}_Registrations.csv"`);
  res.send(csv);
});

// POST /api/events/:id/checkin (Organizer Check-In by UID / QR Scanner)
app.post('/api/events/:id/checkin', authenticate, requireEventOrganizer, (req, res) => {
  const eventId = Number(req.params.id);
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'Student College ID is required' });

  const cleanUid = sanitize(uid, 20).toUpperCase();

  const reg = db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND uid = ?').get(eventId, cleanUid);
  if (!reg) {
    return res.status(400).json({ error: `Student ${cleanUid} is NOT registered for this event.` });
  }

  if (reg.checked_in) {
    const checkinTime = new Date(reg.checkin_ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return res.status(400).json({ error: `Student ${cleanUid} was already checked in at ${checkinTime}.` });
  }

  const now = Date.now();
  db.prepare('UPDATE event_registrations SET checked_in = 1, checkin_ts = ? WHERE event_id = ? AND uid = ?').run(now, eventId, cleanUid);

  const student = db.prepare('SELECT name, dept, section FROM users WHERE uid = ?').get(cleanUid);

  res.json({
    success: true,
    message: `Checked in successfully: ${student.name} (${cleanUid})`,
    student: {
      uid: cleanUid,
      name: student.name,
      dept: student.dept,
      section: student.section,
      checkin_ts: now
    }
  });
});

// GET /api/events/:id/ics (Download Calendar .ics File)
app.get('/api/events/:id/ics', (req, res) => {
  const eventId = Number(req.params.id);
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return res.status(404).send('Event not found');

  function toIcsDate(ts) {
    const d = new Date(ts);
    return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ClassPulse//Campus Events//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:classpulse-event-${event.id}@campus.edu`,
    `DTSTAMP:${toIcsDate(Date.now())}`,
    `DTSTART:${toIcsDate(event.start_ts)}`,
    `DTEND:${toIcsDate(event.end_ts)}`,
    `SUMMARY:${event.title}`,
    `DESCRIPTION:${(event.description || '').replace(/\n/g, '\\n')}`,
    `LOCATION:${event.venue}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/calendar');
  res.setHeader('Content-Disposition', `attachment; filename="${event.title.replace(/[^a-zA-Z0-9]/g, '_')}.ics"`);
  res.send(ics);
});

// ============================================================================
// NOTIFICATIONS MODULE
// ============================================================================

// GET /api/notifications
app.get('/api/notifications', authenticate, (req, res) => {
  const notifications = db.prepare('SELECT * FROM notifications WHERE uid = ? ORDER BY created_ts DESC LIMIT 30').all(req.user.uid);
  const unreadCount = db.prepare('SELECT count(*) as count FROM notifications WHERE uid = ? AND is_read = 0').get(req.user.uid).count;

  res.json({ notifications, unreadCount });
});

// POST /api/notifications/read
app.post('/api/notifications/read', authenticate, (req, res) => {
  const { id } = req.body || {};
  if (id) {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND uid = ?').run(Number(id), req.user.uid);
  } else {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE uid = ?').run(req.user.uid);
  }
  const unreadCount = db.prepare('SELECT count(*) as count FROM notifications WHERE uid = ? AND is_read = 0').get(req.user.uid).count;
  io.to(`user:${req.user.uid}`).emit('notifications:unread_update', { unreadCount });
  res.json({ success: true, unreadCount });
});

// ============================================================================
// AUTO-STATUS CRON / TIMER (Every 30s)
// ============================================================================
setInterval(() => {
  const now = Date.now();

  // 1. Upcoming -> Live
  const toLive = db.prepare("SELECT * FROM events WHERE status = 'upcoming' AND start_ts <= ? AND end_ts > ?").all(now, now);
  for (const ev of toLive) {
    db.prepare("UPDATE events SET status = 'live' WHERE id = ?").run(ev.id);
    io.emit('eventUpdated', enrichEventForUser(db.prepare('SELECT * FROM events WHERE id = ?').get(ev.id), null));
  }

  // 2. Live/Upcoming -> Ended
  const toEnded = db.prepare("SELECT * FROM events WHERE status IN ('live', 'upcoming') AND end_ts <= ?").all(now);
  for (const ev of toEnded) {
    db.prepare("UPDATE events SET status = 'ended' WHERE id = ?").run(ev.id);
    io.emit('eventUpdated', enrichEventForUser(db.prepare('SELECT * FROM events WHERE id = ?').get(ev.id), null));
  }

  // 3. 30-min event reminder notifications
  const startingSoon = db.prepare(`
    SELECT * FROM events
    WHERE status = 'upcoming'
    AND start_ts > ? AND start_ts <= ?
  `).all(now, now + 30 * 60 * 1000);

  for (const ev of startingSoon) {
    const regStudents = db.prepare('SELECT uid FROM event_registrations WHERE event_id = ?').all(ev.id);
    for (const r of regStudents) {
      const existing = db.prepare(`
        SELECT 1 FROM notifications
        WHERE uid = ? AND title LIKE ? AND created_ts >= ?
      `).get(r.uid, `%Starting Soon: ${ev.title}%`, now - 60 * 60 * 1000);

      if (!existing) {
        db.prepare(`
          INSERT INTO notifications (uid, title, message, link, created_ts)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          r.uid,
          `⏰ Starting Soon: ${ev.title}`,
          `Starts in 30 minutes at ${ev.venue}! Make sure to arrive early.`,
          `#event/${ev.id}`,
          now
        );
      }
    }
  }
}, 30000);

// ============================================================================
// ADMIN MANAGEMENT MODULE (Phase 5)
// ============================================================================

// GET /api/admin/roster
app.get('/api/admin/roster', authenticate, requireRole('ADMIN'), (req, res) => {
  const roster = db.prepare('SELECT * FROM roster ORDER BY role ASC, uid ASC').all();
  res.json({ roster });
});

// POST /api/admin/roster (Add Single)
app.post('/api/admin/roster', authenticate, requireRole('ADMIN'), (req, res) => {
  const { uid, role, name, dept, section, is_organizer } = req.body;
  if (!uid || !role || !name || !dept) {
    return res.status(400).json({ error: 'UID, Role, Name, and Dept are required' });
  }

  const cleanUid = sanitize(uid, 20).toUpperCase();
  const cleanRole = ['STUDENT', 'FACULTY', 'ADMIN'].includes(role) ? role : 'STUDENT';
  const cleanName = sanitize(name, 80);
  const cleanDept = sanitize(dept, 30);
  const cleanSec = sanitize(section || 'ALL', 20);
  const isOrg = is_organizer ? 1 : 0;

  try {
    db.prepare(`
      INSERT INTO roster (uid, role, name, dept, section, registered, is_organizer)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(cleanUid, cleanRole, cleanName, cleanDept, cleanSec, isOrg);

    res.json({ success: true, message: `Added ${cleanUid} to campus roster` });
  } catch (err) {
    res.status(400).json({ error: 'UID already exists in roster' });
  }
});

// POST /api/admin/roster/import (CSV)
app.post('/api/admin/roster/import', authenticate, requireRole('ADMIN'), upload.single('csv_file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'CSV file required' });
  }

  try {
    const raw = fs.readFileSync(req.file.path, 'utf-8');
    fs.unlinkSync(req.file.path);

    const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) {
      return res.status(400).json({ error: 'CSV file is empty or missing headers' });
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO roster (uid, role, name, dept, section, registered, is_organizer)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `);

    let importedCount = 0;
    const importTx = db.transaction(() => {
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
        if (cols.length >= 4) {
          const [uid, role, name, dept, section, isOrg] = cols;
          const cleanRole = ['STUDENT', 'FACULTY', 'ADMIN'].includes(role?.toUpperCase()) ? role.toUpperCase() : 'STUDENT';
          insert.run(uid.toUpperCase(), cleanRole, name, dept, section || 'ALL', isOrg === '1' || isOrg === 'true' ? 1 : 0);
          importedCount++;
        }
      }
    });

    importTx();
    res.json({ success: true, imported: importedCount });
  } catch (err) {
    res.status(400).json({ error: `Import failed: ${err.message}` });
  }
});

// DELETE /api/admin/roster/:uid
app.delete('/api/admin/roster/:uid', authenticate, requireRole('ADMIN'), (req, res) => {
  const uid = req.params.uid.toUpperCase();
  const entry = db.prepare('SELECT registered FROM roster WHERE uid = ?').get(uid);

  if (!entry) return res.status(404).json({ error: 'Roster entry not found' });
  if (entry.registered) {
    return res.status(400).json({ error: 'Cannot delete an active registered user from roster directly' });
  }

  db.prepare('DELETE FROM roster WHERE uid = ?').run(uid);
  res.json({ success: true, message: `Removed ${uid} from roster` });
});

// POST /api/admin/reset-passkey
app.post('/api/admin/reset-passkey', authenticate, requireRole('ADMIN'), (req, res) => {
  const { uid, tempPasskey } = req.body;
  if (!uid || !tempPasskey || tempPasskey.length < 6) {
    return res.status(400).json({ error: 'UID and temp passkey (min 6 chars) required' });
  }

  const cleanUid = uid.toUpperCase();
  const user = db.prepare('SELECT * FROM users WHERE uid = ?').get(cleanUid);
  if (!user) {
    return res.status(404).json({ error: 'User is not yet activated' });
  }

  const newHash = bcrypt.hashSync(tempPasskey, 8);
  db.prepare(`
    UPDATE users
    SET password_hash = ?, must_change_pass = 1
    WHERE uid = ?
  `).run(newHash, cleanUid);

  res.json({ success: true, message: `Passkey for ${cleanUid} reset to temporary key. User must change it at next login.` });
});

// GET /api/admin/courses
app.get('/api/admin/courses', authenticate, requireRole('ADMIN'), (req, res) => {
  const courses = db.prepare(`
    SELECT c.*, u.name as faculty_name
    FROM courses c
    LEFT JOIN users u ON c.faculty_id = u.uid
    ORDER BY c.code ASC
  `).all();

  const facultyList = db.prepare("SELECT uid, name, dept FROM users WHERE role = 'FACULTY'").all();
  res.json({ courses, facultyList });
});

// POST /api/admin/courses
app.post('/api/admin/courses', authenticate, requireRole('ADMIN'), (req, res) => {
  const { id, code, name, dept, section, faculty_id } = req.body;
  if (!id || !code || !name || !faculty_id) {
    return res.status(400).json({ error: 'Course ID, Code, Name, and Faculty ID are required' });
  }

  try {
    db.prepare(`
      INSERT INTO courses (id, code, name, dept, section, faculty_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id.toUpperCase(), code.toUpperCase(), sanitize(name, 80), sanitize(dept || 'CSE', 30), sanitize(section || 'ALL', 20), faculty_id.toUpperCase());

    res.json({ success: true, message: `Course ${code} created successfully` });
  } catch (err) {
    res.status(400).json({ error: 'Course ID already exists' });
  }
});

// POST /api/admin/enroll-section
app.post('/api/admin/enroll-section', authenticate, requireRole('ADMIN'), (req, res) => {
  const { course_id, section } = req.body;
  if (!course_id || !section) {
    return res.status(400).json({ error: 'Course ID and Section required' });
  }

  const students = db.prepare("SELECT uid FROM users WHERE role = 'STUDENT' AND section = ?").all(section);
  const insert = db.prepare('INSERT OR IGNORE INTO enrollments (course_id, student_id) VALUES (?, ?)');

  const enrollTx = db.transaction(() => {
    for (const s of students) {
      insert.run(course_id, s.uid);
    }
  });

  enrollTx();
  res.json({ success: true, enrolledCount: students.length });
});

// GET /api/admin/timetable
app.get('/api/admin/timetable', authenticate, requireRole('ADMIN'), (req, res) => {
  const timetable = db.prepare('SELECT * FROM timetable ORDER BY s ASC').all();
  res.json({ timetable });
});

// POST /api/admin/timetable
app.post('/api/admin/timetable', authenticate, requireRole('ADMIN'), (req, res) => {
  const { id, course_id, s, e, sub, fac, faculty_id, room } = req.body;
  if (!s || !e || !sub || !room) {
    return res.status(400).json({ error: 'Start, End, Subject, and Room are required' });
  }

  const cleanS = sanitize(s, 5);
  const cleanE = sanitize(e, 5);
  const cleanSub = sanitize(sub, 50);
  const cleanFac = sanitize(fac || 'Faculty', 50);
  const cleanFacId = sanitize(faculty_id || 'FAC001', 20);
  const cleanRoom = sanitize(room, 30);
  const cleanCourse = sanitize(course_id || 'CS101', 20);
  const now = Date.now();

  if (id) {
    db.prepare(`
      UPDATE timetable
      SET course_id = ?, s = ?, e = ?, sub = ?, fac = ?, faculty_id = ?, room = ?, ts = ?
      WHERE id = ?
    `).run(cleanCourse, cleanS, cleanE, cleanSub, cleanFac, cleanFacId, cleanRoom, now, Number(id));
  } else {
    db.prepare(`
      INSERT INTO timetable (course_id, s, e, sub, fac, faculty_id, room, st, note, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ongoing', '', ?)
    `).run(cleanCourse, cleanS, cleanE, cleanSub, cleanFac, cleanFacId, cleanRoom, now);
  }

  const updated = getFullTimetableState();
  io.emit('state:update', updated);

  res.json({ success: true, state: updated });
});

// DELETE /api/admin/timetable/:id
app.delete('/api/admin/timetable/:id', authenticate, requireRole('ADMIN'), (req, res) => {
  db.prepare('DELETE FROM timetable WHERE id = ?').run(Number(req.params.id));
  const updated = getFullTimetableState();
  io.emit('state:update', updated);
  res.json({ success: true, state: updated });
});

// GET /api/config
app.get('/api/config', (req, res) => {
  const isDemo = process.env.DEMO === '1' || process.env.DEMO === 'true';
  res.json({
    demo: isDemo,
    lanIp: getLanIp(),
    port: PORT
  });
});

// POST /api/admin/reset-demo (5-Second Reset to Seed State)
app.post('/api/admin/reset-demo', authenticate, requireRole('ADMIN'), (req, res) => {
  try {
    seedDatabase(true);
    const updated = getFullTimetableState();
    persistDataJson(updated);
    io.emit('state:update', updated);
    io.emit('state', updated);
    io.emit('events:updated', {});
    io.emit('notice:update', { notice: '' });
    io.emit('impact:updated', getImpactMetrics());
    io.emit('notifications:unread_update', {});
    res.json({ success: true, message: 'Clean seed data restored successfully in 5 seconds.' });
  } catch (err) {
    console.error('Error resetting demo data:', err);
    res.status(500).json({ error: 'Failed to reset demo data: ' + err.message });
  }
});

// GET /api/admin/impact (Live Pitch Impact Dashboard)
app.get('/api/admin/impact', authenticate, requireRole('ADMIN'), (req, res) => {
  try {
    const metrics = getImpactMetrics();
    res.json(metrics);
  } catch (err) {
    console.error('Error computing impact metrics:', err);
    res.status(500).json({ error: 'Failed to load impact metrics: ' + err.message });
  }
});

// ============================================================================
// HEALTH, PWA & COMPATIBILITY ENDPOINTS
// ============================================================================
// Unauthenticated Health Check for Deployments & Uptime Monitors
app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  const count = db.prepare('SELECT count(*) as count FROM timetable').get().count;
  res.json({ status: 'ok', classesCount: count });
});

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
});

app.get('/sw.js', (req, res) => {
  res.type('application/javascript').setHeader('Service-Worker-Allowed', '/').sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('/api/state', authenticate, (req, res) => {
  res.json(getFullTimetableState());
});

function persistDataJson(state) {
  try {
    fs.writeFileSync(DATA_JSON_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {}
}

// ============================================================================
// PROTECTED FILE SERVING (Safe with Role & Course Ownership Checks)
// ============================================================================
app.get('/api/files/:filename', authenticate, (req, res) => {
  const rawParam = req.params.filename || '';
  if (rawParam.includes('..') || rawParam.includes('/') || rawParam.includes('\\')) {
    return res.status(403).send('Forbidden: Path traversal blocked');
  }
  const filename = path.basename(rawParam);
  const filePath = path.join(UPLOADS_DIR, filename);

  // Security: strictly block path traversal
  const resolvedPath = path.resolve(filePath);
  const uploadsRoot = path.resolve(UPLOADS_DIR);
  const rel = path.relative(uploadsRoot, resolvedPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(403).send('Forbidden: Path traversal blocked');
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  // Admin has access to all campus files
  if (req.user.role === 'ADMIN') {
    return res.sendFile(resolvedPath);
  }

  // 1. Check Course Announcements
  const fileApiPath = `/api/files/${filename}`;
  const announcement = db.prepare('SELECT course_id FROM announcements WHERE attachment_path = ?').get(fileApiPath);
  if (announcement) {
    if (req.user.role === 'FACULTY') {
      const course = db.prepare('SELECT faculty_id FROM courses WHERE id = ?').get(announcement.course_id);
      if (course && course.faculty_id === req.user.uid) return res.sendFile(resolvedPath);
    } else if (req.user.role === 'STUDENT') {
      const enrolled = db.prepare('SELECT 1 FROM enrollments WHERE course_id = ? AND student_id = ?').get(announcement.course_id, req.user.uid);
      if (enrolled) return res.sendFile(resolvedPath);
    }
  }

  // 2. Check Course Materials
  const material = db.prepare('SELECT course_id FROM materials WHERE file_path = ?').get(fileApiPath);
  if (material) {
    if (req.user.role === 'FACULTY') {
      const course = db.prepare('SELECT faculty_id FROM courses WHERE id = ?').get(material.course_id);
      if (course && course.faculty_id === req.user.uid) return res.sendFile(resolvedPath);
    } else if (req.user.role === 'STUDENT') {
      const enrolled = db.prepare('SELECT 1 FROM enrollments WHERE course_id = ? AND student_id = ?').get(material.course_id, req.user.uid);
      if (enrolled) return res.sendFile(resolvedPath);
    }
  }

  // 3. Check Course Assignments
  const assignment = db.prepare('SELECT course_id FROM assignments WHERE attachment_path = ?').get(fileApiPath);
  if (assignment) {
    if (req.user.role === 'FACULTY') {
      const course = db.prepare('SELECT faculty_id FROM courses WHERE id = ?').get(assignment.course_id);
      if (course && course.faculty_id === req.user.uid) return res.sendFile(resolvedPath);
    } else if (req.user.role === 'STUDENT') {
      const enrolled = db.prepare('SELECT 1 FROM enrollments WHERE course_id = ? AND student_id = ?').get(assignment.course_id, req.user.uid);
      if (enrolled) return res.sendFile(resolvedPath);
    }
  }

  // 4. Check Submissions (Student author or teaching faculty)
  const submission = db.prepare(`
    SELECT s.student_id, a.course_id, c.faculty_id
    FROM submissions s
    JOIN assignments a ON s.assignment_id = a.id
    JOIN courses c ON a.course_id = c.id
    WHERE s.file_path = ?
  `).get(fileApiPath);

  if (submission) {
    if (req.user.role === 'STUDENT' && submission.student_id === req.user.uid) {
      return res.sendFile(resolvedPath);
    }
    if (req.user.role === 'FACULTY' && submission.faculty_id === req.user.uid) {
      return res.sendFile(resolvedPath);
    }
  }

  // 5. Check Campus Events
  const event = db.prepare('SELECT 1 FROM events WHERE banner_image = ?').get(fileApiPath);
  if (event) {
    return res.sendFile(resolvedPath);
  }

  return res.status(403).send('Forbidden: Access denied to course file');
});

// ============================================================================
// SOCKET.IO REAL-TIME CONNECTION
// ============================================================================
function userFromSocket(socket) {
  try {
    const header = socket.handshake.headers.cookie || '';
    let token = null;
    header.split(';').forEach((part) => {
      const [k, ...rest] = part.trim().split('=');
      if (k === COOKIE_NAME) token = decodeURIComponent(rest.join('='));
    });
    if (!token) return null;
    const decoded = jwt.verify(token, JWT_SECRET);
    return db.prepare('SELECT uid, role, name FROM users WHERE uid = ?').get(decoded.uid) || null;
  } catch (e) {
    return null;
  }
}

function requireSocketStaff(socket, cb, adminOnly) {
  const user = userFromSocket(socket);
  if (!user || (adminOnly ? user.role !== 'ADMIN' : (user.role !== 'FACULTY' && user.role !== 'ADMIN'))) {
    if (typeof cb === 'function') cb({ success: false, error: 'Unauthorized' });
    return null;
  }
  return user;
}

io.on('connection', (socket) => {
  const socketUser = userFromSocket(socket);
  if (socketUser) {
    socket.join(`user:${socketUser.uid}`);
    socket.join(`role:${socketUser.role}`);
  }

  socket.on('joinUser', ({ uid, role }) => {
    if (uid) socket.join(`user:${uid}`);
    if (role) socket.join(`role:${role}`);
  });

  const state = getFullTimetableState();
  socket.emit('state:update', state);
  socket.emit('state', state);

  socket.on('verifyPin', ({ pin }, cb) => {
    const user = userFromSocket(socket);
    const ok = Boolean(user && (user.role === 'FACULTY' || user.role === 'ADMIN') && pin === '1234');
    if (typeof cb === 'function') cb({ success: ok });
  });

  socket.on('setStatus', ({ id, st, note, pin }, cb) => {
    const user = requireSocketStaff(socket, cb, false);
    if (!user) return;
    if (pin && pin !== '1234') {
      if (typeof cb === 'function') cb({ success: false, error: 'Unauthorized PIN' });
      return;
    }
    const cleanNote = sanitize(note, 80);
    const now = Date.now();
    let item = db.prepare('SELECT * FROM timetable WHERE id = ?').get(Number(id));
    if (!item) {
      const all = db.prepare('SELECT * FROM timetable ORDER BY s ASC').all();
      if (all[Number(id) - 1]) item = all[Number(id) - 1];
      else if (all[0]) item = all[0];
    }
    if (item) {
      if (user.role === 'FACULTY' && item.faculty_id !== user.uid) {
        if (typeof cb === 'function') cb({ success: false, error: 'Forbidden: You can only update your own class status' });
        return;
      }
      db.prepare('UPDATE timetable SET st = ?, note = ?, ts = ? WHERE id = ?').run(st, cleanNote, now, item.id);
      addStatusLog(`${item.sub}: ${STATUS_LABELS[st] || st}${cleanNote ? ' (' + cleanNote + ')' : ''}`);
      recordImpactUpdate(st, item.id, item.course_id, item.sub);
      notifyEnrolledStudentsClassStatus(item, st, cleanNote);
    }
    const updated = getFullTimetableState();
    persistDataJson(updated);
    io.emit('state:update', updated);
    io.emit('state', updated);
    io.emit('impact:updated', getImpactMetrics());
    if (typeof cb === 'function') cb({ success: true, state: updated });
  });

  socket.on('postNotice', ({ text, pin }, cb) => {
    if (!requireSocketStaff(socket, cb, false)) return;
    if (pin && pin !== '1234') {
      if (typeof cb === 'function') cb({ success: false, error: 'Unauthorized PIN' });
      return;
    }
    const clean = sanitize(text, 140);
    db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('notice', clean);
    addStatusLog(`Urgent Notice: ${clean}`);
    notifyAllStudentsNotice(clean);
    const updated = getFullTimetableState();
    persistDataJson(updated);
    io.emit('state:update', updated);
    io.emit('state', updated);
    io.emit('notice:update', { notice: clean });
    if (typeof cb === 'function') cb({ success: true, state: updated });
  });

  socket.on('clearNotice', ({ pin }, cb) => {
    if (!requireSocketStaff(socket, cb, false)) return;
    if (pin && pin !== '1234') {
      if (typeof cb === 'function') cb({ success: false, error: 'Unauthorized PIN' });
      return;
    }
    db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('notice', '');
    addStatusLog('Urgent Notice cleared');
    const updated = getFullTimetableState();
    persistDataJson(updated);
    io.emit('state:update', updated);
    io.emit('state', updated);
    io.emit('notice:update', { notice: '' });
    if (typeof cb === 'function') cb({ success: true, state: updated });
  });

  socket.on('setDemo', ({ id, pin }, cb) => {
    if (!requireSocketStaff(socket, cb, true)) return;
    if (pin && pin !== '1234') {
      if (typeof cb === 'function') cb({ success: false, error: 'Unauthorized PIN' });
      return;
    }
    db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('demo_class_id', String(id));
    const updated = getFullTimetableState();
    persistDataJson(updated);
    io.emit('state:update', updated);
    io.emit('state', updated);
    if (typeof cb === 'function') cb({ success: true, state: updated });
  });

  socket.on('resetDay', ({ pin }, cb) => {
    if (!requireSocketStaff(socket, cb, true)) return;
    if (pin && pin !== '1234') {
      if (typeof cb === 'function') cb({ success: false, error: 'Unauthorized PIN' });
      return;
    }
    const now = Date.now();
    db.prepare("UPDATE timetable SET st = 'ongoing', note = '', ts = ?").run(now);
    db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('notice', '');
    db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('demo_class_id', '2');
    addStatusLog('Schedule reset to default today preset');
    const updated = getFullTimetableState();
    persistDataJson(updated);
    io.emit('state:update', updated);
    io.emit('state', updated);
    if (typeof cb === 'function') cb({ success: true, state: updated });
  });
});

// ============================================================================
// PUBLIC /share PAGE (No Login Needed - Large QR Code & Tagline)
// ============================================================================
app.get('/share', async (req, res) => {
  try {
    const lanIp = getLanIp();
    const appUrl = `http://${lanIp}:${PORT}`;
    const qrDataUrl = await QRCode.toDataURL(appUrl, {
      width: 320,
      margin: 2,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>ClassPulse • Scan & Connect</title>
  <meta name="theme-color" content="#0f172a">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=JetBrains+Mono:wght@600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #090d16;
      color: #f1f5f9;
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px 16px;
      text-align: center;
    }
    .share-card {
      background: #111827;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 20px;
      padding: 32px 24px;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5), 0 0 40px rgba(37, 99, 235, 0.15);
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .brand-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(37, 99, 235, 0.12);
      border: 1px solid rgba(37, 99, 235, 0.3);
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 0.82rem;
      font-weight: 700;
      color: #60a5fa;
      margin-bottom: 16px;
    }
    .live-dot {
      width: 8px;
      height: 8px;
      background: #10b981;
      border-radius: 50%;
      box-shadow: 0 0 8px #10b981;
    }
    h1 {
      font-size: 1.6rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
      background: linear-gradient(135deg, #ffffff, #94a3b8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .tagline {
      font-size: 0.95rem;
      color: #94a3b8;
      line-height: 1.45;
      margin-bottom: 24px;
      font-weight: 500;
    }
    .qr-frame {
      background: #ffffff;
      padding: 14px;
      border-radius: 16px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
      margin-bottom: 20px;
      display: inline-block;
    }
    .qr-img {
      display: block;
      width: 240px;
      height: 240px;
      max-width: 100%;
    }
    .url-badge {
      background: #1e293b;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 10px 16px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.95rem;
      color: #38bdf8;
      word-break: break-all;
      margin-bottom: 20px;
      cursor: pointer;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .url-badge:hover {
      background: #334155;
    }
    .btn-open {
      display: inline-block;
      width: 100%;
      background: #2563eb;
      color: #ffffff;
      text-decoration: none;
      font-weight: 700;
      font-size: 0.92rem;
      padding: 12px 20px;
      border-radius: 10px;
      transition: background 0.2s;
      box-shadow: 0 4px 14px rgba(37, 99, 235, 0.4);
    }
    .btn-open:hover { background: #1d4ed8; }
    .instructions {
      font-size: 0.75rem;
      color: #64748b;
      margin-top: 16px;
    }
  </style>
</head>
<body>
  <div class="share-card">
    <div class="brand-pill">
      <span class="live-dot"></span> ClassPulse Network Live
    </div>
    <h1>Scan to Connect</h1>
    <p class="tagline">"One screen that tells a student what to do right now."</p>

    <div class="qr-frame">
      <img src="${qrDataUrl}" alt="ClassPulse QR Code" class="qr-img">
    </div>

    <div class="url-badge" id="urlBadge" onclick="copyUrl()" title="Click to copy">
      <span>${appUrl}</span>
      <span style="font-size: 0.8rem;">📋</span>
    </div>

    <a href="${appUrl}" class="btn-open">Open App Directly →</a>

    <p class="instructions">Connect to the same Wi-Fi / LAN, then scan this QR code or type the address into your phone browser.</p>
  </div>

  <script>
    function copyUrl() {
      navigator.clipboard.writeText('${appUrl}').then(() => {
        const badge = document.getElementById('urlBadge');
        const orig = badge.innerHTML;
        badge.innerHTML = '<span>Copied to Clipboard!</span> <span>✓</span>';
        badge.style.color = '#10b981';
        setTimeout(() => {
          badge.innerHTML = orig;
          badge.style.color = '#38bdf8';
        }, 2000);
      });
    }
  </script>
</body>
</html>`;

    res.send(html);
  } catch (err) {
    console.error('Error generating /share page:', err);
    res.status(500).send('Error generating QR share page');
  }
});

// ============================================================================
// ADMIN ONLY /demo CHEAT-SHEET PAGE (90-Second Demo Pitch Guide)
// ============================================================================
app.get('/demo', (req, res) => {
  const token = (req.cookies && req.cookies[COOKIE_NAME]) ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') && req.headers.authorization.split(' ')[1]);

  if (!token) {
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>ClassPulse • Admin Unlock</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #090d16; color: #f1f5f9; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px; }
    .card { background: #111827; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 24px; max-width: 400px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .btn { display: block; width: 100%; padding: 12px; border-radius: 8px; font-weight: 700; cursor: pointer; border: none; margin-top: 10px; font-size: 0.95rem; }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-secondary { background: #1e293b; color: #60a5fa; border: 1px solid rgba(255,255,255,0.1); text-decoration: none; text-align: center; }
    input { width: 100%; box-sizing: border-box; padding: 10px; background: #1e293b; border: 1px solid rgba(255,255,255,0.1); color: #fff; border-radius: 8px; margin-top: 4px; font-size: 0.95rem; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 0.72rem; font-weight: 800; color: #ef4444; letter-spacing: 0.05em; text-transform: uppercase;">🛡️ ADMIN PITCH CHEAT-SHEET</div>
    <h2 style="font-size: 1.3rem; font-weight: 800; margin: 6px 0 8px;">Admin Unlock</h2>
    <p style="font-size: 0.82rem; color: #94a3b8; margin-bottom: 16px;">Sign in as Campus Administrator to view the 90-second pitch guide on this device.</p>
    <form id="adminLoginForm">
      <div style="margin-bottom: 12px;">
        <label style="font-size: 0.78rem; font-weight: 700;">College ID</label>
        <input type="text" id="adminUid" value="ADMIN001" required>
      </div>
      <div style="margin-bottom: 14px;">
        <label style="font-size: 0.78rem; font-weight: 700;">Passkey</label>
        <input type="password" id="adminPasskey" value="admin123" required>
      </div>
      <button type="submit" class="btn btn-primary">🔓 Unlock Cheat-Sheet</button>
      <a href="/#/" class="btn btn-secondary">← Back to App</a>
    </form>
    <script>
      document.getElementById('adminLoginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const uid = document.getElementById('adminUid').value.trim();
        const passkey = document.getElementById('adminPasskey').value.trim();
        try {
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid, passkey, role: 'ADMIN' })
          });
          const data = await res.json();
          if (res.ok) {
            window.location.reload();
          } else {
            alert(data.error || 'Authentication failed');
          }
        } catch(err) {
          alert('Network error: ' + err.message);
        }
      });
    </script>
  </div>
</body>
</html>`);
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'ADMIN') {
      return res.status(403).send(`
        <!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>403 Forbidden</title>
        <style>body{background:#090d16;color:#f87171;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center;}</style>
        </head><body><div><h2>🛡️ Access Denied (403)</h2><p style="color:#94a3b8;margin-top:8px;">The /demo cheat-sheet is restricted to Campus Administrators only.</p><p style="margin-top:16px;"><a href="/#/" style="color:#60a5fa;">← Return to ClassPulse</a></p></div></body></html>
      `);
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>ClassPulse • 90-Second Demo Cheat-Sheet</title>
  <meta name="theme-color" content="#0f172a">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=JetBrains+Mono:wght@600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #090d16;
      color: #f1f5f9;
      font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
      padding: 16px;
      line-height: 1.5;
    }
    .container {
      max-width: 540px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #111827;
      padding: 14px 18px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .badge-admin {
      background: rgba(220, 38, 38, 0.15);
      border: 1px solid #ef4444;
      color: #f87171;
      font-size: 0.72rem;
      font-weight: 800;
      padding: 3px 8px;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .card {
      background: #111827;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 14px;
      padding: 18px;
    }
    .card h3 {
      font-size: 1.05rem;
      font-weight: 800;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .creds-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }
    .cred-row {
      background: #1e293b;
      padding: 10px 12px;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.85rem;
    }
    .cred-role { font-weight: 700; color: #94a3b8; }
    .cred-val {
      font-family: 'JetBrains Mono', monospace;
      color: #38bdf8;
      font-weight: 700;
      background: rgba(0,0,0,0.3);
      padding: 2px 6px;
      border-radius: 4px;
    }
    .timeline {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .step-item {
      border-left: 3px solid #2563eb;
      padding-left: 14px;
      position: relative;
    }
    .step-time {
      font-size: 0.75rem;
      font-family: 'JetBrains Mono', monospace;
      font-weight: 700;
      color: #f59e0b;
    }
    .step-title {
      font-size: 0.92rem;
      font-weight: 800;
      color: #ffffff;
      margin: 2px 0 4px 0;
    }
    .step-desc {
      font-size: 0.8rem;
      color: #94a3b8;
    }
    .step-desc strong { color: #e2e8f0; }
    .btn-reset {
      background: #dc2626;
      color: #fff;
      border: none;
      padding: 12px;
      border-radius: 10px;
      font-weight: 800;
      font-size: 0.95rem;
      cursor: pointer;
      width: 100%;
      transition: background 0.2s;
    }
    .btn-reset:hover { background: #b91c1c; }
    .nav-actions {
      display: flex;
      gap: 10px;
      margin-top: 8px;
    }
    .nav-actions a {
      flex: 1;
      text-align: center;
      padding: 10px;
      background: #1e293b;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      color: #60a5fa;
      text-decoration: none;
      font-size: 0.85rem;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <div>
        <h2 style="font-size: 1.15rem; font-weight: 800;">🎙️ Demo Pitch Cheat-Sheet</h2>
        <span style="font-size: 0.75rem; color: #94a3b8;">ClassPulse 90-Second Demo Script</span>
      </div>
      <span class="badge-admin">Admin Only</span>
    </div>

    <!-- 1. DEMO LOGINS -->
    <div class="card">
      <h3>🔑 Demo Logins (Passkeys)</h3>
      <div class="creds-grid">
        <div class="cred-row">
          <span class="cred-role">🎓 Student (Organiser)</span>
          <span class="cred-val">STU001 / stu123</span>
        </div>
        <div class="cred-row">
          <span class="cred-role">👨‍🏫 Faculty (Prof. Rao)</span>
          <span class="cred-val">FAC001 / fac123</span>
        </div>
        <div class="cred-row">
          <span class="cred-role">🛡️ Admin (System)</span>
          <span class="cred-val">ADMIN001 / admin123</span>
        </div>
        <div class="cred-row">
          <span class="cred-role">🎓 Student 2 (Peer)</span>
          <span class="cred-val">STU002 / stu123</span>
        </div>
      </div>
    </div>

    <!-- 2. 90-SECOND DEMO STEPS -->
    <div class="card">
      <h3>⏱️ 90-Second Demo Flow</h3>
      <div class="timeline">
        <div class="step-item">
          <div class="step-time">00:00 - 00:20 (20s)</div>
          <div class="step-title">1. The Hook — Right Now Hero Directive</div>
          <div class="step-desc">Open as <strong>Student (STU001)</strong>. Point out the hero directive: exactly which room/course right now. Show the <strong>To-Do list</strong> (assignments due) & <strong>Attendance alert</strong> (&lt;75%).</div>
        </div>

        <div class="step-item">
          <div class="step-time">00:20 - 00:45 (25s)</div>
          <div class="step-title">2. Live Status Sync (No Page Reload)</div>
          <div class="step-desc">Open second screen as <strong>Faculty (FAC001)</strong>. Mark period as <strong>Faculty Absent</strong> with note <em>"Medical leave - study ch 4"</em>. Student screen updates <strong>instantly in real time</strong> with audible chime!</div>
        </div>

        <div class="step-item">
          <div class="step-time">00:45 - 01:10 (25s)</div>
          <div class="step-title">3. Google Classroom & Instant Return</div>
          <div class="step-desc">Faculty creates an assignment. Student submits answer. Faculty grades <strong>95/100</strong> and hits <strong>Return</strong>. Student immediately gets grade badge & bell notification.</div>
        </div>

        <div class="step-item">
          <div class="step-time">01:10 - 01:25 (15s)</div>
          <div class="step-title">4. Campus Life & Live RSVP</div>
          <div class="step-desc">Click <strong>Campus Events</strong>. Show trending hackathon. Student taps <strong>Register</strong> &mdash; available seats decrement live across all devices.</div>
        </div>

        <div class="step-item">
          <div class="step-time">01:25 - 01:30 (5s)</div>
          <div class="step-title">5. Five-Second Reset</div>
          <div class="step-desc">Hit the red <strong>Reset Demo Data</strong> button below. Everything restores to clean seed data in 5 seconds ready for the next judge!</div>
        </div>
      </div>
    </div>

    <!-- 3. INSTANT RESET BUTTON -->
    <div class="card" style="border-color: rgba(220, 38, 38, 0.4);">
      <h3 style="color: #ef4444;">🔄 5-Second Demo Reset</h3>
      <p style="font-size: 0.8rem; color: #94a3b8; margin-bottom: 12px;">Restores all users, courses, attendance, marks, events, and classroom items back to clean seed data.</p>
      <button class="btn-reset" onclick="resetDemoData()">⚡ Reset Demo Data Now</button>
    </div>

    <div class="nav-actions">
      <a href="/share" target="_blank">📱 Show QR / Share Page</a>
      <a href="/#/">💻 Open App</a>
    </div>
  </div>

  <script>
    async function resetDemoData() {
      if (!confirm('Are you sure you want to reset all demo data? This clears notices, logs, and restores pristine seed data.')) return;
      try {
        const res = await fetch('/api/admin/reset-demo', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const data = await res.json();
        if (res.ok) {
          alert('✅ Demo data successfully restored in 5 seconds!');
        } else {
          alert('❌ Reset failed: ' + (data.error || 'Server error'));
        }
      } catch (err) {
        alert('❌ Network error: ' + err.message);
      }
    }
  </script>
</body>
</html>`;

    res.send(html);
  } catch (err) {
    res.redirect('/#login');
  }
});

// SPA Catch-all Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Launch HTTP Server
server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  console.log('\n=============================================================');
  console.log('  🎓 ClassPulse - Classroom & Real-Time Status Platform');
  console.log('  ⚡ PHASE 6: Campus Events & Trending Active');
  console.log('=============================================================');
  console.log(`  > Local:            http://localhost:${PORT}`);
  console.log(`  > On Your Network:  http://${lanIp}:${PORT}`);
  console.log('  > Demo Logins:');
  console.log('      - Admin:   ADMIN001 / admin123');
  console.log('      - Faculty: FAC001   / fac123 (Prof. Rao)');
  console.log('      - Student: STU001   / stu123 (Aarav Sharma - Organiser)');
  console.log('=============================================================\n');
});
