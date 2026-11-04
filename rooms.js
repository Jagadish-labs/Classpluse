/**
 * rooms.js - Pure logic for computing classroom states.
 * No database calls or external network dependencies.
 */

const DEFAULT_ROOMS = [
  'B-204',
  'B-206',
  'B-210',
  'C-101',
  'Design Lab',
  'Lab 2',
  'Net Lab'
];

/**
 * Format local date as YYYY-MM-DD from local clock (never UTC / toISOString).
 * @param {Date} [date]
 * @returns {string}
 */
function getLocalDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Format local time as HH:MM from local clock (never UTC / toISOString).
 * @param {Date} [date]
 * @returns {string}
 */
function getLocalTimeStr(date = new Date()) {
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}

/**
 * Pure function to calculate the state of each room given today's classes and a reference time.
 * 
 * @param {Array} classesToday - Array of class objects for today.
 * @param {string|Date} now - HH:MM string or Date object representing current time.
 * @param {Array<string>} [allRooms] - Optional custom room list; defaults to DEFAULT_ROOMS + any rooms in classesToday.
 * @returns {Array<object>} Array of room state objects (also indexable by room name).
 */
function getRoomStates(classesToday = [], now = new Date(), allRooms = null) {
  // Determine reference time string 'HH:MM'
  let currentTime = '';
  if (now instanceof Date) {
    currentTime = getLocalTimeStr(now);
  } else if (typeof now === 'string') {
    const parts = now.trim().split(':');
    if (parts.length >= 2) {
      currentTime = `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;
    } else {
      currentTime = now.trim();
    }
  } else {
    currentTime = getLocalTimeStr(new Date());
  }

  // Determine list of rooms
  const roomSet = new Set(Array.isArray(allRooms) && allRooms.length > 0 ? allRooms : DEFAULT_ROOMS);
  if (Array.isArray(classesToday)) {
    for (const c of classesToday) {
      if (c && c.room) roomSet.add(c.room);
    }
  }
  const rooms = Array.from(roomSet);

  const safeClasses = Array.isArray(classesToday) ? classesToday : [];

  const results = [];

  for (const room of rooms) {
    // Classes in this room sorted by start time
    const roomClasses = safeClasses
      .filter(c => c && c.room === room && c.s && c.e)
      .sort((a, b) => a.s.localeCompare(b.s));

    // Current class running now: start <= now < end
    const currentSlot = roomClasses.find(c => c.s <= currentTime && currentTime < c.e);

    // Next class in this room today: start > now
    const nextSlot = roomClasses.find(c => c.s > currentTime);

    // Determine room status:
    // "in-use": a class is running now and its status is On (ongoing, delayed, etc.)
    // "substitute": a class is running now with a substitute
    // "free-absent": a class is scheduled now but faculty is absent or cancelled, so room is empty
    // "free": nothing scheduled now
    let status = 'free';
    let currentClass = null;

    if (currentSlot) {
      const st = (currentSlot.st || currentSlot.status || 'ongoing').toLowerCase();
      if (st === 'sub') {
        status = 'substitute';
      } else if (st === 'absent' || st === 'cancelled') {
        status = 'free-absent';
      } else {
        status = 'in-use';
      }

      currentClass = {
        name: currentSlot.sub || currentSlot.name || currentSlot.subject || '',
        faculty: currentSlot.fac || currentSlot.faculty || '',
        start: currentSlot.s || currentSlot.start || '',
        end: currentSlot.e || currentSlot.end || '',
        status: currentSlot.st || currentSlot.status || 'ongoing',
        note: currentSlot.note || ''
      };
    }

    let nextClass = null;
    if (nextSlot) {
      nextClass = {
        name: nextSlot.sub || nextSlot.name || nextSlot.subject || '',
        faculty: nextSlot.fac || nextSlot.faculty || '',
        start: nextSlot.s || nextSlot.start || '',
        end: nextSlot.e || nextSlot.end || '',
        status: nextSlot.st || nextSlot.status || 'ongoing',
        note: nextSlot.note || ''
      };
    }

    // Next time the room is used (start time of next upcoming class that is not cancelled/absent)
    const nextActiveSlot = roomClasses.find(c => {
      if (c.s <= currentTime) return false;
      const st = (c.st || c.status || 'ongoing').toLowerCase();
      return st !== 'absent' && st !== 'cancelled';
    });

    const nextUseTime = nextActiveSlot ? nextActiveSlot.s : null;

    const roomState = {
      room,
      status,
      currentClass,
      nextClass,
      nextUseTime,
      nextUsed: nextUseTime
    };

    results.push(roomState);
    // Allow property access by room name as well
    results[room] = roomState;
  }

  return results;
}

module.exports = {
  getRoomStates,
  getLocalDateStr,
  getLocalTimeStr,
  DEFAULT_ROOMS
};

