// Shared Directive Calculation Logic for ClassPulse
// Used by both backend API (/api/assistant) and frontend dashboard

function parseTimeToMinutes(tStr) {
  if (!tStr || typeof tStr !== 'string') return 0;
  const parts = tStr.split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

function getCurrentMinutes(customDate) {
  const now = customDate || new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function resolveActiveClass(state, customMinutes) {
  const classes = (state && state.classes) || [];
  if (classes.length === 0) return { cls: null, mode: 'empty' };

  const currentMins = customMinutes !== undefined ? customMinutes : getCurrentMinutes();

  // 1. Live matching class
  const live = classes.find(c => {
    const s = parseTimeToMinutes(c.s);
    const e = parseTimeToMinutes(c.e);
    return currentMins >= s && currentMins < e;
  });
  if (live) return { cls: live, mode: 'live', isRealTime: true };

  // 2. Demo simulator override
  if (state.demo !== null && state.demo !== undefined && state.demo !== '') {
    const demoCls = classes.find(c => c.id === Number(state.demo));
    if (demoCls) return { cls: demoCls, mode: 'demo', isRealTime: false };
  }

  // 3. Next upcoming
  const upcoming = classes.find(c => parseTimeToMinutes(c.s) > currentMins);
  if (upcoming) return { cls: upcoming, mode: 'upcoming', isRealTime: true };

  // 4. Completed for day
  return { cls: classes[classes.length - 1], mode: 'finished', isRealTime: true };
}

function computeActionLine(cls, mode, state) {
  if (!cls) return { primary: 'No active classes scheduled.', secondary: 'Check with department.' };
  if (mode === 'finished') return { primary: 'DAY COMPLETE. All scheduled classes finished.', secondary: 'Enjoy your evening!' };

  const startMin = parseTimeToMinutes(cls.s);
  const endMin = parseTimeToMinutes(cls.e);
  const classLength = Math.max(1, endMin - startMin);

  const classes = (state && state.classes) || [];
  const nextCls = classes.find(c => parseTimeToMinutes(c.s) >= endMin);

  switch (cls.st) {
    case 'ongoing':
      return {
        primary: `ATTEND. Go to ${cls.room}, ${cls.fac} is teaching.`,
        secondary: cls.note ? `Note: ${cls.note}` : 'Class is currently in session.'
      };
    case 'delayed':
      return {
        primary: `WAIT. About 10 min, stay near ${cls.room} and check again.`,
        secondary: cls.note ? `Note: "${cls.note}"` : 'Faculty is arriving shortly.'
      };
    case 'absent': {
      const nextInfo = nextCls ? `Next: ${nextCls.sub} at ${nextCls.s}, ${nextCls.room}.` : 'No more classes today.';
      return {
        primary: `FREE for ${classLength} min. Library or canteen. ${nextInfo}`,
        secondary: cls.note ? `Faculty note: ${cls.note}` : 'Faculty is absent.'
      };
    }
    case 'sub':
      return {
        primary: `ATTEND. Substitute in ${cls.room}.`,
        secondary: cls.note ? `Substitute info: ${cls.note}` : `${cls.fac} assigned a substitute.`
      };
    case 'cancelled': {
      const nextInfo = nextCls ? `Next: ${nextCls.sub} at ${nextCls.s}, ${nextCls.room}.` : 'No more classes today.';
      return {
        primary: `FREE until ${nextCls ? nextCls.s : 'the end of day'}. ${nextInfo}`,
        secondary: cls.note ? `Reason: ${cls.note}` : 'Class is cancelled.'
      };
    }
    case 'resched':
      return {
        primary: `MOVED. Check the note for the new time and room.`,
        secondary: cls.note ? `Rescheduled to: ${cls.note}` : 'Check notice board for rescheduled slot.'
      };
    default:
      return { primary: `ATTEND. Go to ${cls.room} for ${cls.sub}.`, secondary: '' };
  }
}

function getDirectiveSummary(state) {
  const { cls, mode } = resolveActiveClass(state);
  const action = computeActionLine(cls, mode, state);
  return { cls, mode, action };
}

module.exports = {
  parseTimeToMinutes,
  getCurrentMinutes,
  resolveActiveClass,
  computeActionLine,
  getDirectiveSummary
};
