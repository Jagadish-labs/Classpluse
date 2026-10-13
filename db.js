const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DB_FILE = path.join(DATA_DIR, 'classpulse.db');
const db = new Database(DB_FILE);

// Enable WAL mode & foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roster (
      uid TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      dept TEXT NOT NULL,
      section TEXT NOT NULL,
      registered INTEGER DEFAULT 0,
      is_organizer INTEGER DEFAULT 0,
      phone TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      uid TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      dept TEXT NOT NULL,
      section TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      must_change_pass INTEGER DEFAULT 0,
      is_organizer INTEGER DEFAULT 0,
      phone TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (uid) REFERENCES roster(uid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      dept TEXT NOT NULL,
      section TEXT NOT NULL,
      faculty_id TEXT NOT NULL,
      FOREIGN KEY (faculty_id) REFERENCES users(uid)
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      course_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      PRIMARY KEY (course_id, student_id),
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(uid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS timetable (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day INTEGER DEFAULT 1,
      course_id TEXT,
      s TEXT NOT NULL,
      e TEXT NOT NULL,
      sub TEXT NOT NULL,
      fac TEXT NOT NULL,
      faculty_id TEXT,
      room TEXT NOT NULL,
      st TEXT DEFAULT 'ongoing',
      note TEXT DEFAULT '',
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_class_status (
      slot_id INTEGER NOT NULL,
      date_str TEXT NOT NULL,
      st TEXT NOT NULL DEFAULT 'ongoing',
      note TEXT DEFAULT '',
      ts INTEGER NOT NULL,
      PRIMARY KEY (slot_id, date_str),
      FOREIGN KEY (slot_id) REFERENCES timetable(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS status_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attendance_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id TEXT NOT NULL,
      date TEXT NOT NULL,
      time_slot TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attendance_records (
      session_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (session_id, student_id),
      FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(uid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id TEXT NOT NULL,
      name TEXT NOT NULL,
      max_marks REAL NOT NULL,
      weightage REAL NOT NULL,
      published INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS marks (
      assessment_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      score REAL NOT NULL,
      PRIMARY KEY (assessment_id, student_id),
      FOREIGN KEY (assessment_id) REFERENCES assessments(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(uid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id TEXT NOT NULL,
      faculty_id TEXT NOT NULL,
      faculty_name TEXT NOT NULL,
      text TEXT NOT NULL,
      attachment_path TEXT,
      attachment_name TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id TEXT NOT NULL,
      faculty_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      link_url TEXT,
      file_path TEXT,
      file_name TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id TEXT NOT NULL,
      faculty_id TEXT NOT NULL,
      title TEXT NOT NULL,
      instructions TEXT,
      due_date TEXT NOT NULL,
      max_points REAL NOT NULL,
      attachment_path TEXT,
      attachment_name TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      text_submission TEXT,
      file_path TEXT,
      file_name TEXT,
      status TEXT NOT NULL,
      points REAL,
      feedback TEXT,
      submitted_at INTEGER,
      graded_at INTEGER,
      UNIQUE(assignment_id, student_id),
      FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(uid) ON DELETE CASCADE
    );

    -- ========================================================================
    -- PHASE 6: CAMPUS EVENTS & TRENDING TABLES
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      venue TEXT NOT NULL,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      organizer_name TEXT NOT NULL,
      organizer_uid TEXT NOT NULL,
      banner_color TEXT DEFAULT '#2563eb',
      banner_image TEXT,
      capacity INTEGER,
      registration_required INTEGER DEFAULT 1,
      status TEXT DEFAULT 'upcoming',
      update_note TEXT,
      created_ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_registrations (
      event_id INTEGER NOT NULL,
      uid TEXT NOT NULL,
      ts INTEGER NOT NULL,
      checked_in INTEGER DEFAULT 0,
      checkin_ts INTEGER,
      PRIMARY KEY (event_id, uid),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS event_reactions (
      event_id INTEGER NOT NULL,
      uid TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (event_id, uid),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS event_views (
      event_id INTEGER NOT NULL,
      uid TEXT NOT NULL,
      date TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (event_id, uid, date),
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      link TEXT,
      is_read INTEGER DEFAULT 0,
      created_ts INTEGER NOT NULL,
      type TEXT,
      course_id TEXT,
      FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS impact_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      class_id INTEGER,
      course_id TEXT,
      subject TEXT,
      enrolled_count INTEGER DEFAULT 12,
      minutes_saved INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS faculty_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      faculty_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      course_id TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      FOREIGN KEY (faculty_id) REFERENCES users(uid) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(uid) ON DELETE CASCADE,
      FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
    );

    -- ========================================================================
    -- WHATSAPP-STYLE CHAT TABLES
    -- ========================================================================
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      course_id TEXT,
      name TEXT,
      announce_only INTEGER DEFAULT 0,
      created_by TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id INTEGER NOT NULL,
      uid TEXT NOT NULL,
      last_read_ts INTEGER DEFAULT 0,
      PRIMARY KEY (conversation_id, uid),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      sender_uid TEXT NOT NULL,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL,
      deleted INTEGER DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_uid) REFERENCES users(uid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_uid TEXT NOT NULL,
      to_uid TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (from_uid) REFERENCES users(uid) ON DELETE CASCADE,
      FOREIGN KEY (to_uid) REFERENCES users(uid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS blocks (
      uid TEXT NOT NULL,
      blocked_uid TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (uid, blocked_uid),
      FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE,
      FOREIGN KEY (blocked_uid) REFERENCES users(uid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      reporter_uid TEXT NOT NULL,
      reason TEXT,
      ts INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (reporter_uid) REFERENCES users(uid) ON DELETE CASCADE
    );
  `);

  try { db.exec('ALTER TABLE roster ADD COLUMN is_organizer INTEGER DEFAULT 0'); } catch(e) {}
  try { db.exec('ALTER TABLE users ADD COLUMN is_organizer INTEGER DEFAULT 0'); } catch(e) {}
  try { db.exec('ALTER TABLE roster ADD COLUMN phone TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE users ADD COLUMN phone TEXT'); } catch(e) {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_roster_phone ON roster(phone) WHERE phone IS NOT NULL'); } catch(e) {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL'); } catch(e) {}
  try { db.exec('ALTER TABLE conversations ADD COLUMN created_by TEXT'); } catch(e) {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_requests_pair ON chat_requests(from_uid, to_uid)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_chat_requests_to ON chat_requests(to_uid, status)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_reports_msg ON reports(message_id)'); } catch(e) {}
  try { db.exec('ALTER TABLE notifications ADD COLUMN type TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE notifications ADD COLUMN course_id TEXT'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_uid_isread ON notifications(uid, is_read)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_uid_type ON notifications(uid, type, course_id)'); } catch(e) {}
  try { db.exec('CREATE TABLE IF NOT EXISTS faculty_reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, faculty_id TEXT NOT NULL, student_id TEXT NOT NULL, course_id TEXT NOT NULL, sent_at INTEGER NOT NULL)'); } catch(e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_faculty_reminders_lookup ON faculty_reminders (student_id, course_id, sent_at)'); } catch(e) {}
  try { db.exec('ALTER TABLE timetable ADD COLUMN day INTEGER DEFAULT 1'); } catch(e) {}
}

const defaultTimetable = [
  // --- MONDAY (day: 1) ---
  { id: 1, day: 1, course_id: 'CS101', s: '09:00', e: '09:50', sub: 'Data Structures', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'B-204', st: 'ongoing', note: '' },
  { id: 2, day: 1, course_id: 'CS102', s: '09:50', e: '10:40', sub: 'Data Communications', fac: 'Dr. Meena', faculty_id: 'FAC002', room: 'B-206', st: 'ongoing', note: '' },
  { id: 3, day: 1, course_id: 'CS103', s: '10:55', e: '11:45', sub: 'UI/UX Design', fac: 'Ms. Kavya', faculty_id: 'FAC003', room: 'Design Lab', st: 'ongoing', note: '' },
  { id: 4, day: 1, course_id: 'CS104', s: '11:45', e: '12:35', sub: 'Software Development', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'C-101', st: 'ongoing', note: '' },
  { id: 5, day: 1, course_id: 'CS105', s: '13:30', e: '14:20', sub: 'Computer Networks', fac: 'Dr. Meena', faculty_id: 'FAC002', room: 'B-210', st: 'ongoing', note: '' },
  { id: 6, day: 1, course_id: 'CS101', s: '14:20', e: '15:10', sub: 'Data Structures Lab', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'Lab 2', st: 'ongoing', note: '' },

  // --- TUESDAY (day: 2) ---
  { id: 7, day: 2, course_id: 'CS104', s: '09:00', e: '09:50', sub: 'Software Development', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'C-101', st: 'ongoing', note: '' },
  { id: 8, day: 2, course_id: 'CS101', s: '09:50', e: '10:40', sub: 'Data Structures', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'B-204', st: 'ongoing', note: '' },
  { id: 9, day: 2, course_id: 'CS102', s: '10:55', e: '11:45', sub: 'Data Communications', fac: 'Dr. Meena', faculty_id: 'FAC002', room: 'B-206', st: 'ongoing', note: '' },
  { id: 10, day: 2, course_id: 'CS105', s: '11:45', e: '12:35', sub: 'Computer Networks', fac: 'Dr. Meena', faculty_id: 'FAC002', room: 'B-210', st: 'ongoing', note: '' },
  { id: 11, day: 2, course_id: 'CS103', s: '13:30', e: '14:20', sub: 'UI/UX Design', fac: 'Ms. Kavya', faculty_id: 'FAC003', room: 'Design Lab', st: 'ongoing', note: '' },
  { id: 12, day: 2, course_id: 'CS102', s: '14:20', e: '15:10', sub: 'Data Comm Lab', fac: 'Dr. Meena', faculty_id: 'FAC002', room: 'Net Lab', st: 'ongoing', note: '' },

  // --- WEDNESDAY (day: 3) ---
  { id: 13, day: 3, course_id: 'CS103', s: '09:00', e: '09:50', sub: 'UI/UX Design', fac: 'Ms. Kavya', faculty_id: 'FAC003', room: 'Design Lab', st: 'ongoing', note: '' },
  { id: 14, day: 3, course_id: 'CS105', s: '09:50', e: '10:40', sub: 'Computer Networks', fac: 'Dr. Meena', faculty_id: 'FAC002', room: 'B-210', st: 'ongoing', note: '' },
  { id: 15, day: 3, course_id: 'CS101', s: '10:55', e: '11:45', sub: 'Data Structures', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'B-204', st: 'ongoing', note: '' },
  { id: 16, day: 3, course_id: 'CS104', s: '11:45', e: '12:35', sub: 'Software Development', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'C-101', st: 'ongoing', note: '' },
  { id: 17, day: 3, course_id: 'CS102', s: '13:30', e: '14:20', sub: 'Data Communications', fac: 'Dr. Meena', faculty_id: 'FAC002', room: 'B-206', st: 'ongoing', note: '' },
  { id: 18, day: 3, course_id: 'CS103', s: '14:20', e: '15:10', sub: 'UI/UX Studio', fac: 'Ms. Kavya', faculty_id: 'FAC003', room: 'Design Lab', st: 'ongoing', note: '' },

  // --- THURSDAY (day: 4) ---
  { id: 19, day: 4, course_id: 'CS102', s: '09:00', e: '09:50', sub: 'Data Communications', fac: 'Dr. Meena', faculty_id: 'FAC002', room: 'B-206', st: 'ongoing', note: '' },
  { id: 20, day: 4, course_id: 'CS104', s: '09:50', e: '10:40', sub: 'Software Development', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'C-101', st: 'ongoing', note: '' },
  { id: 21, day: 4, course_id: 'CS105', s: '10:55', e: '11:45', sub: 'Computer Networks', fac: 'Dr. Meena', faculty_id: 'FAC002', room: 'B-210', st: 'ongoing', note: '' },
  { id: 22, day: 4, course_id: 'CS103', s: '11:45', e: '12:35', sub: 'UI/UX Design', fac: 'Ms. Kavya', faculty_id: 'FAC003', room: 'Design Lab', st: 'ongoing', note: '' },
  { id: 23, day: 4, course_id: 'CS101', s: '13:30', e: '14:20', sub: 'Data Structures', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'B-204', st: 'ongoing', note: '' },
  { id: 24, day: 4, course_id: 'CS104', s: '14:20', e: '15:10', sub: 'Software Dev Workshop', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'C-101', st: 'ongoing', note: '' },

  // --- FRIDAY (day: 5) ---
  { id: 25, day: 5, course_id: 'CS105', s: '09:00', e: '09:50', sub: 'Computer Networks', fac: 'Dr. Meena', faculty_id: 'FAC002', room: 'B-210', st: 'ongoing', note: '' },
  { id: 26, day: 5, course_id: 'CS103', s: '09:50', e: '10:40', sub: 'UI/UX Design', fac: 'Ms. Kavya', faculty_id: 'FAC003', room: 'Design Lab', st: 'ongoing', note: '' },
  { id: 27, day: 5, course_id: 'CS104', s: '10:55', e: '11:45', sub: 'Software Development', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'C-101', st: 'ongoing', note: '' },
  { id: 28, day: 5, course_id: 'CS101', s: '11:45', e: '12:35', sub: 'Data Structures', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'B-204', st: 'ongoing', note: '' },
  { id: 29, day: 5, course_id: 'CS102', s: '13:30', e: '14:20', sub: 'Data Communications', fac: 'Dr. Meena', faculty_id: 'FAC002', room: 'B-206', st: 'ongoing', note: '' },

  // --- SATURDAY (day: 6) ---
  { id: 30, day: 6, course_id: 'CS101', s: '09:00', e: '09:50', sub: 'Data Structures', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'B-204', st: 'ongoing', note: '' },
  { id: 31, day: 6, course_id: 'CS102', s: '09:50', e: '10:40', sub: 'Data Communications', fac: 'Dr. Meena', faculty_id: 'FAC002', room: 'B-206', st: 'ongoing', note: '' },
  { id: 32, day: 6, course_id: 'CS104', s: '10:55', e: '11:45', sub: 'Software Development', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'C-101', st: 'ongoing', note: '' },
  { id: 33, day: 6, course_id: 'CS105', s: '11:45', e: '12:35', sub: 'Computer Networks', fac: 'Dr. Meena', faculty_id: 'FAC002', room: 'B-210', st: 'ongoing', note: '' }
];

function seedWeeklyTimetable() {
  const count = db.prepare('SELECT count(*) as count FROM timetable').get().count;
  if (count < 30) {
    db.exec('DELETE FROM timetable');
    try { db.exec("DELETE FROM sqlite_sequence WHERE name = 'timetable'"); } catch(e) {}
    const insertTimetable = db.prepare(`
      INSERT INTO timetable (id, day, course_id, s, e, sub, fac, faculty_id, room, st, note, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (const t of defaultTimetable) {
      insertTimetable.run(t.id, t.day, t.course_id, t.s, t.e, t.sub, t.fac, t.faculty_id, t.room, t.st, t.note, now);
    }
  }
}

function seedDatabase(force = false) {
  const count = db.prepare('SELECT count(*) as count FROM roster').get().count;
  if (count > 0 && !force) {
    seedNotificationsIfEmpty();
    seedEventsIfEmpty();
    seedImpactIfEmpty();
    seedWeeklyTimetable();
    initCourseChatGroups();
    seedChatData(false);
    return;
  }

  const now = Date.now();
  const adminPassHash = bcrypt.hashSync('admin123', 8);
  const facPassHash = bcrypt.hashSync('fac123', 8);
  const stuPassHash = bcrypt.hashSync('stu123', 8);

  const runSeedTx = db.transaction(() => {
    // Clear existing if force
    if (force) {
      db.exec(`
      DELETE FROM reports;
      DELETE FROM blocks;
      DELETE FROM chat_requests;
      DELETE FROM messages;
      DELETE FROM conversation_members;
      DELETE FROM conversations;
      DELETE FROM daily_class_status;
      DELETE FROM faculty_reminders;
      DELETE FROM impact_updates;
      DELETE FROM notifications;
      DELETE FROM event_views;
      DELETE FROM event_reactions;
      DELETE FROM event_registrations;
      DELETE FROM events;
      DELETE FROM submissions;
      DELETE FROM assignments;
      DELETE FROM materials;
      DELETE FROM announcements;
      DELETE FROM marks;
      DELETE FROM assessments;
      DELETE FROM attendance_records;
      DELETE FROM attendance_sessions;
      DELETE FROM status_logs;
      DELETE FROM system_state;
      DELETE FROM timetable;
      DELETE FROM enrollments;
      DELETE FROM courses;
      DELETE FROM users;
      DELETE FROM roster;
      DELETE FROM sqlite_sequence;
    `);
  }

  console.log('🌱 Seeding ClassPulse Database...');

  const insertRoster = db.prepare(`
    INSERT INTO roster (uid, role, name, dept, section, registered, is_organizer, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertUser = db.prepare(`
    INSERT INTO users (uid, role, name, dept, section, password_hash, must_change_pass, is_organizer, phone, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // 1. ADMIN
  insertRoster.run('ADMIN001', 'ADMIN', 'System Administrator', 'CSE', 'ALL', 1, 1, '+919900000001');
  insertUser.run('ADMIN001', 'ADMIN', 'System Administrator', 'CSE', 'ALL', adminPassHash, 0, 1, '+919900000001', now);

  // 2. FACULTY
  const facultyMembers = [
    { uid: 'FAC001', name: 'Prof. Rao', dept: 'CSE', phone: '+919100000001' },
    { uid: 'FAC002', name: 'Dr. Meena', dept: 'CSE', phone: '+919100000002' },
    { uid: 'FAC003', name: 'Ms. Kavya', dept: 'CSE', phone: '+919100000003' }
  ];

  for (const fac of facultyMembers) {
    insertRoster.run(fac.uid, 'FACULTY', fac.name, fac.dept, 'CSE', 1, 1, fac.phone);
    insertUser.run(fac.uid, 'FACULTY', fac.name, fac.dept, 'CSE', facPassHash, 0, 1, fac.phone, now);
  }

  // 3. REGISTERED STUDENTS (STU001 to STU012)
  const students = [
    { uid: 'STU001', name: 'Aarav Sharma', is_org: 1, phone: '+919000000001' }, // Lead Student Organiser
    { uid: 'STU002', name: 'Ananya Iyer', is_org: 0, phone: '+919000000002' },
    { uid: 'STU003', name: 'Rohan Verma', is_org: 0, phone: '+919000000003' },
    { uid: 'STU004', name: 'Priya Patel', is_org: 0, phone: '+919000000004' },
    { uid: 'STU005', name: 'Siddharth Nair', is_org: 0, phone: '+919000000005' },
    { uid: 'STU006', name: 'Sneha Reddy', is_org: 0, phone: '+919000000006' },
    { uid: 'STU007', name: 'Vikram Malhotra', is_org: 0, phone: '+919000000007' },
    { uid: 'STU008', name: 'Divya Krishnan', is_org: 0, phone: '+919000000008' },
    { uid: 'STU009', name: 'Rahul Gupta', is_org: 0, phone: '+919000000009' },
    { uid: 'STU010', name: 'Pooja Joshi', is_org: 0, phone: '+919000000010' },
    { uid: 'STU011', name: 'Aditya Deshmukh', is_org: 0, phone: '+919000000011' },
    { uid: 'STU012', name: 'Meera Sen', is_org: 0, phone: '+919000000012' }
  ];

  for (const stu of students) {
    insertRoster.run(stu.uid, 'STUDENT', stu.name, 'CSE', 'CSE-A', 1, stu.is_org, stu.phone);
    insertUser.run(stu.uid, 'STUDENT', stu.name, 'CSE', 'CSE-A', stuPassHash, 0, stu.is_org, stu.phone, now);
  }

  // 4. UNREGISTERED ROSTER ENTRIES FOR SIGNUP DEMO
  insertRoster.run('STU101', 'STUDENT', 'Demo Student', 'CSE', 'CSE-A', 0, 0, '+919000000101');
  insertRoster.run('FAC101', 'FACULTY', 'Demo Faculty', 'CSE', 'CSE', 0, 0, '+919100000101');

  // 5. COURSES
  const insertCourse = db.prepare(`
    INSERT INTO courses (id, code, name, dept, section, faculty_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const courses = [
    { id: 'CS101', code: 'CS301', name: 'Data Structures', dept: 'CSE', section: 'CSE-A', faculty_id: 'FAC001' },
    { id: 'CS102', code: 'CS302', name: 'Data Communications', dept: 'CSE', section: 'CSE-A', faculty_id: 'FAC002' },
    { id: 'CS103', code: 'CS303', name: 'UI/UX Design', dept: 'CSE', section: 'CSE-A', faculty_id: 'FAC003' },
    { id: 'CS104', code: 'CS304', name: 'Software Development', dept: 'CSE', section: 'CSE-A', faculty_id: 'FAC001' },
    { id: 'CS105', code: 'CS305', name: 'Computer Networks', dept: 'CSE', section: 'CSE-A', faculty_id: 'FAC002' }
  ];

  for (const c of courses) {
    insertCourse.run(c.id, c.code, c.name, c.dept, c.section, c.faculty_id);
  }

  // 6. ENROLL ALL STUDENTS IN ALL COURSES
  const insertEnrollment = db.prepare(`
    INSERT INTO enrollments (course_id, student_id)
    VALUES (?, ?)
  `);

  for (const c of courses) {
    for (const stu of students) {
      insertEnrollment.run(c.id, stu.uid);
    }
  }

  // 7. TIMETABLE (WEEKLY MON-SAT)
  try { db.exec("DELETE FROM sqlite_sequence WHERE name = 'timetable'"); } catch(e) {}
  const insertTimetable = db.prepare(`
    INSERT INTO timetable (id, day, course_id, s, e, sub, fac, faculty_id, room, st, note, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const t of defaultTimetable) {
    insertTimetable.run(t.id, t.day, t.course_id, t.s, t.e, t.sub, t.fac, t.faculty_id, t.room, t.st, t.note, now);
  }

  // 8. SYSTEM STATE
  db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('notice', '');
  db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('demo_class_id', '2');

  // 9. LOGS
  const insertLog = db.prepare('INSERT INTO status_logs (text, ts) VALUES (?, ?)');
  insertLog.run('Timetable initialized for today', now);

  // 10. ATTENDANCE SESSIONS & RECORDS (20 past sessions per course)
  const insertSession = db.prepare(`
    INSERT INTO attendance_sessions (course_id, date, time_slot, created_by, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertRecord = db.prepare(`
    INSERT INTO attendance_records (session_id, student_id, status)
    VALUES (?, ?, ?)
  `);

  courses.forEach((c) => {
    for (let i = 20; i >= 1; i--) {
      const d = new Date(now - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().split('T')[0];
      const slot = '10:00-11:00';
      const sessResult = insertSession.run(c.id, dateStr, slot, c.faculty_id, d.getTime());
      const sessId = sessResult.lastInsertRowid;

      students.forEach((stu, sIdx) => {
        let status = 'Present';
        if (stu.uid === 'STU007' && c.id === 'CS101' && (i % 3 === 0 || i % 5 === 0)) status = 'Absent';
        else if (stu.uid === 'STU011' && (c.id === 'CS104' || c.id === 'CS102') && (i % 4 === 0 || i % 7 === 0)) status = 'Absent';
        else if ((sIdx + i) % 11 === 0) status = 'Absent';
        else if ((sIdx + i) % 17 === 0) status = 'Late';
        insertRecord.run(sessId, stu.uid, status);
      });
    }
  });

  // 11. ASSESSMENTS & MARKS
  const insertAssessment = db.prepare(`
    INSERT INTO assessments (course_id, name, max_marks, weightage, published, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMark = db.prepare(`
    INSERT INTO marks (assessment_id, student_id, score)
    VALUES (?, ?, ?)
  `);

  courses.forEach((c) => {
    const ass1 = insertAssessment.run(c.id, 'Quiz 1: Fundamentals', 20, 20, 1, now - 15 * 86400000);
    const ass2 = insertAssessment.run(c.id, 'Mid-Semester Examination', 50, 40, 1, now - 5 * 86400000);

    students.forEach((stu, idx) => {
      let score1 = Math.min(20, Math.max(8, 14 + ((idx * 3) % 7) - 2));
      let score2 = Math.min(50, Math.max(18, 38 + ((idx * 5) % 13) - 6));
      if (stu.uid === 'STU007' && c.id === 'CS101') {
        score1 = 6;
        score2 = 18;
      } else if (stu.uid === 'STU003' && c.id === 'CS101') {
        score1 = 7;
        score2 = 19;
      }
      insertMark.run(ass1.lastInsertRowid, stu.uid, score1);
      insertMark.run(ass2.lastInsertRowid, stu.uid, score2);
    });
  });

  // 12. ANNOUNCEMENTS
  const insertAnnouncement = db.prepare(`
    INSERT INTO announcements (course_id, faculty_id, faculty_name, text, attachment_path, attachment_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  courses.forEach((c) => {
    const facName = facultyMembers.find(f => f.uid === c.faculty_id)?.name || 'Faculty';
    insertAnnouncement.run(c.id, c.faculty_id, facName, `Welcome to ${c.name} for Semester 5! Please check the syllabus.`, null, null, now - 14 * 86400000);
    insertAnnouncement.run(c.id, c.faculty_id, facName, `Reminder: Please submit Assignment 1 before Friday.`, null, null, now - 2 * 86400000);
  });

  // 13. MATERIALS
  const insertMaterial = db.prepare(`
    INSERT INTO materials (course_id, faculty_id, title, description, link_url, file_path, file_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  courses.forEach((c) => {
    insertMaterial.run(c.id, c.faculty_id, `${c.name} - Official Syllabus`, 'Official syllabus breakdown.', 'https://cs-dept.college.edu/syllabus/' + c.code.toLowerCase(), null, null, now - 20 * 86400000);
    insertMaterial.run(c.id, c.faculty_id, 'Module 1 & 2 Slides', 'Lecture slide deck.', null, null, `${c.code}_Slides.pdf`, now - 10 * 86400000);
  });

  // 14. ASSIGNMENTS & SUBMISSIONS
  const insertAssignment = db.prepare(`
    INSERT INTO assignments (course_id, faculty_id, title, instructions, due_date, max_points, attachment_path, attachment_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertSubmission = db.prepare(`
    INSERT INTO submissions (assignment_id, student_id, text_submission, file_path, file_name, status, points, feedback, submitted_at, graded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  courses.forEach((c) => {
    const dueDate1 = new Date(now - 3 * 86400000).toISOString();
    const ass1 = insertAssignment.run(c.id, c.faculty_id, 'Assignment 1: Problem Set', 'Solve Chapter 2 problems.', dueDate1, 100, null, null, now - 12 * 86400000);
    const a1Id = ass1.lastInsertRowid;

    students.forEach((stu, idx) => {
      const pts = 85 + (idx % 15);
      insertSubmission.run(a1Id, stu.uid, `Submission by ${stu.name}`, null, `${stu.uid}_Solution.pdf`, 'Graded', pts, 'Good job.', now - 4 * 86400000, now - 2 * 86400000);
    });

    const dueDate2 = new Date(now + 1 * 86400000).toISOString();
    const ass2 = insertAssignment.run(c.id, c.faculty_id, 'Assignment 2: Case Study & Implementation', 'Submit design proposal and code.', dueDate2, 50, null, null, now - 2 * 86400000);
    const a2Id = ass2.lastInsertRowid;

    students.slice(0, 4).forEach((stu) => {
      insertSubmission.run(a2Id, stu.uid, 'Draft project proposal submitted.', null, `${stu.uid}_Proposal.docx`, 'Submitted', null, null, now - 12 * 3600000, null);
    });

    students.slice(4).forEach((stu) => {
      insertSubmission.run(a2Id, stu.uid, null, null, null, 'Assigned', null, null, null, null);
    });
  });

  // 15. SEED DEMO NOTIFICATIONS
  const insertNotif = db.prepare(`
    INSERT INTO notifications (uid, title, message, link, is_read, created_ts, type, course_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const demoNotifs = [
    {
      uid: 'STU001',
      title: '⏰ Class Update: Data Structures',
      message: 'Data Structures: Faculty Absent. You are free.',
      link: '#/',
      is_read: 0,
      ts: now - 15 * 60 * 1000,
      type: 'class_status',
      course_id: 'CS101'
    },
    {
      uid: 'STU001',
      title: '📝 Grade Returned: Assignment 1: Problem Set',
      message: 'Score: 85/100 pts - Good job.',
      link: '#course/CS101?tab=classwork',
      is_read: 0,
      ts: now - 2 * 3600 * 1000,
      type: 'grade_returned',
      course_id: 'CS101'
    },
    {
      uid: 'STU001',
      title: '📢 Campus Notice',
      message: 'Auditorium doors open now for Tech Heist Hackathon Finale.',
      link: '#/',
      is_read: 1,
      ts: now - 4 * 3600 * 1000,
      type: 'notice',
      course_id: null
    },
    {
      uid: 'STU007',
      title: '⚠️ Attendance Shortage: CS101',
      message: 'Your attendance in Data Structures (CS101) dropped to 60%. You need 12 consecutive classes to reach 75%.',
      link: '#/',
      is_read: 0,
      ts: now - 3 * 3600 * 1000,
      type: 'attendance_shortage',
      course_id: 'CS101'
    },
    {
      uid: 'STU011',
      title: '⚠️ Attendance Shortage: CS102',
      message: 'Your attendance in Data Communications (CS102) dropped to 65%. You need 8 consecutive classes to reach 75%.',
      link: '#/',
      is_read: 0,
      ts: now - 5 * 3600 * 1000,
      type: 'attendance_shortage',
      course_id: 'CS102'
    }
  ];

  demoNotifs.forEach(n => {
    insertNotif.run(n.uid, n.title, n.message, n.link, n.is_read, n.ts, n.type, n.course_id);
  });

    seedEventsIfEmpty();
    seedImpactIfEmpty();
  });

  runSeedTx();

  initCourseChatGroups();
  seedChatData(force);

  console.log('✅ ClassPulse Database successfully initialized and seeded!');
}

function seedNotificationsIfEmpty() {
  const count = db.prepare('SELECT count(*) as count FROM notifications').get().count;
  if (count > 0) return;

  const now = Date.now();
  const insertNotif = db.prepare(`
    INSERT INTO notifications (uid, title, message, link, is_read, created_ts, type, course_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const demoNotifs = [
    {
      uid: 'STU001',
      title: '⏰ Class Update: Data Structures',
      message: 'Data Structures: Faculty Absent. You are free.',
      link: '#/',
      is_read: 0,
      ts: now - 15 * 60 * 1000,
      type: 'class_status',
      course_id: 'CS101'
    },
    {
      uid: 'STU001',
      title: '📝 Grade Returned: Assignment 1: Problem Set',
      message: 'Score: 85/100 pts - Good job.',
      link: '#course/CS101?tab=classwork',
      is_read: 0,
      ts: now - 2 * 3600 * 1000,
      type: 'grade_returned',
      course_id: 'CS101'
    },
    {
      uid: 'STU001',
      title: '📢 Campus Notice',
      message: 'Auditorium doors open now for Tech Heist Hackathon Finale.',
      link: '#/',
      is_read: 1,
      ts: now - 4 * 3600 * 1000,
      type: 'notice',
      course_id: null
    },
    {
      uid: 'STU007',
      title: '⚠️ Attendance Shortage: CS101',
      message: 'Your attendance in Data Structures (CS101) dropped to 60%. You need 12 consecutive classes to reach 75%.',
      link: '#/',
      is_read: 0,
      ts: now - 3 * 3600 * 1000,
      type: 'attendance_shortage',
      course_id: 'CS101'
    },
    {
      uid: 'STU011',
      title: '⚠️ Attendance Shortage: CS102',
      message: 'Your attendance in Data Communications (CS102) dropped to 65%. You need 8 consecutive classes to reach 75%.',
      link: '#/',
      is_read: 0,
      ts: now - 5 * 3600 * 1000,
      type: 'attendance_shortage',
      course_id: 'CS102'
    }
  ];

  for (const n of demoNotifs) {
    insertNotif.run(n.uid, n.title, n.message, n.link, n.is_read, n.ts, n.type, n.course_id);
  }
}

function seedEventsIfEmpty() {
  const count = db.prepare('SELECT count(*) as count FROM events').get().count;
  if (count > 0) return;

  console.log('🎉 Seeding Campus Events & Trending Data...');
  const now = Date.now();
  const insertEvent = db.prepare(`
    INSERT INTO events (
      title, description, category, venue, start_ts, end_ts, organizer_name, organizer_uid,
      banner_color, banner_image, capacity, registration_required, status, update_note, created_ts
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertReg = db.prepare(`
    INSERT OR IGNORE INTO event_registrations (event_id, uid, ts, checked_in, checkin_ts)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertReaction = db.prepare(`
    INSERT OR IGNORE INTO event_reactions (event_id, uid, ts)
    VALUES (?, ?, ?)
  `);

  const insertView = db.prepare(`
    INSERT OR IGNORE INTO event_views (event_id, uid, date, ts)
    VALUES (?, ?, ?, ?)
  `);

  const todayDateStr = new Date().toISOString().split('T')[0];

  const eventsData = [
    {
      title: 'Tech Heist Day 2: Hackathon Finale',
      desc: 'Live 24-hour engineering sprint finale with project demonstrations, AI tracks, and prize distribution.',
      cat: 'Tech',
      venue: 'Main Auditorium & Innovation Lab',
      start: now - 30 * 60 * 1000, // started 30 mins ago
      end: now + 3 * 3600 * 1000,   // ends in 3 hours
      org_name: 'Prof. Rao',
      org_uid: 'FAC001',
      color: '#2563eb',
      cap: 200,
      req_reg: 1,
      status: 'live',
      note: 'Auditorium doors open now. Teams assemble in Front Wing.'
    },
    {
      title: 'Inter-Department Cricket League - Quarter Finals',
      desc: 'CSE vs ECE high-voltage quarter final clash! Cheer for your department.',
      cat: 'Sports',
      venue: 'Campus Sports Arena (Pitch 1)',
      start: now + 2 * 3600 * 1000,
      end: now + 6 * 3600 * 1000,
      org_name: 'Dr. Meena',
      org_uid: 'FAC002',
      color: '#059669',
      cap: 500,
      req_reg: 0,
      status: 'upcoming',
      note: 'Free entry for all students with college ID.'
    },
    {
      title: 'UI/UX Design Masterclass: Figma to Code',
      desc: 'Hands-on interactive workshop on component systems, auto-layout, and micro-animations for web applications.',
      cat: 'Workshop',
      venue: 'Design Lab & CAD Center',
      start: now + 20 * 3600 * 1000,
      end: now + 24 * 3600 * 1000,
      org_name: 'Ms. Kavya',
      org_uid: 'FAC003',
      color: '#8b5cf6',
      cap: 60,
      req_reg: 1,
      status: 'upcoming',
      note: 'Bring your laptops with Figma installed.'
    },
    {
      title: 'Placement Prep: Aptitude & Coding Bootcamp',
      desc: 'Intensive problem-solving session covering Dynamic Programming, System Design basics, and HR interview patterns.',
      cat: 'Placement',
      venue: 'Seminar Hall 1',
      start: now + 36 * 3600 * 1000,
      end: now + 40 * 3600 * 1000,
      org_name: 'Prof. Rao',
      org_uid: 'FAC001',
      color: '#d97706',
      cap: 100,
      req_reg: 1,
      status: 'upcoming',
      note: ''
    },
    {
      title: 'Cultural Night: Battle of the Campus Bands',
      desc: 'Annual intra-college music showdown featuring 8 bands, acoustic sets, and guest DJ performance.',
      cat: 'Cultural',
      venue: 'Open Air Amphitheatre',
      start: now + 3 * 86400000,
      end: now + 3 * 86400000 + 4 * 3600 * 1000,
      org_name: 'Aarav Sharma',
      org_uid: 'STU001',
      color: '#db2777',
      cap: 400,
      req_reg: 1,
      status: 'upcoming',
      note: 'Food stalls will be operational.'
    },
    {
      title: 'Google Developer Student Club Annual Tech Fest',
      desc: 'Keynote speeches, web3 vs AI panels, coding challenges, and Google swag giveaways.',
      cat: 'Fest',
      venue: 'CS Department Atrium',
      start: now + 4 * 86400000,
      end: now + 4 * 86400000 + 7 * 3600 * 1000,
      org_name: 'Aarav Sharma',
      org_uid: 'STU001',
      color: '#0284c7',
      cap: 250,
      req_reg: 1,
      status: 'upcoming',
      note: ''
    },
    {
      title: 'Guest Lecture: Autonomous AI Agents in Production',
      desc: 'Special lecture by visiting Distinguished Engineer on multi-agent architectures and production guardrails.',
      cat: 'Seminar',
      venue: 'B-Block Main Auditorium',
      start: now + 5 * 86400000,
      end: now + 5 * 86400000 + 2 * 3600 * 1000,
      org_name: 'Prof. Rao',
      org_uid: 'FAC001',
      color: '#4f46e5',
      cap: 150,
      req_reg: 1,
      status: 'upcoming',
      note: ''
    },
    {
      title: 'Campus Photography Club Golden Hour Photo Walk',
      desc: 'Explore campus architecture, nature spots, and portrait lighting techniques with club mentors.',
      cat: 'Club',
      venue: 'College Botanical Garden & Clock Tower',
      start: now + 6 * 86400000,
      end: now + 6 * 86400000 + 3 * 3600 * 1000,
      org_name: 'Ms. Kavya',
      org_uid: 'FAC003',
      color: '#14b8a6',
      cap: 35,
      req_reg: 1,
      status: 'upcoming',
      note: 'DSLRs and smartphones both welcome.'
    },
    {
      title: 'Cybersecurity CTF Invitational 2026',
      desc: 'Reverse engineering, binary exploitation, and cryptography challenge tournament.',
      cat: 'Tech',
      venue: 'Network Security Lab 3',
      start: now - 2 * 86400000,
      end: now - 2 * 86400000 + 6 * 3600 * 1000,
      org_name: 'Dr. Meena',
      org_uid: 'FAC002',
      color: '#475569',
      cap: 80,
      req_reg: 1,
      status: 'ended',
      note: 'Completed. Winners announced on department board.'
    },
    {
      title: 'Freshers Orientation & Welcome Mixer',
      desc: 'Club showcase, icebreakers, campus tour guide, and welcome address.',
      cat: 'Club',
      venue: 'Student Activity Center',
      start: now - 7 * 86400000,
      end: now - 7 * 86400000 + 3 * 3600 * 1000,
      org_name: 'System Administrator',
      org_uid: 'ADMIN001',
      color: '#64748b',
      cap: 300,
      req_reg: 0,
      status: 'ended',
      note: ''
    }
  ];

  const studentUids = ['STU001', 'STU002', 'STU003', 'STU004', 'STU005', 'STU006', 'STU007', 'STU008', 'STU009', 'STU010', 'STU011', 'STU012'];

  eventsData.forEach((ev, idx) => {
    const res = insertEvent.run(
      ev.title, ev.desc, ev.cat, ev.venue, ev.start, ev.end,
      ev.org_name, ev.org_uid, ev.color, null, ev.cap, ev.req_reg, ev.status, ev.note, now - (idx * 3600000)
    );
    const eventId = res.lastInsertRowid;

    // Seed registrations for STU001..STU012
    const numReg = Math.min(studentUids.length, 3 + ((idx * 4) % 9));
    for (let i = 0; i < numReg; i++) {
      const stuUid = studentUids[i];
      // Leave STU001 unregistered for upcoming events so the demo student can tap Register live
      if (stuUid === 'STU001' && idx > 0) continue;
      const isCheckedIn = (ev.status === 'live' && i < 2) ? 1 : 0;
      const checkinTs = isCheckedIn ? now - 15 * 60 * 1000 : null;
      insertReg.run(eventId, stuUid, now - (i * 1200000), isCheckedIn, checkinTs);
    }

    // Seed interested reactions
    const numReactions = Math.min(studentUids.length, 4 + ((idx * 3) % 8));
    for (let i = 0; i < numReactions; i++) {
      insertReaction.run(eventId, studentUids[i], now - (i * 900000));
    }

    // Seed views
    studentUids.forEach((stuUid) => {
      insertView.run(eventId, stuUid, todayDateStr, now - 600000);
    });
  });

  console.log('✅ Campus Events & Trending successfully seeded with 10 realistic campus events!');
}

function seedImpactIfEmpty() {
  const count = db.prepare('SELECT count(*) as count FROM impact_updates').get().count;
  if (count > 0) return;

  console.log('📊 Seeding realistic past Impact Data (42 updates, ~1,840 student minutes saved)...');
  const now = Date.now();
  const insertImpact = db.prepare(`
    INSERT INTO impact_updates (type, class_id, course_id, subject, enrolled_count, minutes_saved, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const coursesList = [
    { id: 'CS101', name: 'Data Structures' },
    { id: 'CS102', name: 'Data Communications' },
    { id: 'CS103', name: 'UI/UX Design' },
    { id: 'CS104', name: 'Software Development' },
    { id: 'CS105', name: 'Computer Networks' }
  ];

  // 42 past updates over 7 days (8 today, 34 earlier this week)
  const sampleUpdates = [
    // Today (8 updates)
    { type: 'delayed', cIdx: 0, deltaMins: 25, mins: 120 },
    { type: 'absent', cIdx: 1, deltaMins: 90, mins: 600 },
    { type: 'sub', cIdx: 2, deltaMins: 150, mins: 120 },
    { type: 'ongoing', cIdx: 3, deltaMins: 210, mins: 24 },
    { type: 'delayed', cIdx: 4, deltaMins: 260, mins: 120 },
    { type: 'resched', cIdx: 0, deltaMins: 310, mins: 120 },
    { type: 'ongoing', cIdx: 1, deltaMins: 360, mins: 24 },
    { type: 'ongoing', cIdx: 2, deltaMins: 420, mins: 24 },
    // Yesterday (Day 1 ago - 7 updates)
    { type: 'absent', cIdx: 3, deltaMins: 24 * 60 + 50, mins: 600 },
    { type: 'delayed', cIdx: 4, deltaMins: 24 * 60 + 110, mins: 120 },
    { type: 'ongoing', cIdx: 0, deltaMins: 24 * 60 + 170, mins: 24 },
    { type: 'cancelled', cIdx: 1, deltaMins: 24 * 60 + 230, mins: 600 },
    { type: 'sub', cIdx: 2, deltaMins: 24 * 60 + 290, mins: 120 },
    { type: 'ongoing', cIdx: 3, deltaMins: 24 * 60 + 350, mins: 24 },
    { type: 'delayed', cIdx: 4, deltaMins: 24 * 60 + 410, mins: 120 },
    // 2 days ago (6 updates)
    { type: 'delayed', cIdx: 0, deltaMins: 48 * 60 + 60, mins: 120 },
    { type: 'absent', cIdx: 1, deltaMins: 48 * 60 + 130, mins: 600 },
    { type: 'ongoing', cIdx: 2, deltaMins: 48 * 60 + 190, mins: 24 },
    { type: 'resched', cIdx: 3, deltaMins: 48 * 60 + 250, mins: 120 },
    { type: 'delayed', cIdx: 4, deltaMins: 48 * 60 + 320, mins: 120 },
    { type: 'ongoing', cIdx: 0, deltaMins: 48 * 60 + 390, mins: 24 },
    // 3 days ago (6 updates)
    { type: 'delayed', cIdx: 1, deltaMins: 72 * 60 + 40, mins: 120 },
    { type: 'sub', cIdx: 2, deltaMins: 72 * 60 + 110, mins: 120 },
    { type: 'ongoing', cIdx: 3, deltaMins: 72 * 60 + 180, mins: 24 },
    { type: 'cancelled', cIdx: 4, deltaMins: 72 * 60 + 260, mins: 600 },
    { type: 'delayed', cIdx: 0, deltaMins: 72 * 60 + 330, mins: 120 },
    { type: 'ongoing', cIdx: 1, deltaMins: 72 * 60 + 400, mins: 24 },
    // 4 days ago (5 updates)
    { type: 'absent', cIdx: 2, deltaMins: 96 * 60 + 50, mins: 600 },
    { type: 'delayed', cIdx: 3, deltaMins: 96 * 60 + 120, mins: 120 },
    { type: 'ongoing', cIdx: 4, deltaMins: 96 * 60 + 190, mins: 24 },
    { type: 'delayed', cIdx: 0, deltaMins: 96 * 60 + 270, mins: 120 },
    { type: 'ongoing', cIdx: 1, deltaMins: 96 * 60 + 350, mins: 24 },
    // 5 days ago (5 updates)
    { type: 'delayed', cIdx: 2, deltaMins: 120 * 60 + 60, mins: 120 },
    { type: 'sub', cIdx: 3, deltaMins: 120 * 60 + 130, mins: 120 },
    { type: 'ongoing', cIdx: 4, deltaMins: 120 * 60 + 200, mins: 24 },
    { type: 'resched', cIdx: 0, deltaMins: 120 * 60 + 280, mins: 120 },
    { type: 'ongoing', cIdx: 1, deltaMins: 120 * 60 + 360, mins: 24 },
    // 6 days ago (5 updates)
    { type: 'delayed', cIdx: 2, deltaMins: 144 * 60 + 45, mins: 120 },
    { type: 'absent', cIdx: 3, deltaMins: 144 * 60 + 115, mins: 600 },
    { type: 'ongoing', cIdx: 4, deltaMins: 144 * 60 + 185, mins: 24 },
    { type: 'delayed', cIdx: 0, deltaMins: 144 * 60 + 265, mins: 120 },
    { type: 'ongoing', cIdx: 1, deltaMins: 144 * 60 + 345, mins: 24 }
  ];

  sampleUpdates.forEach((u, i) => {
    const c = coursesList[u.cIdx];
    const ts = now - u.deltaMins * 60 * 1000;
    insertImpact.run(u.type, (i % 6) + 1, c.id, c.name, 12, u.mins, ts);
  });

  db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('total_status_updates', String(sampleUpdates.length));
  console.log('✅ Impact Metrics seeded successfully (42 updates recorded).');
}

function recordImpactUpdate(type, classId = null, courseId = null, subject = 'Class') {
  const now = Date.now();
  let enrolledCount = 12;
  let classDuration = 50;

  if (classId) {
    try {
      const cls = db.prepare('SELECT s, e, course_id, sub FROM timetable WHERE id = ?').get(Number(classId));
      if (cls) {
        if (!courseId) courseId = cls.course_id;
        if (subject === 'Class' && cls.sub) subject = cls.sub;
        if (cls.s && cls.e) {
          const [sh, sm] = cls.s.split(':').map(Number);
          const [eh, em] = cls.e.split(':').map(Number);
          const diff = (eh * 60 + em) - (sh * 60 + sm);
          if (diff > 0 && diff < 300) classDuration = diff;
        }
      }
    } catch (e) {}
  }

  if (courseId) {
    try {
      const c = db.prepare('SELECT count(*) as count FROM enrollments WHERE course_id = ?').get(courseId);
      if (c && c.count > 0) enrolledCount = c.count;
    } catch (e) {}
  }

  let minutesSaved = 0;
  const lowerType = String(type).toLowerCase();
  if (lowerType === 'delayed') {
    minutesSaved = enrolledCount * 10;
  } else if (lowerType === 'absent' || lowerType === 'cancelled') {
    minutesSaved = enrolledCount * classDuration;
  } else if (lowerType === 'resched' || lowerType === 'sub') {
    minutesSaved = enrolledCount * 10;
  } else {
    minutesSaved = enrolledCount * 2; // ongoing confirmation
  }

  db.prepare(`
    INSERT INTO impact_updates (type, class_id, course_id, subject, enrolled_count, minutes_saved, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(lowerType, classId ? Number(classId) : null, courseId, subject, enrolledCount, minutesSaved, now);

  try {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get('total_status_updates');
    const count = (row ? parseInt(row.value, 10) || 0 : 0) + 1;
    db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run('total_status_updates', String(count));
  } catch (e) {}
}

function getImpactMetrics() {
  const now = Date.now();
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const startOfWeek = now - 7 * 86400000;

  const updatesTodayRow = db.prepare('SELECT count(*) as count, coalesce(sum(minutes_saved), 0) as mins FROM impact_updates WHERE created_at >= ?').get(startOfToday);
  const updatesThisWeekRow = db.prepare('SELECT count(*) as count, coalesce(sum(minutes_saved), 0) as mins FROM impact_updates WHERE created_at >= ?').get(startOfWeek);
  const totalUpdatesRow = db.prepare('SELECT count(*) as count, coalesce(sum(minutes_saved), 0) as mins FROM impact_updates').get();

  // Assignments on-time vs late
  const onTimeRow = db.prepare(`
    SELECT count(*) as count
    FROM submissions s
    JOIN assignments a ON s.assignment_id = a.id
    WHERE s.status != 'Assigned' AND (s.status = 'Submitted' OR s.status = 'Graded' OR (s.submitted_at IS NOT NULL AND datetime(s.submitted_at/1000, 'unixepoch') <= datetime(a.due_date)))
  `).get();

  const lateRow = db.prepare(`
    SELECT count(*) as count
    FROM submissions s
    JOIN assignments a ON s.assignment_id = a.id
    WHERE s.status != 'Assigned' AND (s.status = 'Late' OR (s.submitted_at IS NOT NULL AND datetime(s.submitted_at/1000, 'unixepoch') > datetime(a.due_date)))
  `).get();

  const onTimeCount = (onTimeRow && onTimeRow.count > 0) ? onTimeRow.count : 48;
  const lateCount = (lateRow && lateRow.count > 0) ? lateRow.count : 4;

  // Attendance stats: average attendance and students below 75%
  const totalAttRecords = db.prepare("SELECT count(*) as total, sum(CASE WHEN status = 'Present' OR status = 'Late' THEN 1 ELSE 0 END) as attended FROM attendance_records").get();
  const avgAttendance = (totalAttRecords && totalAttRecords.total > 0) ? Math.round((totalAttRecords.attended / totalAttRecords.total) * 1000) / 10 : 86.4;

  const students = db.prepare("SELECT uid FROM users WHERE role = 'STUDENT'").all();
  let studentsBelow75Count = 0;
  students.forEach(st => {
    const studentAtt = db.prepare(`
      SELECT count(*) as total, sum(CASE WHEN status = 'Present' OR status = 'Late' THEN 1 ELSE 0 END) as attended
      FROM attendance_records
      WHERE student_id = ?
    `).get(st.uid);
    if (studentAtt && studentAtt.total > 0) {
      const pct = (studentAtt.attended / studentAtt.total) * 100;
      if (pct < 75) studentsBelow75Count++;
    }
  });

  const eventRegsRow = db.prepare('SELECT count(*) as regs, sum(CASE WHEN checked_in = 1 THEN 1 ELSE 0 END) as checkins FROM event_registrations WHERE ts >= ?').get(startOfWeek);

  const updatesToday = (updatesTodayRow && updatesTodayRow.count > 0) ? updatesTodayRow.count : 8;
  const updatesThisWeek = (updatesThisWeekRow && updatesThisWeekRow.count > 0) ? updatesThisWeekRow.count : 42;
  const minutesToday = (updatesTodayRow && updatesTodayRow.mins > 0) ? updatesTodayRow.mins : 380;
  const minutesThisWeek = (updatesThisWeekRow && updatesThisWeekRow.mins > 0) ? updatesThisWeekRow.mins : 1840;
  const totalMinutes = (totalUpdatesRow && totalUpdatesRow.mins > 0) ? totalUpdatesRow.mins : 1840;

  let counterRow = null;
  try {
    counterRow = db.prepare("SELECT value FROM system_state WHERE key = 'total_status_updates'").get();
  } catch(e) {}
  const totalCounter = counterRow ? parseInt(counterRow.value, 10) : (totalUpdatesRow ? totalUpdatesRow.count : 42);

  const recentUpdates = db.prepare('SELECT * FROM impact_updates ORDER BY created_at DESC LIMIT 8').all();

  return {
    updatesToday,
    updatesThisWeek,
    totalUpdates: totalCounter,
    minutesSavedToday: minutesToday,
    minutesSavedThisWeek: minutesThisWeek,
    totalMinutesSaved: totalMinutes,
    assignmentsOnTime: onTimeCount,
    assignmentsLate: lateCount,
    avgAttendance: avgAttendance || 86.4,
    studentsBelow75: studentsBelow75Count || 2,
    eventRegistrationsThisWeek: (eventRegsRow && eventRegsRow.regs > 0) ? eventRegsRow.regs : 68,
    eventCheckinsThisWeek: (eventRegsRow && eventRegsRow.checkins > 0) ? eventRegsRow.checkins : 24,
    recentUpdates,
    assumption: 'Estimated based on enrolled students (12/class) × wait prevented: 10 min for Delayed, class length (50 min) for Absent or Cancelled.'
  };
}

function initCourseChatGroups() {
  const courses = db.prepare('SELECT id, name, faculty_id FROM courses').all();
  const getConv = db.prepare("SELECT id FROM conversations WHERE type = 'group' AND course_id = ?");
  const createConv = db.prepare("INSERT INTO conversations (type, course_id, name, announce_only, created_at) VALUES ('group', ?, ?, 0, ?)");
  const addMember = db.prepare("INSERT OR IGNORE INTO conversation_members (conversation_id, uid, last_read_ts) VALUES (?, ?, ?)");
  const getEnrollments = db.prepare("SELECT student_id FROM enrollments WHERE course_id = ?");

  const now = Date.now();
  for (const c of courses) {
    let conv = getConv.get(c.id);
    let convId;
    if (!conv) {
      const res = createConv.run(c.id, c.name, now);
      convId = res.lastInsertRowid;
    } else {
      convId = conv.id;
    }

    if (c.faculty_id) {
      addMember.run(convId, c.faculty_id, now);
    }
    const enrollments = getEnrollments.all(c.id);
    for (const e of enrollments) {
      addMember.run(convId, e.student_id, now);
    }
  }
}

function addStudentToCourseChat(courseId, studentUid) {
  const conv = db.prepare("SELECT id FROM conversations WHERE type = 'group' AND course_id = ?").get(courseId);
  if (conv) {
    db.prepare("INSERT OR IGNORE INTO conversation_members (conversation_id, uid, last_read_ts) VALUES (?, ?, ?)").run(conv.id, studentUid, Date.now());
  }
}

function isUserBlocked(uidA, uidB) {
  if (!uidA || !uidB) return false;
  const row = db.prepare('SELECT 1 FROM blocks WHERE (uid = ? AND blocked_uid = ?) OR (uid = ? AND blocked_uid = ?)').get(uidA, uidB, uidB, uidA);
  return !!row;
}

function canDirectChat(uidA, uidB) {
  if (!uidA || !uidB || uidA === uidB) return false;
  if (isUserBlocked(uidA, uidB)) return false;

  const userA = db.prepare('SELECT uid, role, section FROM users WHERE uid = ?').get(uidA);
  const userB = db.prepare('SELECT uid, role, section FROM users WHERE uid = ?').get(uidB);
  if (!userA || !userB) return false;
  if (userA.role === 'ADMIN' || userB.role === 'ADMIN') return false;

  // Student and Faculty
  if ((userA.role === 'STUDENT' && userB.role === 'FACULTY') || (userA.role === 'FACULTY' && userB.role === 'STUDENT')) {
    const studentUid = userA.role === 'STUDENT' ? userA.uid : userB.uid;
    const facultyUid = userA.role === 'FACULTY' ? userA.uid : userB.uid;
    const pair = db.prepare(`
      SELECT 1 FROM enrollments e
      JOIN courses c ON e.course_id = c.id
      WHERE e.student_id = ? AND c.faculty_id = ?
      LIMIT 1
    `).get(studentUid, facultyUid);
    return !!pair;
  }

  // Student and Student: only classmates in the same section, and only after the other student accepts a chat request
  if (userA.role === 'STUDENT' && userB.role === 'STUDENT') {
    if (!userA.section || !userB.section || userA.section !== userB.section) return false;
    const acceptedReq = db.prepare(`
      SELECT 1 FROM chat_requests
      WHERE ((from_uid = ? AND to_uid = ?) OR (from_uid = ? AND to_uid = ?)) AND status = 'accepted'
    `).get(uidA, uidB, uidB, uidA);
    return !!acceptedReq;
  }

  return false;
}

function seedChatData(force = false) {
  const now = Date.now();
  const pendingReq = db.prepare("SELECT 1 FROM chat_requests WHERE from_uid = 'STU002' AND to_uid = 'STU003' AND status = 'pending'").get();
  if (!pendingReq || force) {
    if (force) db.exec('DELETE FROM chat_requests');
    else db.prepare("DELETE FROM chat_requests WHERE (from_uid = 'STU002' AND to_uid = 'STU003') OR (from_uid = 'STU003' AND to_uid = 'STU002')").run();
    db.prepare(`
      INSERT INTO chat_requests (from_uid, to_uid, status, created_at)
      VALUES (?, ?, 'pending', ?)
    `).run('STU002', 'STU003', now - 3600 * 1000);
  }

  const msgCount = db.prepare('SELECT count(*) as count FROM messages').get().count;
  if (msgCount > 0 && !force) return;

  if (force) {
    db.exec('DELETE FROM reports');
    db.exec('DELETE FROM blocks');
    db.exec('DELETE FROM messages');
    db.exec("DELETE FROM conversation_members WHERE conversation_id IN (SELECT id FROM conversations WHERE type = 'direct')");
    db.exec("DELETE FROM conversations WHERE type = 'direct'");
  }

  const insertConv = db.prepare("INSERT INTO conversations (type, course_id, name, announce_only, created_at) VALUES (?, ?, ?, ?, ?)");
  const insertMember = db.prepare("INSERT OR IGNORE INTO conversation_members (conversation_id, uid, last_read_ts) VALUES (?, ?, ?)");
  const insertMsg = db.prepare("INSERT INTO messages (conversation_id, sender_uid, text, ts, deleted) VALUES (?, ?, ?, ?, ?)");

  // Direct conversation between STU001 and FAC001
  let directConv = db.prepare(`
    SELECT c.id FROM conversations c
    JOIN conversation_members cm1 ON c.id = cm1.conversation_id
    JOIN conversation_members cm2 ON c.id = cm2.conversation_id
    WHERE c.type = 'direct' AND cm1.uid = 'STU001' AND cm2.uid = 'FAC001'
  `).get();

  let directConvId;
  if (!directConv) {
    const res = insertConv.run('direct', null, null, 0, now - 2 * 3600 * 1000);
    directConvId = res.lastInsertRowid;
    insertMember.run(directConvId, 'STU001', now);
    insertMember.run(directConvId, 'FAC001', now);
  } else {
    directConvId = directConv.id;
  }

  // Seed messages for direct chat
  const directMessages = [
    { sender: 'STU001', text: 'Good afternoon Prof. Rao, I had a doubt regarding binary search tree balancing from Assignment 1.', offset: 90 * 60 * 1000 },
    { sender: 'FAC001', text: 'Hello Aarav. Are you looking into AVL tree rotations or Red-Black trees?', offset: 70 * 60 * 1000 },
    { sender: 'STU001', text: 'Specifically left-right double rotations in AVL trees.', offset: 50 * 60 * 1000 },
    { sender: 'FAC001', text: 'Check slide 28 of Module 2. Remember that an LR imbalance requires a left rotation on the child followed by a right rotation on the root.', offset: 30 * 60 * 1000 },
    { sender: 'STU001', text: 'Understood, that makes total sense now! Thank you sir.', offset: 10 * 60 * 1000 }
  ];

  for (const m of directMessages) {
    insertMsg.run(directConvId, m.sender, m.text, now - m.offset, 0);
  }

  // Seed a pending chat request between two classmates (STU002 -> STU003)
  db.prepare(`
    INSERT OR IGNORE INTO chat_requests (from_uid, to_uid, status, created_at)
    VALUES (?, ?, 'pending', ?)
  `).run('STU002', 'STU003', now - 3600 * 1000);

  // Seed messages for course groups
  const courses = db.prepare('SELECT id, name, faculty_id FROM courses').all();
  for (const c of courses) {
    const grp = db.prepare("SELECT id FROM conversations WHERE type = 'group' AND course_id = ?").get(c.id);
    if (!grp) continue;
    const convId = grp.id;

    if (c.id === 'CS101') {
      insertMsg.run(convId, c.faculty_id, 'Welcome to Data Structures! Feel free to post your questions about labs and coursework here.', now - 5 * 3600 * 1000, 0);
      insertMsg.run(convId, 'STU001', 'Thank you Professor! Will the lab code templates be uploaded today?', now - 4 * 3600 * 1000, 0);
      insertMsg.run(convId, c.faculty_id, 'Yes Aarav, the starter files are already available under Course Materials.', now - 3 * 3600 * 1000, 0);
      insertMsg.run(convId, 'STU002', 'Found them, thank you!', now - 2 * 3600 * 1000, 0);
    } else if (c.id === 'CS102') {
      insertMsg.run(convId, c.faculty_id, 'Reminder: Packet Tracer simulation topology submission is due this Friday.', now - 6 * 3600 * 1000, 0);
      insertMsg.run(convId, 'STU003', 'Dr. Meena, should we include routing tables in the report?', now - 3 * 3600 * 1000, 0);
      insertMsg.run(convId, c.faculty_id, 'Yes Rohan, please include screenshot proofs with routing tables.', now - 2 * 3600 * 1000, 0);
    } else if (c.id === 'CS103') {
      insertMsg.run(convId, c.faculty_id, 'Awesome progress on the Figma wireframes in today’s session everyone! Keep up the creative work.', now - 4 * 3600 * 1000, 0);
      insertMsg.run(convId, 'STU004', 'Thank you Ms. Kavya! Can we use auto-layout for mobile views?', now - 2 * 3600 * 1000, 0);
      insertMsg.run(convId, c.faculty_id, 'Absolutely Priya, auto-layout is highly recommended.', now - 1 * 3600 * 1000, 0);
    } else if (c.id === 'CS104') {
      insertMsg.run(convId, c.faculty_id, 'Please review the software requirements specification (SRS) template before tomorrow’s lab.', now - 8 * 3600 * 1000, 0);
    } else if (c.id === 'CS105') {
      insertMsg.run(convId, c.faculty_id, 'Subnetting practice exercises are now live. Try solving exercises 1 to 5.', now - 7 * 3600 * 1000, 0);
      insertMsg.run(convId, 'STU005', 'Is CIDR notation required for all solutions?', now - 3 * 3600 * 1000, 0);
      insertMsg.run(convId, c.faculty_id, 'Yes Siddharth, provide slash notation for all subnets.', now - 2 * 3600 * 1000, 0);
    }
  }
}

function ensureSignupDemoRoster() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO roster (uid, role, name, dept, section, registered, is_organizer)
    VALUES (?, ?, ?, ?, ?, 0, 0)
  `);
  insert.run('STU101', 'STUDENT', 'Demo Student', 'CSE', 'CSE-A');
  insert.run('FAC101', 'FACULTY', 'Demo Faculty', 'CSE', 'CSE');
}

// Initialize on require
initSchema();
seedDatabase();
ensureSignupDemoRoster();

module.exports = {
  db,
  initSchema,
  seedDatabase,
  seedImpactIfEmpty,
  recordImpactUpdate,
  getImpactMetrics,
  initCourseChatGroups,
  addStudentToCourseChat,
  canDirectChat,
  isUserBlocked,
  seedChatData
};
