// ============================================================
// CALEBRATE — tracker.js
// Created by:  Caleb Garritson
// Email:       caleb.garritson@gusto.com
// GitHub:      github.com/CalebGarritson/Prospect-tracker
// Created:     April 2026
// Description: Core application logic for Calebrate.
//              Handles GitHub API sync, prospect/focus rendering,
//              settings management, and Salesforce ownership
//              validation. All data stored in the user's private
//              GitHub repo — no server required.
// ============================================================
const REPO   = 'Prospect-tracker';
const BRANCH = 'main';
const PATHS  = {
prospects: 'data/prospects.json',
focus:     'data/focus.json',
settings:  'data/settings.json'
};
let _token = localStorage.getItem('pt_token') || '';
let _owner = localStorage.getItem('pt_owner') || '';
let prospects    = [];
let dailyFocus   = [];
let appSettings  = {};
let _pSHA        = null;
let _fSHA        = null;
let _sSHA        = null;
let _saveTimer   = null;
let _focusSaveT  = null;
// ── Reminders ──
let _reminders = JSON.parse(localStorage.getItem('pt_reminders') || '{}');
const MAX_REMINDERS = 3;
let _pickerProspectId = null;
let _pickerProspectType = null;
const _now = new Date();
const TODAY_UTC = Date.UTC(_now.getFullYear(), _now.getMonth(), _now.getDate());
function calculateDays(date) {
const d = date instanceof Date ? date : new Date(date);
const dUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
return Math.round((dUTC - TODAY_UTC) / 86400000);
}
function formatDate(date) {
const d = date instanceof Date ? date : new Date(date);
return `${d.getUTCMonth()+1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}
function formatHoldDate(str) {
if (!str) return '—';
const [y,m,d] = str.split('-');
return `${parseInt(m)}/${parseInt(d)}/${y}`;
}
// ── Lead Scoring ──
const HIGH_INTENT_KW = ['demo', 'pricing', 'switching', 'quote', 'interested'];
const MED_INTENT_KW  = ['payroll', 'run payroll', 'payroll provider', 'gusto', 'benefits', 'hr solution', 'onboarding', 'referral'];
const LOW_INTENT_KW  = ['employees', 'small business', 'direct deposit', 'contractors', 'hiring'];
const GENERIC_DOMAINS = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','me.com','aol.com','live.com','msn.com'];
let _focusSortMode = 'received';

function calculateLeadScore(lead) {
const b = { keywords: 0, keywordList: [], company: 0, recency: 0, priority: 0, hold: 0 };
// Check matchedKeywords if available (set by Code.gs), else scan notes
if (lead.matchedKeywords && lead.matchedKeywords.length) {
  lead.matchedKeywords.forEach(function(mk) {
    var pts = mk.tier === 'high' ? 3 : mk.tier === 'medium' ? 2 : 1;
    b.keywords += pts;
    b.keywordList.push({ kw: mk.kw, pts: pts });
  });
} else {
  var text = ((lead.notes || '') + ' ' + (lead.subject || '')).toLowerCase();
  HIGH_INTENT_KW.forEach(function(kw) { if (text.includes(kw)) { b.keywords += 3; b.keywordList.push({ kw: kw, pts: 3 }); } });
  MED_INTENT_KW.forEach(function(kw) { if (text.includes(kw)) { b.keywords += 2; b.keywordList.push({ kw: kw, pts: 2 }); } });
  LOW_INTENT_KW.forEach(function(kw) { if (text.includes(kw)) { b.keywords += 1; b.keywordList.push({ kw: kw, pts: 1 }); } });
}
if (lead.email) {
  var domain = (lead.email.split('@')[1] || '').toLowerCase();
  if (domain && !GENERIC_DOMAINS.includes(domain)) b.company = 2;
}
if (lead.receivedDate) {
  var age = -calculateDays(lead.receivedDate);
  if (age <= 1) b.recency = 2;
  else if (age <= 3) b.recency = 1;
}
b.priority = lead.priority || 0;
if (lead.status === 'hold') b.hold = -2;
var total = b.keywords + b.company + b.recency + b.priority + b.hold;
return { total: Math.max(total, 0), breakdown: b };
}

function getScoreBadgeClass(score) {
return score >= 8 ? 'score-high' : score >= 4 ? 'score-medium' : 'score-low';
}

function buildScoreTooltip(lead) {
var b = lead._scoreBreakdown;
if (!b) return '';
var h = '<div class="score-tooltip"><div class="score-tooltip-title">' + esc(lead.name) + '</div>';
if (b.keywordList.length > 0) {
  b.keywordList.forEach(function(k) {
    h += '<div class="score-tooltip-row"><span>"' + esc(k.kw) + '"</span><span class="score-val positive">+' + k.pts + '</span></div>';
  });
} else {
  h += '<div class="score-tooltip-row"><span>No keywords matched</span><span class="score-val">0</span></div>';
}
if (b.company > 0) h += '<div class="score-tooltip-row"><span>Company domain</span><span class="score-val positive">+' + b.company + '</span></div>';
if (b.recency > 0) h += '<div class="score-tooltip-row"><span>Recent (' + (b.recency === 2 ? '0–1d' : '2–3d') + ')</span><span class="score-val positive">+' + b.recency + '</span></div>';
if (b.priority > 0) h += '<div class="score-tooltip-row"><span>Priority (' + b.priority + ' dot' + (b.priority > 1 ? 's' : '') + ')</span><span class="score-val positive">+' + b.priority + '</span></div>';
if (b.hold < 0) h += '<div class="score-tooltip-row"><span>On hold</span><span class="score-val negative">' + b.hold + '</span></div>';
h += '<div class="score-tooltip-divider"></div>';
h += '<div class="score-tooltip-row"><span><strong>Total</strong></span><span class="score-tooltip-total">' + (lead._score || 0) + '</span></div>';
h += '</div>';
return h;
}

function sortFocusLeads(leads) {
var sorted = leads.slice();
if (_focusSortMode === 'score') {
  sorted.sort(function(a, b) {
    if (b._score !== a._score) return b._score - a._score;
    return (b.receivedDate || '').localeCompare(a.receivedDate || '');
  });
} else {
  sorted.sort(function(a, b) {
    var dc = (b.receivedDate || '').localeCompare(a.receivedDate || '');
    if (dc !== 0) return dc;
    return b._score - a._score;
  });
}
return sorted;
}

function toggleFocusSort(col) {
_focusSortMode = (_focusSortMode === col) ? 'received' : col;
var recTh = document.getElementById('focusSortReceivedTh');
var scoreTh = document.getElementById('focusSortScoreTh');
var label = document.getElementById('focusSortLabel');
var recArrow = document.getElementById('focusSortReceivedArrow');
var scoreArrow = document.getElementById('focusSortScoreArrow');
if (_focusSortMode === 'score') {
  recTh.classList.remove('active-sort');
  scoreTh.classList.add('active-sort');
  label.textContent = 'Sorted by Score';
  label.className = 'sort-mode-indicator score';
  recArrow.innerHTML = '▲';
  scoreArrow.innerHTML = '▼';
} else {
  scoreTh.classList.remove('active-sort');
  recTh.classList.add('active-sort');
  label.textContent = 'Sorted by Received';
  label.className = 'sort-mode-indicator received';
  recArrow.innerHTML = '▼';
  scoreArrow.innerHTML = '▲';
}
renderFocus();
showReminderToast('Hot Leads sorted by ' + (_focusSortMode === 'score' ? 'lead score' : 'received date'));
}

function getDaysClass(days) {
if (days <= -90) return 'archived';
if (days  <   0) return 'overdue';
if (days === 0)  return 'today';
if (days <=  7)  return 'upcoming-soon';
return 'upcoming-later';
}
// ── Auto-setup: check if repo exists, create it + seed data files ──
async function checkRepoExists() {
const res = await fetch(
`https://api.github.com/repos/${_owner}/${REPO}`,
{ headers: { 'Authorization': `token ${_token}`, 'Accept': 'application/vnd.github.v3+json' } }
);
return res.ok;
}
async function bootstrapRepo(statusCb) {
// 1) Create private repo
statusCb('Creating your private data repo…');
const createRes = await fetch('https://api.github.com/user/repos', {
method: 'POST',
headers: {
'Authorization': `token ${_token}`,
'Accept': 'application/vnd.github.v3+json',
'Content-Type': 'application/json'
},
body: JSON.stringify({
name: REPO,
private: true,
description: 'Private data store for Calebrate prospect tracker',
auto_init: true          // creates main branch with a README
})
});
if (!createRes.ok) {
const txt = await createRes.text();
throw new Error(`Could not create repo: ${txt}`);
}
// Brief pause to let GitHub finish initializing the default branch
await new Promise(r => setTimeout(r, 1500));
// 2) Seed the three data files
const seeds = [
{ path: PATHS.prospects, data: [],  msg: 'Seed prospects.json' },
{ path: PATHS.focus,     data: [],  msg: 'Seed focus.json' },
{ path: PATHS.settings,  data: { initialScanStartDate: null },  msg: 'Seed settings.json' }
];
for (const seed of seeds) {
statusCb(`Creating ${seed.path}…`);
const content = btoa(unescape(encodeURIComponent(JSON.stringify(seed.data, null, 2))));
const res = await fetch(
`https://api.github.com/repos/${_owner}/${REPO}/contents/${seed.path}`,
{
method: 'PUT',
headers: {
'Authorization': `token ${_token}`,
'Accept': 'application/vnd.github.v3+json',
'Content-Type': 'application/json'
},
body: JSON.stringify({ message: seed.msg, content, branch: BRANCH })
}
);
if (!res.ok) {
const txt = await res.text();
throw new Error(`Failed to create ${seed.path}: ${txt}`);
}
}
statusCb('Setup complete — loading tracker…');
}
async function ghRead(path) {
const res = await fetch(
`https://api.github.com/repos/${_owner}/${REPO}/contents/${path}?ref=${BRANCH}&t=${Date.now()}`,
{ headers: { 'Authorization': `token ${_token}`, 'Accept': 'application/vnd.github.v3+json' } }
);
if (!res.ok) {
const txt = await res.text();
throw new Error(`GitHub read error ${res.status}: ${txt}`);
}
const json = await res.json();
const decoded = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ''))));
return { data: JSON.parse(decoded), sha: json.sha };
}
async function ghWrite(path, data, sha, msg) {
const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
const body = { message: msg || `Update ${path}`, content, branch: BRANCH };
if (sha) body.sha = sha;
const res = await fetch(
`https://api.github.com/repos/${_owner}/${REPO}/contents/${path}`,
{
method: 'PUT',
headers: {
'Authorization': `token ${_token}`,
'Accept': 'application/vnd.github.v3+json',
'Content-Type': 'application/json'
},
body: JSON.stringify(body)
}
);
if (!res.ok) {
const txt = await res.text();
throw new Error(`GitHub write error ${res.status}: ${txt}`);
}
const json = await res.json();
return json.content.sha;
}
function setSyncStatus(state, msg) {
const badge = document.getElementById('syncBadge');
const dot   = document.getElementById('syncDot');
const label = document.getElementById('syncLabel');
badge.className = 'sync-badge ' + (state || '');
dot.className   = 'sync-dot' + (state === 'saving' ? ' pulse' : '');
label.textContent = msg;
}
function showSetupScreen() {
document.getElementById('setupScreen').classList.add('active');
document.getElementById('mainApp').style.display = 'none';
}
function hideSetupScreen() {
document.getElementById('setupScreen').classList.remove('active');
document.getElementById('mainApp').style.display = 'block';
}
function goToSetupStep(step) {
  document.getElementById('setupStep1').style.display = step === 1 ? 'block' : 'none';
  document.getElementById('setupStep2').style.display = step === 2 ? 'block' : 'none';
  var step3 = document.getElementById('setupStep3Content');
  if (step3) step3.style.display = step === 3 ? 'block' : 'none';
  // Update progress indicators
  var steps = [
    { el: document.getElementById('progStep1'), conn: null },
    { el: document.getElementById('progStep2'), conn: document.getElementById('progConn1') },
    { el: document.getElementById('progStep3'), conn: document.getElementById('progConn2') }
  ];
  for (var i = 0; i < steps.length; i++) {
    if (!steps[i].el) continue;
    steps[i].el.classList.remove('active', 'completed');
    if (i + 1 < step) {
      steps[i].el.classList.add('completed');
      if (steps[i].conn) steps[i].conn.classList.add('completed');
    } else if (i + 1 === step) {
      steps[i].el.classList.add('active');
    }
    if (steps[i].conn && i + 1 >= step) steps[i].conn.classList.remove('completed');
  }
  // Clear errors when switching steps
  var errEl = document.getElementById('setupError');
  if (errEl) errEl.classList.remove('visible');
}
document.getElementById('setupForm').addEventListener('submit', async (e) => {
e.preventDefault();
const owner       = document.getElementById('setupOwner').value.trim();
const token       = document.getElementById('setupToken').value.trim();
const displayName = document.getElementById('setupName').value.trim();
const workEmail   = document.getElementById('setupEmail').value.trim();
const sfId        = document.getElementById('setupSalesforceId').value.trim();
const errEl       = document.getElementById('setupError');
errEl.classList.remove('visible');
// Validate @gusto.com email
if (!workEmail.toLowerCase().endsWith('@gusto.com')) {
errEl.textContent = '❌ Please use your @gusto.com work email address.';
errEl.classList.add('visible');
return;
}
// Validate Salesforce ID format (starts with 005, 15 or 18 chars)
if (!/^005[a-zA-Z0-9]{12,15}$/.test(sfId)) {
errEl.textContent = '❌ Salesforce User ID should start with "005" and be 15–18 characters. Click the ? for help finding it.';
errEl.classList.add('visible');
return;
}
_owner = owner;
_token = token;
const statusEl = document.getElementById('setupStatus');
const showStatus = (msg) => { if (statusEl) { statusEl.textContent = msg; statusEl.style.display = 'block'; } };
const hideStatus = ()    => { if (statusEl) { statusEl.style.display = 'none'; } };
try {
// Check whether the data repo already exists
showStatus('Checking GitHub connection…');
const repoExists = await checkRepoExists();
if (!repoExists) {
// Auto-create repo + seed files for first-time users
await bootstrapRepo(showStatus);
}
hideStatus();
await loadAll();
// Save profile info to settings
appSettings.displayName  = displayName;
appSettings.workEmail    = workEmail;
appSettings.salesforceId = sfId;
await doSaveSettings();
localStorage.setItem('pt_owner', owner);
localStorage.setItem('pt_token', token);
goToSetupStep(3);
renderAll();
setGreeting();
} catch (err) {
hideStatus();
errEl.textContent = '❌ ' + err.message + ' — Check your username and token, then try again.';
errEl.classList.add('visible');
_owner = '';
_token = '';
}
});
function openSFHelp()  { document.getElementById('sfHelpModal').classList.add('active'); }
function closeSFHelp() { document.getElementById('sfHelpModal').classList.remove('active'); }
document.addEventListener('click', e => { if (e.target.id === 'sfHelpModal') closeSFHelp(); });
function openGHHelp()  { document.getElementById('ghHelpModal').classList.add('active'); }
function closeGHHelp() { document.getElementById('ghHelpModal').classList.remove('active'); }
document.addEventListener('click', e => { if (e.target.id === 'ghHelpModal') closeGHHelp(); });
function openGmailGuide() { document.getElementById('gmailGuideModal').classList.add('active'); }
function closeGmailGuide() { document.getElementById('gmailGuideModal').classList.remove('active'); }
function disconnectGitHub() {
if (!confirm('Disconnect GitHub? You\'ll need to re-enter your token. Your data stays safe in GitHub.')) return;
localStorage.removeItem('pt_token');
localStorage.removeItem('pt_owner');
location.reload();
}
async function loadAll() {
setSyncStatus('saving', 'Loading…');
const [p, f, s] = await Promise.all([
ghRead(PATHS.prospects),
ghRead(PATHS.focus),
ghRead(PATHS.settings).catch(() => ({ data: defaultSettings(), sha: null }))
]);
prospects   = p.data.map(normalizeProspect);
_pSHA       = p.sha;
dailyFocus  = f.data;
_fSHA       = f.sha;
appSettings = { ...defaultSettings(), ...s.data };
_sSHA       = s.sha;
setSyncStatus('saved', 'Synced ✓');
}
function normalizeProspect(p) {
return { ...p, date: new Date(p.date + 'T00:00:00Z'), priority: p.priority || 0 };
}
function defaultSettings() {
return {
displayName:   '',
workEmail:     '',
gmailQuery:    'newer_than:2d in:inbox',
leadKeywords:  'payroll, gusto, small business, interested, quote, employees, onboarding, hr solution, benefits',
scanSchedule:  'daily_7am',
salesforceId:  ''
};
}
function scheduleSave() {
setSyncStatus('saving', 'Saving…');
clearTimeout(_saveTimer);
_saveTimer = setTimeout(doSaveProspects, 2000);
}
function scheduleFocusSave() {
setSyncStatus('saving', 'Saving…');
clearTimeout(_focusSaveT);
_focusSaveT = setTimeout(doSaveFocus, 2000);
}
async function doSaveProspects() {
try {
const serialized = prospects.map(p => ({
...p,
date: p.date.toISOString().split('T')[0]
}));
_pSHA = await ghWrite(PATHS.prospects, serialized, _pSHA, 'Update prospects');
setSyncStatus('saved', 'Saved ✓');
} catch (err) {
setSyncStatus('error', '⚠ Save failed — click to retry');
document.getElementById('syncBadge').onclick = doSaveProspects;
console.error(err);
}
}
async function doSaveFocus() {
try {
_fSHA = await ghWrite(PATHS.focus, dailyFocus, _fSHA, 'Update daily focus');
setSyncStatus('saved', 'Saved ✓');
} catch (err) {
setSyncStatus('error', '⚠ Save failed — click to retry');
document.getElementById('syncBadge').onclick = doSaveFocus;
console.error(err);
}
}
async function doSaveSettings() {
try {
_sSHA = await ghWrite(PATHS.settings, appSettings, _sSHA, 'Update settings');
} catch (err) { console.error('Settings save failed', err); }
}
function renderAll() {
renderReminders();
renderTable(prospects);
renderFocus();
renderTasks();
renderHomeCards();
}
function renderTable(data) {
const tbR = document.getElementById('tbodyReady');
const tbF = document.getElementById('tbodyFuture');
const tbA = document.getElementById('tbodyArchive');
tbR.innerHTML = tbF.innerHTML = tbA.innerHTML = '';
const archived = data.filter(p => calculateDays(p.date) <= -90);
const ready    = data.filter(p => { const d = calculateDays(p.date); return d > -90 && d <= 0; })
.sort((a,b) => b.date - a.date);
const future   = data.filter(p => calculateDays(p.date) > 0)
.sort((a,b) => a.date - b.date);
document.getElementById('countReady').textContent   = ready.length;
document.getElementById('countFuture').textContent  = future.length;
document.getElementById('countArchive').textContent = archived.length;
if (!ready.length)   tbR.innerHTML = '<tr class="empty-state-row"><td colspan="8">No prospects ready to call.</td></tr>';
if (!future.length)  tbF.innerHTML = '<tr class="empty-state-row"><td colspan="8">No upcoming prospects.</td></tr>';
if (!archived.length) tbA.innerHTML = '<tr class="empty-state-row"><td colspan="8">No archived prospects.</td></tr>';
[{ tb: tbR, items: ready }, { tb: tbF, items: future }].forEach(({ tb, items }) => {
items.forEach(p => {
const days      = calculateDays(p.date);
const cls       = getDaysClass(days);
const daysText  = days < 0 ? `${days}d` : days === 0 ? 'Today' : `+${days}d`;
const pR = getReminders(p.id);
const hasR = pR.length > 0;
const countDot = hasR ? `<span class="reminder-count-dot">${pR.length}</span>` : '';
const row = document.createElement('tr');
row.className = 'prospect-row';
row.onclick = () => toggleExpanded(row);
row.innerHTML = `
<td style="padding:0 6px;"><div class="swatch ${cls}"></div></td>
<td>
<div style="font-weight:600;">${esc(p.contact)}</div>
${p.email ? `<div style="font-size:11px;color:var(--text-secondary);">${esc(p.email)}</div>` : ''}
</td>
<td>${formatDate(p.date)}</td>
<td><span class="days-pill ${cls}">${daysText}</span></td>
<td><div class="notes-cell"><div class="notes-truncated">${esc(p.notes||'')}</div></div></td>
<td onclick="event.stopPropagation()">
<div class="priority-dots">
<div class="priority-dot ${p.priority>=1?'active-1':''}" onclick="setPriority(${p.id},1)"></div>
<div class="priority-dot ${p.priority>=2?'active-2':''}" onclick="setPriority(${p.id},2)"></div>
<div class="priority-dot ${p.priority>=3?'active-3':''}" onclick="setPriority(${p.id},3)"></div>
</div>
</td>
<td onclick="event.stopPropagation()"><button class="reminder-btn ${hasR?'has-reminder':''}" onclick="openTimePicker(${p.id},'prospect')" title="${hasR ? pR.length+' reminder(s)' : 'Set reminder'}">&#x1F514;${countDot}</button></td>
<td onclick="event.stopPropagation()">
<div class="actions">
<button class="action-btn" onclick="editProspect(event,${p.id})">Edit</button>
<button class="action-btn delete" onclick="deleteProspect(event,${p.id})">Delete</button>
</div>
</td>`;
tb.appendChild(row);
const expRow = document.createElement('tr');
expRow.className = 'expanded-row';
expRow.innerHTML = `<td colspan="8"><div class="expanded-content"><h3>Full Notes</h3><p>${esc(p.notes||'')}</p></div></td>`;
tb.appendChild(expRow);
});
});
archived.forEach(p => {
const days     = calculateDays(p.date);
const daysText = `${days}d`;
const pR = getReminders(p.id);
const hasR = pR.length > 0;
const countDot = hasR ? `<span class="reminder-count-dot">${pR.length}</span>` : '';
const row = document.createElement('tr');
row.className = 'prospect-row';
row.onclick = () => toggleExpanded(row);
row.innerHTML = `
<td style="text-align:center;" onclick="event.stopPropagation()">
<input type="checkbox" class="archive-checkbox archive-row-cb" data-id="${p.id}" onchange="updateToolbar()">
</td>
<td style="padding:0 6px;"><div class="swatch archived"></div></td>
<td>
<div style="font-weight:600;">${esc(p.contact)}</div>
${p.email ? `<div style="font-size:11px;color:var(--text-secondary);">${esc(p.email)}</div>` : ''}
</td>
<td>${formatDate(p.date)}</td>
<td><span class="days-pill archived">${daysText}</span></td>
<td><div class="notes-cell"><div class="notes-truncated">${esc(p.notes||'')}</div></div></td>
<td onclick="event.stopPropagation()"><button class="reminder-btn ${hasR?'has-reminder':''}" onclick="openTimePicker(${p.id},'prospect')" title="${hasR ? pR.length+' reminder(s)' : 'Set reminder'}">&#x1F514;${countDot}</button></td>
<td onclick="event.stopPropagation()">
<div class="actions">
<button class="action-btn" onclick="editProspect(event,${p.id})">Edit</button>
</div>
</td>`;
tbA.appendChild(row);
const expRow = document.createElement('tr');
expRow.className = 'expanded-row';
expRow.innerHTML = `<td colspan="8"><div class="expanded-content"><h3>Full Notes</h3><p>${esc(p.notes||'')}</p></div></td>`;
tbA.appendChild(expRow);
});
updateToolbar();
}
function renderFocus() {
const tbody  = document.getElementById('tbodyFocus');
tbody.innerHTML = '';
const active = dailyFocus.filter(p => p.status !== 'done');
document.getElementById('countFocus').textContent = active.length;
const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/Denver', month:'short', day:'numeric' });
document.getElementById('focusUpdated').textContent = `Updated ${today}`;
if (!dailyFocus.length) {
tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;color:var(--text-secondary)">No hot leads yet. Leads from your Gmail scan will appear here.</td></tr>';
return;
}
// Calculate scores
dailyFocus.forEach(p => {
const result = calculateLeadScore(p);
p._score = result.total;
p._scoreBreakdown = result.breakdown;
});
// Sort
const sorted = sortFocusLeads(dailyFocus);
sorted.forEach(p => {
let swatchCls, pillCls, pillLabel;
if      (p.status === 'new')    { swatchCls = 'focus-new';    pillCls = 'new-lead'; pillLabel = 'New Lead'; }
else if (p.status === 'hold')   { swatchCls = 'focus-hold';   pillCls = 'hold';     pillLabel = p.holdUntil ? `Hold · ${formatHoldDate(p.holdUntil)}` : 'On Hold'; }
else if (p.status === 'called') { swatchCls = 'focus-called'; pillCls = 'called';   pillLabel = 'Called'; }
else if (p.status === 'done')   { swatchCls = 'archived';     pillCls = 'done';     pillLabel = 'Done'; }
else                            { swatchCls = 'focus-active'; pillCls = 'active';   pillLabel = 'Active'; }
const pR = getReminders(p.id);
const hasR = pR.length > 0;
const countDot = hasR ? `<span class="reminder-count-dot">${pR.length}</span>` : '';
const scoreCls = getScoreBadgeClass(p._score);
const tooltip = buildScoreTooltip(p);
const row = document.createElement('tr');
row.className = 'prospect-row';
row.onclick = () => toggleExpanded(row);
row.style.opacity = p.status === 'done' ? '0.45' : '1';
row.innerHTML = `
<td style="padding:0 6px;"><div class="swatch ${swatchCls}"></div></td>
<td class="focus-name-cell">
<div style="font-weight:600;">${esc(p.name)}</div>
<div style="font-size:11px;color:var(--text-secondary);">${esc(p.company||'')} ${p.email ? '· ' + esc(p.email) : ''}</div>
</td>
<td style="color:var(--text-secondary);font-size:13px;">${p.receivedDate ? formatHoldDate(p.receivedDate) : '—'}</td>
<td><span class="status-pill ${pillCls}">${pillLabel}</span></td>
<td onclick="event.stopPropagation()"><div class="score-breakdown"><span class="lead-score-badge ${scoreCls}">${p._score}</span>${tooltip}</div></td>
<td><div class="notes-cell"><div class="notes-truncated">${esc(p.notes||'')}</div></div></td>
<td onclick="event.stopPropagation()">
<div class="priority-dots">
<div class="priority-dot ${p.priority>=1?'active-1':''}" onclick="setFocusPriority('${p.id}',1)"></div>
<div class="priority-dot ${p.priority>=2?'active-2':''}" onclick="setFocusPriority('${p.id}',2)"></div>
<div class="priority-dot ${p.priority>=3?'active-3':''}" onclick="setFocusPriority('${p.id}',3)"></div>
</div>
</td>
<td onclick="event.stopPropagation()"><button class="reminder-btn ${hasR?'has-reminder':''}" onclick="openTimePicker('${p.id}','focus')" title="${hasR ? pR.length+' reminder(s)' : 'Set reminder'}">&#x1F514;${countDot}</button></td>
<td onclick="event.stopPropagation()">
<div class="actions">
<button class="action-btn" onclick="editFocusProspect(event,'${p.id}')">Edit</button>
<button class="action-btn delete" onclick="deleteFocusProspect(event,'${p.id}')">Delete</button>
</div>
</td>`;
tbody.appendChild(row);
const expRow = document.createElement('tr');
expRow.className = 'expanded-row';
expRow.innerHTML = `<td colspan="9"><div class="expanded-content"><h3>Notes</h3><p>${esc(p.notes||'')}</p></div></td>`;
tbody.appendChild(expRow);
});
}
function toggleExpanded(row) {
const next = row.nextElementSibling;
if (next && next.classList.contains('expanded-row')) next.classList.toggle('active');
}
function setPriority(id, level) {
const p = prospects.find(x => x.id === id);
if (!p) return;
p.priority = p.priority === level ? 0 : level;
renderTable(prospects);
scheduleSave();
}
let _editingId = null;
function editProspect(e, id) {
e.stopPropagation();
const p = prospects.find(x => x.id === id);
if (!p) return;
_editingId = id;
document.getElementById('modalHeader').textContent = 'Edit Prospect';
document.getElementById('formContact').value = p.contact;
document.getElementById('formEmail').value   = p.email || '';
document.getElementById('formDate').value    = p.date.toISOString().split('T')[0];
document.getElementById('formNotes').value   = p.notes || '';
document.getElementById('addModal').classList.add('active');
}
function deleteProspect(e, id) {
e.stopPropagation();
if (!confirm('Delete this prospect?')) return;
prospects = prospects.filter(p => p.id !== id);
renderTable(prospects);
scheduleSave();
}
function openAddModal() {
_editingId = null;
document.getElementById('modalHeader').textContent = 'Add New Prospect';
document.getElementById('addForm').reset();
document.getElementById('addModal').classList.add('active');
}
function closeAddModal() { document.getElementById('addModal').classList.remove('active'); }
document.getElementById('addForm').addEventListener('submit', (e) => {
e.preventDefault();
const contact   = document.getElementById('formContact').value.trim();
const email     = document.getElementById('formEmail').value.trim();
const dateParts = document.getElementById('formDate').value.split('-');
const date      = new Date(Date.UTC(+dateParts[0], +dateParts[1]-1, +dateParts[2]));
const notes     = document.getElementById('formNotes').value.trim();
if (_editingId !== null) {
const p = prospects.find(x => x.id === _editingId);
Object.assign(p, { contact, email, date, notes });
_editingId = null;
} else {
const maxId = prospects.length ? Math.max(...prospects.map(p => p.id)) : 0;
prospects.push({ id: maxId + 1, contact, email, priority: 0, date, notes });
}
renderTable(prospects);
scheduleSave();
closeAddModal();
});
// Modal lock: click-outside-to-close removed — use Cancel/Submit buttons
function toggleArchive() {
document.getElementById('archiveBody').classList.toggle('open');
document.getElementById('archiveChevron').classList.toggle('open');
}
function updateToolbar() {
const boxes    = document.querySelectorAll('.archive-row-cb');
const checked  = document.querySelectorAll('.archive-row-cb:checked');
const toolbar  = document.getElementById('archiveToolbar');
const container= document.getElementById('archiveTableContainer');
const selAll   = document.getElementById('selectAll');
const n = checked.length;
if (n > 0) { toolbar.classList.add('visible'); container.classList.add('has-toolbar'); }
else        { toolbar.classList.remove('visible'); container.classList.remove('has-toolbar'); }
document.getElementById('archiveSelectedText').textContent = `${n} selected`;
if (!boxes.length)         { selAll.checked = false; selAll.indeterminate = false; }
else if (n === boxes.length){ selAll.checked = true;  selAll.indeterminate = false; }
else if (n > 0)            { selAll.checked = false; selAll.indeterminate = true;  }
else                       { selAll.checked = false; selAll.indeterminate = false; }
}
function toggleSelectAll(el) {
document.querySelectorAll('.archive-row-cb').forEach(cb => cb.checked = el.checked);
updateToolbar();
}
function deleteSelected() {
const checked = document.querySelectorAll('.archive-row-cb:checked');
if (!checked.length) return;
if (!confirm(`Delete ${checked.length} archived prospect${checked.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
const ids = Array.from(checked).map(cb => parseInt(cb.dataset.id));
prospects = prospects.filter(p => !ids.includes(p.id));
renderTable(prospects);
scheduleSave();
}
function setFocusPriority(id, level) {
const p = dailyFocus.find(x => x.id === id);
if (!p) return;
p.priority = p.priority === level ? 0 : level;
renderFocus();
scheduleFocusSave();
}
let _editingFocusId = null;
function openFocusModal() {
_editingFocusId = null;
document.getElementById('focusModalHeader').textContent = 'Add Focus Lead';
document.getElementById('focusForm').reset();
document.getElementById('holdUntilGroup').style.display = 'none';
document.getElementById('focusModal').classList.add('active');
}
function closeFocusModal() { document.getElementById('focusModal').classList.remove('active'); }
function editFocusProspect(e, id) {
e.stopPropagation();
const p = dailyFocus.find(x => x.id === id);
if (!p) return;
_editingFocusId = id;
document.getElementById('focusModalHeader').textContent = 'Edit Focus Lead';
document.getElementById('focusFormName').value         = p.name;
document.getElementById('focusFormCompany').value      = p.company || '';
document.getElementById('focusFormEmail').value        = p.email || '';
document.getElementById('focusFormReceivedDate').value = p.receivedDate || '';
document.getElementById('focusFormStatus').value       = p.status;
document.getElementById('focusFormNotes').value        = p.notes || '';
document.getElementById('focusFormHoldUntil').value    = p.holdUntil || '';
toggleHoldUntil();
document.getElementById('focusModal').classList.add('active');
}
function deleteFocusProspect(e, id) {
e.stopPropagation();
if (!confirm('Remove this lead from Hot Leads?')) return;
dailyFocus = dailyFocus.filter(x => x.id !== id);
renderFocus();
scheduleFocusSave();
}
function toggleHoldUntil() {
const status = document.getElementById('focusFormStatus').value;
document.getElementById('holdUntilGroup').style.display = status === 'hold' ? 'block' : 'none';
}
document.getElementById('focusForm').addEventListener('submit', (e) => {
e.preventDefault();
const entry = {
name:         document.getElementById('focusFormName').value.trim(),
company:      document.getElementById('focusFormCompany').value.trim(),
email:        document.getElementById('focusFormEmail').value.trim(),
receivedDate: document.getElementById('focusFormReceivedDate').value,
status:       document.getElementById('focusFormStatus').value,
holdUntil:    document.getElementById('focusFormHoldUntil').value || null,
notes:        document.getElementById('focusFormNotes').value.trim(),
priority:     0
};
if (_editingFocusId !== null) {
const idx = dailyFocus.findIndex(x => x.id === _editingFocusId);
if (idx >= 0) dailyFocus[idx] = { ...dailyFocus[idx], ...entry };
_editingFocusId = null;
} else {
entry.id = 'df_' + Date.now();
dailyFocus.push(entry);
}
renderFocus();
scheduleFocusSave();
closeFocusModal();
});
// Modal lock: click-outside-to-close removed — use Cancel/Submit buttons
function openSettings() {
document.getElementById('settingName').value         = appSettings.displayName  || '';
document.getElementById('settingEmail').value        = appSettings.workEmail    || '';
document.getElementById('settingOwner').value        = _owner;
document.getElementById('settingGmailQuery').value   = appSettings.gmailQuery   || 'newer_than:2d in:inbox';
document.getElementById('settingKeywords').value     = appSettings.leadKeywords || '';
document.getElementById('settingScanSchedule').value = appSettings.scanSchedule || 'daily_7am';
document.getElementById('settingsModal').classList.add('active');
}
function closeSettings() { document.getElementById('settingsModal').classList.remove('active'); }
function saveSettings() {
appSettings.displayName  = document.getElementById('settingName').value.trim();
appSettings.workEmail    = document.getElementById('settingEmail').value.trim();
appSettings.gmailQuery   = document.getElementById('settingGmailQuery').value.trim();
appSettings.leadKeywords = document.getElementById('settingKeywords').value.trim();
appSettings.scanSchedule = document.getElementById('settingScanSchedule').value;
doSaveSettings();
setGreeting();
}
// Modal lock: click-outside-to-close removed — use Cancel/Submit buttons
function validateSalesforceOwnership(leadOwnerId) {
const trackerOwner = appSettings.salesforceId || '';
if (!trackerOwner) {
return { allowed: false, reason: 'No Salesforce ID configured for this tracker. Open Settings to add yours.' };
}
if (trackerOwner.toLowerCase() !== (leadOwnerId || '').toLowerCase()) {
return {
allowed: false,
reason: `⚠ Ownership mismatch: this tracker belongs to "${trackerOwner}" but the Salesforce lead is owned by "${leadOwnerId}". Task creation blocked.`
};
}
return { allowed: true, reason: 'Ownership verified.' };
}
window.__sfOwnerCheck = validateSalesforceOwnership;
function esc(str) {
return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// ============================================================
// REMINDERS — bell icon, time picker, notifications
// ============================================================
function getReminders(id) { return _reminders[id] || []; }
function getTotalReminderCount() {
let c = 0; Object.keys(_reminders).forEach(k => { c += _reminders[k].length; });
_tasks.forEach(t => { if (!t.done && t.time) c++; });
return c;
}
function saveReminders() { localStorage.setItem('pt_reminders', JSON.stringify(_reminders)); }
function todayStr() {
const d = new Date();
return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function fmtTimeDisplay(t) {
if (!t) return '';
const parts = t.split(':'); const h = parseInt(parts[0]); const m = parts[1];
return (h % 12 || 12) + ':' + m + ' ' + (h >= 12 ? 'PM' : 'AM');
}
function fmtDateShort(d) {
if (!d) return '';
const p = d.split('-');
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
return months[parseInt(p[1])-1] + ' ' + parseInt(p[2]);
}
function isToday(dateStr) { return dateStr === todayStr(); }
function findProspectInfo(id) {
// Check if it's a task reminder (id starts with "task_")
if (typeof id === 'string' && id.startsWith('task_')) {
const actualId = id.replace(/^task_/, '');
const t = _tasks.find(x => x.id === id || x.id === actualId);
if (t) return { name: t.name, company: '', source: 'task' };
}
const numId = typeof id === 'string' && !id.startsWith('df_') && !id.startsWith('task_') ? parseInt(id) : id;
const p = prospects.find(x => x.id === numId || x.id === id);
if (p) return { name: p.contact, company: '', source: 'prospect' };
const f = dailyFocus.find(x => x.id === id);
if (f) return { name: f.name, company: f.company || '', source: 'focus' };
return null;
}
// ── Render Active Reminders list ──
function renderReminders() {
const list = document.getElementById('remindersList');
const countEl = document.getElementById('reminderCount');
if (!list || !countEl) return;
const all = [];
// Manual bell reminders (existing system)
Object.keys(_reminders).forEach(id => {
const info = findProspectInfo(id);
if (!info) return;
_reminders[id].forEach((r, idx) => {
const sourceLabel = info.company || (info.source === 'task' ? 'My Tasks' : info.source === 'focus' ? 'Hot Leads' : 'Prospects');
all.push({ prospectId: id, idx, date: r.date, time: r.time, name: info.name, source: sourceLabel, isAuto: false });
});
});
// Auto-reminders from tasks with a time set (not done)
_tasks.forEach(t => {
if (t.done || !t.time) return;
var autoKey = 'task_auto_' + t.id;
all.push({ prospectId: autoKey, idx: -1, date: t.due, time: t.time, name: t.name, source: 'My Tasks', isAuto: true, taskId: t.id });
});
const total = all.length;
countEl.textContent = total;
if (total === 0) {
list.innerHTML = '<div class="no-reminders">No reminders set. Click the bell icon next to any prospect to schedule one.</div>';
return;
}
all.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
list.innerHTML = '';
all.forEach(r => {
const dateLabel = isToday(r.date) ? 'Today' : fmtDateShort(r.date);
const dateClass = isToday(r.date) ? 'today-date' : '';
const autoTag = r.isAuto ? '<span class="reminder-auto-tag">Auto</span>' : '';
const item = document.createElement('div');
item.className = 'reminder-item';
if (r.isAuto) {
item.innerHTML =
'<div class="reminder-info">' +
'<div class="reminder-datetime">' +
'<span class="reminder-date ' + dateClass + '">' + dateLabel + '</span>' +
'<span class="reminder-time">' + fmtTimeDisplay(r.time) + '</span>' +
'</div>' +
'<div>' +
'<div class="reminder-name">' + esc(r.name) + autoTag + '</div>' +
'<div class="reminder-source">' + esc(r.source) + ' · Recurring</div>' +
'</div>' +
'</div>' +
'<div class="reminder-actions">' +
'<span style="font-size:11px;color:var(--text-secondary);opacity:.6;">Set in task</span>' +
'</div>';
} else {
item.innerHTML =
'<div class="reminder-info">' +
'<div class="reminder-datetime">' +
'<span class="reminder-date ' + dateClass + '">' + dateLabel + '</span>' +
'<span class="reminder-time">' + fmtTimeDisplay(r.time) + '</span>' +
'</div>' +
'<div>' +
'<div class="reminder-name">' + esc(r.name) + '</div>' +
'<div class="reminder-source">' + esc(r.source) + '</div>' +
'</div>' +
'</div>' +
'<div class="reminder-actions">' +
'<button class="reminder-edit" onclick="editReminder(\'' + r.prospectId + '\',' + r.idx + ')">Edit</button>' +
'<button class="reminder-cancel" onclick="cancelReminder(\'' + r.prospectId + '\',' + r.idx + ')">Cancel</button>' +
'</div>';
}
list.appendChild(item);
});
}
function cancelReminder(prospectId, idx) {
const info = findProspectInfo(prospectId);
_reminders[prospectId].splice(idx, 1);
if (_reminders[prospectId].length === 0) delete _reminders[prospectId];
saveReminders();
renderAll();
if (info) showReminderToast('Reminder cancelled for ' + info.name);
}
function editReminder(prospectId, idx) {
const pR = getReminders(prospectId);
if (!pR || !pR[idx]) return;
const old = pR[idx];
const info = findProspectInfo(prospectId);
if (!info) return;
const type = info.source === 'focus' ? 'focus' : 'prospect';
_pickerProspectId = String(prospectId);
_pickerProspectType = type;
const label = info.company ? info.name + ' — ' + info.company : info.name;
document.getElementById('pickerLabel').textContent = 'for ' + label;
document.getElementById('reminderDate').value = old.date;
document.getElementById('reminderDate').min = todayStr();
document.getElementById('reminderTime').value = old.time;
// Remove the old reminder so the slot is free for the new one
pR.splice(idx, 1);
if (pR.length === 0) delete _reminders[prospectId];
saveReminders();
updatePickerState();
renderAll();
document.getElementById('pickerOverlay').classList.add('active');
showReminderToast('Editing reminder for ' + info.name + ' — pick a new time');
}
// ── Time Picker ──
function openTimePicker(id, type) {
const strId = String(id);
const info = findProspectInfo(type === 'focus' ? id : parseInt(id) || id);
if (!info) return;
_pickerProspectId = strId;
_pickerProspectType = type;
const label = info.company ? info.name + ' — ' + info.company : info.name;
document.getElementById('pickerLabel').textContent = 'for ' + label;
document.getElementById('reminderDate').value = todayStr();
document.getElementById('reminderDate').min = todayStr();
const now = new Date();
now.setMinutes(now.getMinutes() + 30);
document.getElementById('reminderTime').value =
String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
updatePickerState();
document.getElementById('pickerOverlay').classList.add('active');
}
function updatePickerState() {
const pR = getReminders(_pickerProspectId);
const area = document.getElementById('existingRemindersArea');
const slotsMsg = document.getElementById('slotsFullMsg');
const fields = document.getElementById('newReminderFields');
const btn = document.getElementById('btnSetReminder');
const slotLabel = document.getElementById('slotLabel');
if (pR.length > 0) {
let html = '<div class="existing-reminders"><div class="existing-reminders-title">Current reminders</div>';
pR.forEach((r, idx) => {
const dateLabel = isToday(r.date) ? 'Today' : fmtDateShort(r.date);
html += '<span class="existing-reminder-chip">' +
'<span class="chip-text">' + dateLabel + ' at ' + fmtTimeDisplay(r.time) + '</span>' +
'<button class="chip-remove" onclick="removeReminderFromPicker(' + idx + ')" title="Remove">×</button>' +
'</span>';
});
html += '</div>';
area.innerHTML = html;
} else { area.innerHTML = ''; }
if (pR.length >= MAX_REMINDERS) {
slotsMsg.style.display = 'block'; fields.style.display = 'none'; btn.disabled = true;
} else {
slotsMsg.style.display = 'none'; fields.style.display = 'block'; btn.disabled = false;
slotLabel.textContent = 'Slot ' + (pR.length + 1) + ' of ' + MAX_REMINDERS;
}
}
function removeReminderFromPicker(idx) {
if (!_pickerProspectId) return;
const pR = getReminders(_pickerProspectId);
const removed = pR.splice(idx, 1)[0];
if (pR.length === 0) delete _reminders[_pickerProspectId];
saveReminders();
updatePickerState();
renderAll();
const info = findProspectInfo(_pickerProspectId);
if (info && removed) showReminderToast('Removed ' + fmtDateShort(removed.date) + ' ' + fmtTimeDisplay(removed.time) + ' reminder for ' + info.name);
}
function closeTimePicker() {
document.getElementById('pickerOverlay').classList.remove('active');
_pickerProspectId = null; _pickerProspectType = null;
}
function confirmReminder() {
if (!_pickerProspectId) return;
const date = document.getElementById('reminderDate').value;
const time = document.getElementById('reminderTime').value;
if (!date || !time) return;
const pR = getReminders(_pickerProspectId);
if (pR.length >= MAX_REMINDERS) return;
if (pR.some(r => r.date === date && r.time === time)) {
showReminderToast('A reminder already exists for that exact date and time.'); return;
}
const reminderDT = new Date(date + 'T' + time);
if (reminderDT <= new Date()) {
showReminderToast('That time has already passed. Pick a future date or time.'); return;
}
if (!_reminders[_pickerProspectId]) _reminders[_pickerProspectId] = [];
_reminders[_pickerProspectId].push({ date, time });
_reminders[_pickerProspectId].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
saveReminders();
const info = findProspectInfo(_pickerProspectId);
const dateLabel = isToday(date) ? 'today' : fmtDateShort(date);
updatePickerState();
renderAll();
showReminderToast('Reminder set for ' + info.name + ' — ' + dateLabel + ' at ' + fmtTimeDisplay(time));
// Advance time by 30 min for quick multi-add
const next = new Date(date + 'T' + time);
next.setMinutes(next.getMinutes() + 30);
document.getElementById('reminderTime').value =
String(next.getHours()).padStart(2,'0') + ':' + String(next.getMinutes()).padStart(2,'0');
}
// ── Notification engine — checks every 15 seconds ──
function checkReminders() {
const now = new Date();
const currentDate = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
const currentTime = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
let firedAny = false;
Object.keys(_reminders).forEach(id => {
const info = findProspectInfo(id);
if (!info) return;
for (let i = _reminders[id].length - 1; i >= 0; i--) {
const r = _reminders[id][i];
if (r.date < currentDate || (r.date === currentDate && r.time <= currentTime)) {
if ('Notification' in window && Notification.permission === 'granted') {
const dateLabel = isToday(r.date) ? '' : ' (' + fmtDateShort(r.date) + ')';
const notif = new Notification('Calebrate — Time to Call' + dateLabel, {
body: info.name + (info.company ? ' at ' + info.company : ''),
requireInteraction: true,
tag: 'calebrate-' + id + '-' + i
});
notif.onclick = function() { window.focus(); notif.close(); };
}
_reminders[id].splice(i, 1);
firedAny = true;
showReminderToast('Reminder fired for ' + info.name + '!');
}
}
if (_reminders[id] && _reminders[id].length === 0) delete _reminders[id];
});
// Auto-reminders from tasks with time set
_tasks.forEach(t => {
if (t.done || !t.time || t.notified) return;
if (t.due < currentDate || (t.due === currentDate && t.time <= currentTime)) {
if ('Notification' in window && Notification.permission === 'granted') {
const notif = new Notification('Calebrate — Task Reminder', {
body: t.name,
requireInteraction: true,
tag: 'calebrate-task-' + t.id
});
notif.onclick = function() { window.focus(); notif.close(); };
}
t.notified = true;
firedAny = true;
showReminderToast('Task reminder: ' + t.name + '!');
}
});
if (firedAny) { saveReminders(); renderAll(); }
}
setInterval(checkReminders, 15000);
// ── Auto-refresh when date changes (fixes stale tab) ──
const _loadDate = new Date().getDate();
setInterval(() => {
if (new Date().getDate() !== _loadDate) location.reload();
}, 60000);
// ── Notification permission ──
function updateNotifBanner() {
const banner = document.getElementById('notifBanner');
const text = document.getElementById('notifText');
const btn = document.getElementById('notifBtn');
if (!banner || !text || !btn) return;
if (!('Notification' in window)) {
text.textContent = 'Your browser does not support notifications.';
btn.style.display = 'none'; banner.classList.add('denied'); return;
}
if (Notification.permission === 'granted') {
text.textContent = 'Notifications enabled. Reminders will pop up on your screen even if this tab is in the background.';
btn.style.display = 'none'; banner.classList.add('granted');
} else if (Notification.permission === 'denied') {
text.textContent = 'Notifications blocked. Click the lock icon in your address bar to allow notifications.';
btn.style.display = 'none'; banner.classList.add('denied');
}
}
function requestNotifPermission() {
if (!('Notification' in window)) return;
Notification.requestPermission().then(() => {
updateNotifBanner();
if (Notification.permission === 'granted') showReminderToast('Notifications enabled!');
});
}
// ============================================================
// MY TASKS — recurring tasks, priority sorting, localStorage
// ============================================================
let _tasks = JSON.parse(localStorage.getItem('pt_tasks') || '[]');
let _editingTaskId = null;
let _taskRecurrence = 'once';
let _taskWeeklyDays = [];
let _taskMonthDay = 1;
let _taskSortMode = 'priority';

function saveTasks() { localStorage.setItem('pt_tasks', JSON.stringify(_tasks)); }

function getTaskSwatchClass(task) {
  if (task.done) return 'task-done';
  const d = calculateDays(task.due + 'T00:00:00Z');
  if (d < 0) return 'task-overdue';
  if (d === 0) return 'task-today';
  return 'task-upcoming';
}

function getTaskDueClass(task) {
  if (task.done) return '';
  const d = calculateDays(task.due + 'T00:00:00Z');
  if (d < 0) return 'overdue';
  if (d === 0) return 'today';
  return 'upcoming';
}

function getTaskDueText(task) {
  const d = calculateDays(task.due + 'T00:00:00Z');
  if (d < 0) return d + 'd';
  if (d === 0) return 'Today';
  return '+' + d + 'd';
}

function getRecurLabel(task) {
  if (task.recurrence === 'daily') return 'Daily';
  if (task.recurrence === 'weekly') {
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const days = (task.weeklyDays || []).map(d => dayNames[d]).join(', ');
    return 'Weekly' + (days ? ' · ' + days : '');
  }
  if (task.recurrence === 'monthly') return 'Monthly · ' + ordinal(task.monthDay || 1);
  return 'Once';
}

function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}

function getRecurPillClass(task) {
  if (task.recurrence === 'daily') return 'daily';
  if (task.recurrence === 'weekly') return 'weekly';
  if (task.recurrence === 'monthly') return 'monthly';
  return 'once';
}

function sortTasks(tasks) {
  return tasks.slice().sort((a, b) => {
    // Done tasks always sink to the bottom
    if (a.done && !b.done) return 1;
    if (!a.done && b.done) return -1;
    if (_taskSortMode === 'due') {
      // Sort by due date ascending (soonest first), then priority as tiebreaker
      var dateComp = a.due.localeCompare(b.due);
      if (dateComp !== 0) return dateComp;
      return b.priority - a.priority;
    } else {
      // Sort by priority descending (3 dots first), then due date as tiebreaker
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.due.localeCompare(b.due);
    }
  });
}

function toggleTaskSort() {
  _taskSortMode = _taskSortMode === 'priority' ? 'due' : 'priority';
  var dueTh = document.getElementById('sortDueTh');
  var label = document.getElementById('sortModeLabel');
  var arrow = document.getElementById('sortDueArrow');
  if (_taskSortMode === 'due') {
    dueTh.classList.add('active-sort');
    label.textContent = 'Sorted by Due Date';
    label.className = 'sort-mode-indicator due-date';
    arrow.textContent = '▼';
  } else {
    dueTh.classList.remove('active-sort');
    label.textContent = 'Sorted by Priority';
    label.className = 'sort-mode-indicator priority';
    arrow.textContent = '▲';
  }
  renderTasks();
  showReminderToast('Tasks sorted by ' + (_taskSortMode === 'due' ? 'due date' : 'priority'));
}

function renderTasks() {
  const tbody = document.getElementById('tbodyTasks');
  if (!tbody) return;
  tbody.innerHTML = '';
  const countEl = document.getElementById('countTasks');
  const deleteBtn = document.getElementById('btnDeleteCompleted');
  const active = _tasks.filter(t => !t.done);
  const completed = _tasks.filter(t => t.done);
  if (countEl) countEl.textContent = active.length;
  if (deleteBtn) deleteBtn.disabled = completed.length === 0;

  if (!_tasks.length) {
    tbody.innerHTML = '<tr class="empty-state-row"><td colspan="10">No tasks yet. Click + Add Task to create one.</td></tr>';
    return;
  }

  const sorted = sortTasks(_tasks);
  sorted.forEach(t => {
    const swCls = getTaskSwatchClass(t);
    const dueCls = getTaskDueClass(t);
    const dueText = getTaskDueText(t);
    const recurCls = getRecurPillClass(t);
    const recurLabel = getRecurLabel(t);
    const pR = getReminders('task_' + t.id);
    const hasR = pR.length > 0;
    const countDot = hasR ? '<span class="reminder-count-dot">' + pR.length + '</span>' : '';
    const row = document.createElement('tr');
    row.className = 'prospect-row' + (t.done ? ' task-done-row' : '');
    row.onclick = function() { toggleExpanded(row); };
    row.innerHTML =
      '<td style="text-align:center;" onclick="event.stopPropagation()">' +
        '<div class="task-checkbox' + (t.done ? ' checked' : '') + '" onclick="toggleTaskDone(\'' + t.id + '\')"></div>' +
      '</td>' +
      '<td style="padding:0 6px;"><div class="swatch ' + swCls + '"></div></td>' +
      '<td><span class="task-name-text" style="font-weight:600;">' + esc(t.name) + '</span></td>' +
      '<td>' + (t.done ? '<span style="color:var(--text-secondary);font-size:13px;">' + formatHoldDate(t.due) + '</span>' : '<span class="task-due-pill ' + dueCls + '">' + dueText + '</span>') + '</td>' +
      '<td>' + (t.time ? '<span class="task-time-badge"><span class="clock-icon">🕑</span> ' + fmtTimeDisplay(t.time) + '</span>' : '<span class="task-no-time">—</span>') + '</td>' +
      '<td><span class="recur-pill ' + recurCls + '">' + recurLabel + '</span></td>' +
      '<td><div class="notes-cell"><div class="notes-truncated">' + esc(t.notes || '') + '</div></div></td>' +
      '<td onclick="event.stopPropagation()">' +
        '<div class="priority-dots">' +
          '<div class="priority-dot ' + (t.priority >= 1 ? 'active-1' : '') + '" onclick="setTaskPriority(\'' + t.id + '\',1)"></div>' +
          '<div class="priority-dot ' + (t.priority >= 2 ? 'active-2' : '') + '" onclick="setTaskPriority(\'' + t.id + '\',2)"></div>' +
          '<div class="priority-dot ' + (t.priority >= 3 ? 'active-3' : '') + '" onclick="setTaskPriority(\'' + t.id + '\',3)"></div>' +
        '</div>' +
      '</td>' +
      '<td onclick="event.stopPropagation()"><button class="reminder-btn ' + (hasR ? 'has-reminder' : '') + '" onclick="openTimePicker(\'task_' + t.id + '\',\'task\')" title="' + (hasR ? pR.length + ' reminder(s)' : 'Set reminder') + '">&#x1F514;' + countDot + '</button></td>' +
      '<td onclick="event.stopPropagation()">' +
        '<div class="actions">' +
          '<button class="action-btn" onclick="editTask(event,\'' + t.id + '\')">Edit</button>' +
          '<button class="action-btn delete" onclick="deleteTask(event,\'' + t.id + '\')">Delete</button>' +
        '</div>' +
      '</td>';
    tbody.appendChild(row);
    const expRow = document.createElement('tr');
    expRow.className = 'expanded-row';
    expRow.innerHTML = '<td colspan="10"><div class="expanded-content"><h3>Notes</h3><p>' + esc(t.notes || '') + '</p></div></td>';
    tbody.appendChild(expRow);
  });
}

function setTaskPriority(id, level) {
  const t = _tasks.find(x => x.id === id);
  if (!t) return;
  t.priority = t.priority === level ? 0 : level;
  saveTasks();
  renderTasks();
}

function toggleTaskDone(id) {
  const t = _tasks.find(x => x.id === id);
  if (!t) return;
  if (!t.done) {
    t.done = true;
    t.completedDate = todayStr();
    // If recurring, auto-create next occurrence
    if (t.recurrence && t.recurrence !== 'once') {
      const next = createNextOccurrence(t);
      _tasks.push(next);
      showReminderToast('Task completed! Next occurrence created for ' + formatHoldDate(next.due));
    } else {
      showReminderToast('Task completed!');
    }
  } else {
    t.done = false;
    delete t.completedDate;
  }
  saveTasks();
  renderTasks();
  renderReminders();
}

function createNextOccurrence(task) {
  const d = new Date(task.due + 'T00:00:00Z');
  let nextDate;
  if (task.recurrence === 'daily') {
    nextDate = new Date(d);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  } else if (task.recurrence === 'weekly') {
    // Find next matching day of week
    const days = task.weeklyDays || [];
    if (days.length === 0) {
      nextDate = new Date(d);
      nextDate.setUTCDate(nextDate.getUTCDate() + 7);
    } else {
      nextDate = new Date(d);
      nextDate.setUTCDate(nextDate.getUTCDate() + 1); // start from tomorrow
      let safety = 0;
      while (!days.includes(nextDate.getUTCDay()) && safety < 8) {
        nextDate.setUTCDate(nextDate.getUTCDate() + 1);
        safety++;
      }
    }
  } else if (task.recurrence === 'monthly') {
    const targetDay = task.monthDay || d.getUTCDate();
    nextDate = new Date(d);
    nextDate.setUTCMonth(nextDate.getUTCMonth() + 1);
    // Handle months with fewer days (e.g., target 31 in a 30-day month)
    const maxDay = new Date(Date.UTC(nextDate.getUTCFullYear(), nextDate.getUTCMonth() + 1, 0)).getUTCDate();
    nextDate.setUTCDate(Math.min(targetDay, maxDay));
  }
  const dueStr = nextDate.getUTCFullYear() + '-' + String(nextDate.getUTCMonth()+1).padStart(2,'0') + '-' + String(nextDate.getUTCDate()).padStart(2,'0');
  var nextTask = {
    id: 'task_' + Date.now(),
    name: task.name,
    due: dueStr,
    recurrence: task.recurrence,
    weeklyDays: task.weeklyDays ? task.weeklyDays.slice() : [],
    monthDay: task.monthDay,
    notes: task.notes,
    priority: task.priority,
    done: false
  };
  if (task.time) nextTask.time = task.time;
  return nextTask;
}

function deleteCompletedTasks() {
  const completed = _tasks.filter(t => t.done);
  if (!completed.length) return;
  if (!confirm('Delete ' + completed.length + ' completed task' + (completed.length > 1 ? 's' : '') + '? This cannot be undone.')) return;
  // Also clean up any reminders for deleted tasks
  completed.forEach(t => {
    const remKey = 'task_' + t.id;
    if (_reminders[remKey]) { delete _reminders[remKey]; }
  });
  saveReminders();
  _tasks = _tasks.filter(t => !t.done);
  saveTasks();
  renderTasks();
  renderReminders();
  showReminderToast(completed.length + ' completed task' + (completed.length > 1 ? 's' : '') + ' deleted');
}

function deleteTask(e, id) {
  e.stopPropagation();
  if (!confirm('Delete this task?')) return;
  const remKey = 'task_' + id;
  if (_reminders[remKey]) { delete _reminders[remKey]; saveReminders(); }
  _tasks = _tasks.filter(t => t.id !== id);
  saveTasks();
  renderTasks();
  renderReminders();
}

// ── Task Modal ──
function openTaskModal() {
  _editingTaskId = null;
  document.getElementById('taskModalHeader').textContent = 'Add New Task';
  document.getElementById('taskForm').reset();
  document.getElementById('taskFormDue').value = todayStr();
  document.getElementById('taskFormTime').value = '';
  setRecurrence('once');
  _taskWeeklyDays = [];
  _taskMonthDay = 1;
  updateDayPicker();
  populateMonthDaySelect();
  document.getElementById('taskModal').classList.add('active');
}

function closeTaskModal() { document.getElementById('taskModal').classList.remove('active'); }

function editTask(e, id) {
  e.stopPropagation();
  const t = _tasks.find(x => x.id === id);
  if (!t) return;
  _editingTaskId = id;
  document.getElementById('taskModalHeader').textContent = 'Edit Task';
  document.getElementById('taskFormName').value = t.name;
  document.getElementById('taskFormDue').value = t.due;
  document.getElementById('taskFormTime').value = t.time || '';
  document.getElementById('taskFormNotes').value = t.notes || '';
  _taskWeeklyDays = t.weeklyDays ? t.weeklyDays.slice() : [];
  _taskMonthDay = t.monthDay || 1;
  populateMonthDaySelect();
  document.getElementById('monthDaySelect').value = _taskMonthDay;
  setRecurrence(t.recurrence || 'once');
  updateDayPicker();
  document.getElementById('taskModal').classList.add('active');
}

function setRecurrence(type) {
  _taskRecurrence = type;
  document.querySelectorAll('.recur-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-recur') === type);
  });
  document.getElementById('weeklyOptions').classList.toggle('visible', type === 'weekly');
  document.getElementById('monthlyOptions').classList.toggle('visible', type === 'monthly');
}

function updateDayPicker() {
  document.querySelectorAll('#dayPicker .day-btn').forEach(btn => {
    const day = parseInt(btn.getAttribute('data-day'));
    btn.classList.toggle('active', _taskWeeklyDays.includes(day));
  });
}

function populateMonthDaySelect() {
  const sel = document.getElementById('monthDaySelect');
  if (!sel) return;
  if (sel.options.length > 0) return; // already populated
  for (let i = 1; i <= 31; i++) {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = ordinal(i);
    sel.appendChild(opt);
  }
}

// Day picker click handler
document.addEventListener('click', function(e) {
  if (e.target.classList.contains('day-btn') && e.target.closest('#dayPicker')) {
    const day = parseInt(e.target.getAttribute('data-day'));
    const idx = _taskWeeklyDays.indexOf(day);
    if (idx >= 0) _taskWeeklyDays.splice(idx, 1);
    else _taskWeeklyDays.push(day);
    _taskWeeklyDays.sort();
    updateDayPicker();
  }
});

// Month day select change handler
document.addEventListener('change', function(e) {
  if (e.target.id === 'monthDaySelect') {
    _taskMonthDay = parseInt(e.target.value);
  }
});

document.getElementById('taskForm').addEventListener('submit', function(e) {
  e.preventDefault();
  const name = document.getElementById('taskFormName').value.trim();
  const due = document.getElementById('taskFormDue').value;
  const time = document.getElementById('taskFormTime').value || null;
  const notes = document.getElementById('taskFormNotes').value.trim();
  if (!name || !due) return;

  const entry = {
    name: name,
    due: due,
    recurrence: _taskRecurrence,
    weeklyDays: _taskRecurrence === 'weekly' ? _taskWeeklyDays.slice() : [],
    monthDay: _taskRecurrence === 'monthly' ? _taskMonthDay : null,
    notes: notes,
    priority: 0,
    done: false
  };
  if (time) entry.time = time;

  if (_editingTaskId !== null) {
    const idx = _tasks.findIndex(x => x.id === _editingTaskId);
    if (idx >= 0) {
      entry.id = _editingTaskId;
      entry.priority = _tasks[idx].priority;
      entry.done = _tasks[idx].done;
      if (_tasks[idx].completedDate) entry.completedDate = _tasks[idx].completedDate;
      _tasks[idx] = entry;
    }
    _editingTaskId = null;
  } else {
    entry.id = 'task_' + Date.now();
    _tasks.push(entry);
  }

  saveTasks();
  renderTasks();
  closeTaskModal();
  showReminderToast('Task saved: ' + name);
});

// Modal lock: click-outside-to-close removed — use Cancel/Submit buttons

// ── Greeting ──
function setGreeting() {
  const fullName = (appSettings && appSettings.displayName) || '';
  const first = fullName.split(' ')[0] || 'there';
  const h = new Date().getHours();
  let g = 'Good evening';
  if (h < 12) g = 'Good morning';
  else if (h < 17) g = 'Good afternoon';
  const el = document.getElementById('greetingLine');
  if (el) el.textContent = g + ', ' + first + '!';
}
// ── Toast ──
function showReminderToast(msg) {
const toast = document.getElementById('reminderToast');
if (!toast) return;
document.getElementById('reminderToastText').textContent = msg;
toast.classList.add('active');
setTimeout(() => { toast.classList.remove('active'); }, 3500);
}
// ── Page Navigation ──
let _currentPage = 'pageHome';
function navigateTo(pageId) {
const pages = document.querySelectorAll('.pages-wrapper .page');
pages.forEach(p => { p.classList.remove('active'); p.classList.add('hidden-right'); });
const target = document.getElementById(pageId);
if (target) { target.classList.remove('hidden-right','hidden-left'); target.classList.add('active'); }
_currentPage = pageId;
const hint = document.getElementById('keyHint');
if (hint) hint.style.display = (pageId === 'pageHome') ? 'none' : 'block';
}
function goHome() {
navigateTo('pageHome');
clearSearch();
}
document.addEventListener('keydown', function(e) {
if (e.key === 'Escape' && _currentPage !== 'pageHome') {
  // Don’t go home if a modal is open
  var modals = ['addModal','focusModal','settingsModal','taskModal','pickerOverlay','sfHelpModal','ghHelpModal','gmailGuideModal','helpPanel'];
  for (var i = 0; i < modals.length; i++) {
    var m = document.getElementById(modals[i]);
    if (m && (m.classList.contains('active') || m.style.display === 'flex')) return;
  }
  goHome();
}
});
// ── Home Cards ──
function renderHomeCards() {
var grid = document.getElementById('cardsGrid');
if (!grid) return;
// Count reminders
var rCount = 0;
Object.keys(_reminders).forEach(function(id) { rCount += (_reminders[id] || []).length; });
_tasks.forEach(function(t) { if (!t.done && t.time && !t.notified) rCount++; });
// Count prospects by bucket
var readyList = [], upcomingList = [], archivedList = [];
prospects.forEach(function(p) {
  var days = calculateDays(p.date);
  if (days <= -90) archivedList.push(p);
  else if (days <= 0) readyList.push(p);
  else upcomingList.push(p);
});
var focusCount = dailyFocus.length;
var taskCount = _tasks.filter(function(t) { return !t.done; }).length;
// Build cards
var cards = [
  { id: 'pageReminders', cls: 'card-reminders', title: 'Active Reminders', count: rCount, sub: 'Call reminders & task auto-reminders', color: '#fb923c', items: [] },
  { id: 'pageHotLeads', cls: 'card-hotleads', title: 'Hot Leads', count: focusCount, sub: 'Gmail leads scored by intent', color: '#d946ef', items: dailyFocus.slice(0,3).map(function(l) { return { name: l.name || l.email, meta: l.company || '' }; }) },
  { id: 'pageReady', cls: 'card-ready', title: 'Ready to Call', count: readyList.length, sub: 'Re-engagement date arrived', color: '#818cf8', items: readyList.slice(0,3).map(function(p) { return { name: p.contact, meta: Math.abs(calculateDays(p.date)) + 'd ago' }; }) },
  { id: 'pageTasks', cls: 'card-tasks', title: 'My Tasks', count: taskCount, sub: 'Personal to-do list', color: '#facc15', items: _tasks.filter(function(t){return !t.done;}).slice(0,3).map(function(t) { return { name: t.name, meta: t.due || '' }; }) },
  { id: 'pageUpcoming', cls: 'card-upcoming', title: 'Upcoming', count: upcomingList.length, sub: 'Future re-engagement dates', color: '#22d3ee', items: upcomingList.slice(0,3).map(function(p) { return { name: p.contact, meta: 'in ' + calculateDays(p.date) + 'd' }; }) },
  { id: 'pageArchived', cls: 'card-archived', title: 'Archived', count: archivedList.length, sub: 'Prospects older than 90 days', color: '#94a3b8', items: [] }
];
var h = '';
cards.forEach(function(c) {
  h += '<div class="section-card ' + c.cls + '" onclick="navigateTo(\'' + c.id + '\')">'; 
  h += '<div class="card-top"><div class="card-title">' + esc(c.title) + '</div><span class="card-arrow">→</span></div>';
  h += '<div style="display:flex;align-items:baseline;gap:12px;"><span class="card-count">' + c.count + '</span><span class="card-subtitle">' + esc(c.sub) + '</span></div>';
  if (c.items.length > 0) {
    h += '<div class="card-preview">';
    c.items.forEach(function(it) {
      h += '<div class="preview-item"><span class="preview-dot" style="background:' + c.color + ';"></span><span class="preview-name">' + esc(it.name) + '</span><span class="preview-meta">' + esc(it.meta) + '</span></div>';
    });
    h += '</div>';
  }
  h += '</div>';
});
grid.innerHTML = h;
// Update detail page counts
var dc;
dc = document.getElementById('detailCountReminders'); if (dc) dc.textContent = rCount;
dc = document.getElementById('detailCountHotLeads'); if (dc) dc.textContent = focusCount;
dc = document.getElementById('detailCountReady'); if (dc) dc.textContent = readyList.length;
dc = document.getElementById('detailCountTasks'); if (dc) dc.textContent = taskCount;
dc = document.getElementById('detailCountUpcoming'); if (dc) dc.textContent = upcomingList.length;
dc = document.getElementById('detailCountArchived'); if (dc) dc.textContent = archivedList.length;
}
// ── Legend Toggle ──
function toggleLegend() {
var toggle = document.getElementById('legendToggle');
var panel = document.getElementById('legendPanel');
if (!toggle || !panel) return;
toggle.classList.toggle('open');
panel.classList.toggle('open');
}
// ── Search ──
let _searchTimer = null;
function clearSearch() {
var input = document.getElementById('searchInput');
var dropdown = document.getElementById('searchDropdown');
var clearBtn = document.getElementById('searchClear');
if (input) input.value = '';
if (dropdown) { dropdown.innerHTML = ''; dropdown.classList.remove('open'); }
if (clearBtn) clearBtn.classList.remove('visible');
}
function runSearch(query) {
var dropdown = document.getElementById('searchDropdown');
if (!dropdown) return;
if (!query || query.length < 1) { dropdown.innerHTML = ''; dropdown.classList.remove('open'); return; }
var q = query.toLowerCase();
var results = [];
// Search prospects
prospects.forEach(function(p) {
  var text = ((p.contact || '') + ' ' + (p.email || '') + ' ' + (p.notes || '')).toLowerCase();
  if (text.includes(q)) {
    var days = calculateDays(p.date);
    var section = days <= -90 ? 'archived' : days <= 0 ? 'ready' : 'upcoming';
    var labels = { ready: 'Ready to Call', upcoming: 'Upcoming', archived: 'Archived' };
    var pages = { ready: 'pageReady', upcoming: 'pageUpcoming', archived: 'pageArchived' };
    results.push({ name: p.contact || p.email, detail: (p.email || '') + (p.notes ? ' · ' + p.notes : ''), section: labels[section], badge: 'search-badge-' + section, page: pages[section], swatch: section === 'ready' ? '#818cf8' : section === 'upcoming' ? '#22d3ee' : '#94a3b8' });
  }
});
// Search hot leads
dailyFocus.forEach(function(l) {
  var text = ((l.name || '') + ' ' + (l.email || '') + ' ' + (l.company || '') + ' ' + (l.notes || '')).toLowerCase();
  if (text.includes(q)) {
    results.push({ name: l.name || l.email, detail: (l.company || '') + (l.email ? ' · ' + l.email : ''), section: 'Hot Leads', badge: 'search-badge-hotleads', page: 'pageHotLeads', swatch: '#d946ef' });
  }
});
// Search tasks
_tasks.forEach(function(t) {
  var text = ((t.name || '') + ' ' + (t.notes || '')).toLowerCase();
  if (text.includes(q)) {
    results.push({ name: t.name, detail: (t.due || 'No date') + (t.notes ? ' · ' + t.notes : ''), section: 'My Tasks', badge: 'search-badge-tasks', page: 'pageTasks', swatch: '#facc15' });
  }
});
if (results.length === 0) {
  dropdown.innerHTML = '<div class="search-empty">No matches found</div>';
  dropdown.classList.add('open');
  return;
}
// Highlight matches
var regex = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
var h = '<div class="search-count">' + results.length + ' result' + (results.length !== 1 ? 's' : '') + '</div>';
results.slice(0, 20).forEach(function(r) {
  h += '<div class="search-result-item" onclick="navigateTo(\'' + r.page + '\');clearSearch();">';
  h += '<div class="search-result-swatch" style="background:' + r.swatch + ';"></div>';
  h += '<div class="search-result-info"><div class="search-result-name">' + esc(r.name).replace(regex, '<mark>$1</mark>') + '</div><div class="search-result-detail">' + esc(r.detail) + '</div></div>';
  h += '<span class="search-result-badge ' + r.badge + '">' + esc(r.section) + '</span>';
  h += '</div>';
});
if (results.length > 20) h += '<div class="search-empty">' + (results.length - 20) + ' more results…</div>';
dropdown.innerHTML = h;
dropdown.classList.add('open');
}
(function() {
var input = document.getElementById('searchInput');
var clearBtn = document.getElementById('searchClear');
if (input) {
  input.addEventListener('input', function() {
    var val = input.value.trim();
    if (clearBtn) clearBtn.classList.toggle('visible', val.length > 0);
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(function() { runSearch(val); }, 150);
  });
}
// Close dropdown on outside click
document.addEventListener('click', function(e) {
  var wrapper = document.querySelector('.search-wrapper');
  var dropdown = document.getElementById('searchDropdown');
  if (wrapper && dropdown && !wrapper.contains(e.target)) {
    dropdown.classList.remove('open');
  }
});
})();
(async () => {
if (!_token || !_owner) {
showSetupScreen();
// Auto-open GitHub guide for first-time users (no stored credentials)
openGHHelp();
return;
}
try {
await loadAll();
hideSetupScreen();
renderAll();
setGreeting();
updateNotifBanner();
} catch (err) {
showSetupScreen();
document.getElementById('setupOwner').value = _owner;
const errEl = document.getElementById('setupError');
errEl.textContent = '⚠ Session expired or token invalid. Please reconnect.';
errEl.classList.add('visible');
}
})();
