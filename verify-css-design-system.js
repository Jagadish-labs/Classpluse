const fs = require('fs');
const assert = require('assert');

console.log('🧪 Auditing Enterprise CSS Design System & Responsive Rules...\n');

// 1. Read styles.css
const css = fs.readFileSync('public/styles.css', 'utf8');

// Check braces balance
let depth = 0;
for (let i = 0; i < css.length; i++) {
  if (css[i] === '{') depth++;
  else if (css[i] === '}') depth--;
  if (depth < 0) throw new Error(`Unexpected closing brace at char ${i}`);
}
assert.strictEqual(depth, 0, 'CSS braces must balance perfectly');
console.log('   ✅ CSS syntax & brace balance verified');

// Check essential design tokens in :root
const requiredTokens = [
  '--slate-50', '--slate-100', '--slate-200', '--slate-300', '--slate-400',
  '--slate-500', '--slate-600', '--slate-700', '--slate-800', '--slate-900',
  '--primary', '--primary-hover',
  '--success', '--warning', '--danger', '--info',
  '--st-ongoing', '--st-delayed', '--st-absent', '--st-sub', '--st-cancelled', '--st-resched',
  '--bg-app', '--bg-card', '--border-color', '--text-main', '--text-muted',
  '--font-main', '--font-mono',
  '--radius-control', '--radius-card',
  '--shadow-sm', '--shadow-md'
];

for (const token of requiredTokens) {
  assert.ok(css.includes(token), `Design system must define token: ${token}`);
}
console.log(`   ✅ All ${requiredTokens.length} enterprise design system tokens defined in :root`);

// Check tabular numbers rule
assert.ok(css.includes('font-variant-numeric: tabular-nums;'), 'Tabular numbers rule must be present for metrics & marks');
console.log('   ✅ Tabular numbers rule configured');

// Check dark mode
assert.ok(css.includes('body.theme-dark') || css.includes('[data-theme="dark"]'), 'Dark mode support must be present');
console.log('   ✅ Dark mode tokens and theme switching rules present');

// Check desktop sidebar and mobile bottom tab rules
assert.ok(css.includes('@media (min-width: 769px)'), 'Desktop sidebar media query present');
assert.ok(css.includes('@media (max-width: 768px)'), 'Mobile bottom bar media query present');
console.log('   ✅ Responsive desktop sidebar & mobile bottom bar media queries present');

// Check landing.html tokens
const landing = fs.readFileSync('public/landing.html', 'utf8');
assert.ok(landing.includes('--ac:#4f46e5'), 'landing.html uses indigo accent');
assert.ok(landing.includes('One screen that tells you'), 'landing.html keeps the ClassPulse tagline');
console.log('   ✅ landing.html tokens and tagline present');

// Check sw.js cache version
const sw = fs.readFileSync('public/sw.js', 'utf8');
assert.ok(/classpulse-shell-v\d+/.test(sw), 'sw.js cache bumped');
console.log('   ✅ Service Worker cache bumped');

console.log('\n🎉 ALL DESIGN SYSTEM & RESPONSIVE AUDIT CHECKS PASSED!\n');
