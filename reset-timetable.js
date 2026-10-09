const { db } = require('./db');
const now = Date.now();
db.exec('DELETE FROM timetable');
try { db.exec("DELETE FROM sqlite_sequence WHERE name = 'timetable'"); } catch(e) {}
const insertT = db.prepare('INSERT INTO timetable (id, course_id, s, e, sub, fac, faculty_id, room, st, note, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const list = [
  { id: 1, course_id: 'CS101', s: '09:00', e: '09:50', sub: 'Data Structures', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'B-204', st: 'ongoing', note: '', ts: now },
  { id: 2, course_id: 'CS102', s: '09:50', e: '10:40', sub: 'Data Communications', fac: 'Dr. Meena', faculty_id: 'FAC002', room: 'B-206', st: 'ongoing', note: '', ts: now },
  { id: 3, course_id: 'CS103', s: '10:55', e: '11:45', sub: 'UI/UX Design', fac: 'Ms. Kavya', faculty_id: 'FAC003', room: 'Design Lab', st: 'ongoing', note: '', ts: now },
  { id: 4, course_id: 'CS104', s: '11:45', e: '12:35', sub: 'Software Development', fac: 'Prof. Nair', faculty_id: 'FAC001', room: 'C-101', st: 'ongoing', note: '', ts: now },
  { id: 5, course_id: 'CS105', s: '13:30', e: '14:20', sub: 'Computer Networks', fac: 'Dr. Suresh', faculty_id: 'FAC002', room: 'B-210', st: 'ongoing', note: '', ts: now },
  { id: 6, course_id: 'CS101', s: '14:20', e: '15:10', sub: 'Data Structures Lab', fac: 'Prof. Rao', faculty_id: 'FAC001', room: 'Lab 2', st: 'ongoing', note: '', ts: now }
];
for (const t of list) {
  insertT.run(t.id, t.course_id, t.s, t.e, t.sub, t.fac, t.faculty_id, t.room, t.st, t.note, t.ts);
}
console.log('Timetable initialized with IDs 1..6');
