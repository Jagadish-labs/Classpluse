const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const SECRET = process.env.SECRET || process.env.JWT_SECRET;
if (!SECRET && process.env.NODE_ENV === 'production') {
  console.warn('⚠️ WARNING: SECRET environment variable is missing in production! Please set SECRET for production deployments.');
}
const JWT_SECRET = SECRET || 'classpulse_super_secure_jwt_secret_2026_buildathon';
const COOKIE_NAME = 'classpulse_token';
const SESSION_EXPIRY = '8h';

// Failed passkeys: 5 per minute per College ID (not per IP — shared Wi-Fi must not lock the campus)
const failedLoginsByUid = new Map();
const LOGIN_WINDOW_MS = 60 * 1000;
const MAX_FAILED_PER_UID = 5;

function normalizeUid(uid) {
  return String(uid || '').trim().toUpperCase();
}

function pruneFailedLogins(uid) {
  const now = Date.now();
  const list = (failedLoginsByUid.get(uid) || []).filter(ts => now - ts < LOGIN_WINDOW_MS);
  if (list.length) failedLoginsByUid.set(uid, list);
  else failedLoginsByUid.delete(uid);
  return list;
}

function rateLimitLogin(req, res, next) {
  const uid = normalizeUid(req.body && req.body.uid);
  if (!uid) return next();
  const recent = pruneFailedLogins(uid);
  if (recent.length >= MAX_FAILED_PER_UID) {
    return res.status(429).json({
      error: 'Too many login attempts. Please wait 1 minute before trying again.'
    });
  }
  next();
}

function recordFailedLogin(uid) {
  const key = normalizeUid(uid);
  if (!key) return;
  const list = pruneFailedLogins(key);
  list.push(Date.now());
  failedLoginsByUid.set(key, list);
}

function clearFailedLogins(uid) {
  failedLoginsByUid.delete(normalizeUid(uid));
}

function generateToken(user) {
  return jwt.sign(
    {
      uid: user.uid,
      role: user.role,
      name: user.name,
      dept: user.dept,
      section: user.section,
      is_organizer: Boolean(user.is_organizer)
    },
    JWT_SECRET,
    { expiresIn: SESSION_EXPIRY }
  );
}

function setAuthCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  const reqObj = res.req;
  const isHttps = reqObj ? Boolean(reqObj.secure || (reqObj.headers && reqObj.headers['x-forwarded-proto'] === 'https')) : false;
  const secure = isProd && isHttps;

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: secure,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000 // 8 hours
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// Middleware: Authenticate user from cookie or Authorization header
function authenticate(req, res, next) {
  let token = req.cookies ? req.cookies[COOKIE_NAME] : null;

  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT uid, role, name, dept, section, must_change_pass, is_organizer FROM users WHERE uid = ?').get(decoded.uid);

    if (!user) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'User session invalid. Please log in again.' });
    }

    req.user = user;
    next();
  } catch (err) {
    clearAuthCookie(res);
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }
}

// Middleware: Require specific role(s)
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Access denied. Requires one of: ${roles.join(', ')}` });
    }
    next();
  };
}

// Middleware: Require Event Organizer capability (Admin, Faculty, or Organiser Student)
function requireEventOrganizer(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role === 'ADMIN' || req.user.role === 'FACULTY' || req.user.is_organizer) {
    return next();
  }
  res.status(403).json({ error: 'Access denied: Event organizer privileges required.' });
}

// Middleware: Require course access (Faculty must own course, Student must be enrolled, Admin always allowed)
function requireCourseAccess(req, res, next) {
  const courseId = req.params.courseId || req.body.course_id || req.query.course_id;
  if (!courseId) {
    return res.status(400).json({ error: 'Course ID is required' });
  }

  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
  if (!course) {
    return res.status(404).json({ error: 'Course not found' });
  }

  req.course = course;

  if (req.user.role === 'ADMIN') {
    return next();
  }

  if (req.user.role === 'FACULTY') {
    if (course.faculty_id !== req.user.uid) {
      return res.status(403).json({ error: 'Access denied: You are not the assigned faculty for this course' });
    }
    return next();
  }

  if (req.user.role === 'STUDENT') {
    const enrolled = db.prepare('SELECT 1 FROM enrollments WHERE course_id = ? AND student_id = ?').get(courseId, req.user.uid);
    if (!enrolled) {
      return res.status(403).json({ error: 'Access denied: You are not enrolled in this course' });
    }
    return next();
  }

  res.status(403).json({ error: 'Unauthorized access to course' });
}

// Middleware: Enforce student self-access (or teacher/admin)
function requireStudentSelfOrStaff(req, res, next) {
  const targetStudentId = req.params.studentId || req.query.student_id;
  if (req.user.role === 'ADMIN' || req.user.role === 'FACULTY') {
    return next();
  }

  if (req.user.role === 'STUDENT') {
    if (targetStudentId && targetStudentId !== req.user.uid) {
      return res.status(403).json({ error: 'Forbidden: You can only view your own records' });
    }
    return next();
  }

  res.status(403).json({ error: 'Access forbidden' });
}

module.exports = {
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
};
