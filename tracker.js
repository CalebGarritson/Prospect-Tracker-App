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
throw new Error(`Write failed for ${path}: ${txt}`);
}
const rj = await res.json();
return rj.content.sha;
}
window.ghRead = ghRead;
window.ghWrite = ghWrite;
function showMsg(msg, dur = 3000) {
const m = document.getElementById('msgBox');
m.textContent = msg;
m.style.visibility = 'visible';
setTimeout(() => { m.style.visibility = 'hidden'; }, dur);
}
window.showMsg = showMsg;
let _setupDone = false;
async function setup() {
if (_setupDone) return;
if (!_token || !_owner) {
showLoginScreen();
return;
}
try {
if (!(await checkRepoExists())) {
if (!confirm('Repo does not exist. Create it now?')) return;
await bootstrapRepo(msg => showMsg(msg, 5000));
}
// Load the three files from GitHub
const [p, f, s] = await Promise.all([
ghRead(PATHS.prospects),
ghRead(PATHS.focus),
ghRead(PATHS.settings)
]);
prospects = p.data;    _pSHA = p.sha;
dailyFocus = f.data;   _fSHA = f.sha;
appSettings = s.data;  _sSHA = s.sha;
if (!appSettings) appSettings = {};
// Initialize reminders from localStorage
render();
updateNotifBanner();
renderReminders();
_setupDone = true;
document.getElementById('loginContainer').style.display = 'none';
document.getElementById('mainApp').style.display = 'block';
// Handle login form inputs
document.getElementById('token').addEventListener('change', () => {
const token = document.getElementById('token').value.trim();
if (token) localStorage.setItem('pt_token', token);
});
document.getElementById('owner').addEventListener('change', () => {
const owner = document.getElementById('owner').value.trim();
if (owner) localStorage.setItem('pt_owner', owner);
});
} catch (e) {
console.error(e);
showMsg('Error: ' + e.message, 6000);
}
}
window.onload = () => {
_token = localStorage.getItem('pt_token') || '';
_owner = localStorage.getItem('pt_owner') || '';
if (_token && _owner) setup();
else showLoginScreen();
};
function showLoginScreen() {
const lo = document.getElementById('loginContainer');
if (!lo) return;
lo.style.display = 'flex';
const t = localStorage.getItem('pt_token') || '';
const o = localStorage.getItem('pt_owner') || '';
if (t) document.getElementById('token').value = t;
if (o) document.getElementById('owner').value = o;
const btn = document.getElementById('loginBtn');
if (btn) {
btn.addEventListener('click', async () => {
const token = document.getElementById('token').value.trim();
const owner = document.getElementById('owner').value.trim();
const sfid = document.getElementById('sfid').value.trim();
if (!token || !owner) {
alert('Please enter GitHub token and username.');
return;
}
localStorage.setItem('pt_token', token);
localStorage.setItem('pt_owner', owner);
_token = token;
_owner = owner;
if (sfid) {
appSettings.salesforceId = sfid;
await doSaveSettings();
}
setup();
});
}
}
window.showLoginScreen = showLoginScreen;
function render() {
const sort = (list) => list.sort((a, b) => {
const aD = calculateDays(a.callDate || a.createdDate);
const bD = calculateDays(b.callDate || b.createdDate);
return aD - bD;
});
const p = sort([...prospects]);
const table = ['readyCall', 'upcoming', 'archived'].map(id => [id, []]);
p.forEach(x => {
const kls = getDaysClass(calculateDays(x.callDate || x.createdDate));
const [, list] = table.find(t => t[0] === kls) || table[0];
list.push(x);
});
table.forEach(([tableId, list]) => {
const tb = document.querySelector(`#${tableId} tbody`);
if (!tb) return;
tb.innerHTML = '';
list.forEach((p, idx) => {
const days = calculateDays(p.callDate || p.createdDate);
const cell = `
<tr data-prospect-id="${p.id}">
<td>${esc(p.prospectName)}</td>
<td>${esc(p.company)}</td>
<td>${p.callDate ? formatDate(p.callDate) : '—'}</td>
<td>${p.status}</td>
<td class="action-cell">
<button class="icon-btn" title="Edit" onclick="editProspect(${p.id})">&#x2708;</button>
<button class="icon-btn" title="Remind" onclick="openTimePicker(${p.id}, 'manual')">&#x1F514;</button>
<button class="icon-btn del" title="Delete" onclick="deleteProspect(${p.id})">&#x1F5D1;</button>
</td>
</tr>
`;
tb.innerHTML += cell;
});
const badge = document.querySelector(`#${tableId} .count-badge`);
if (badge) badge.textContent = list.length;
});
}
window.render = render;
function editProspect(id) {
const p = prospects.find(x => x.id === id);
if (!p) return;
document.getElementById('formProspectName').value = p.prospectName || '';
document.getElementById('formCompany').value = p.company || '';
document.getElementById('formEmail').value = p.email || '';
document.getElementById('formCallDate').value = p.callDate || '';
document.getElementById('formStatus').value = p.status || 'open';
document.getElementById('formNotes').value = p.notes || '';
_editingProspectId = id;
document.getElementById('modalTitle').textContent = 'Edit Prospect';
document.getElementById('proModal').classList.add('active');
}
function newProspect() {
document.getElementById('formProspectName').value = '';
document.getElementById('formCompany').value = '';
document.getElementById('formEmail').value = '';
document.getElementById('formCallDate').value = '';
document.getElementById('formStatus').value = 'open';
document.getElementById('formNotes').value = '';
_editingProspectId = null;
document.getElementById('modalTitle').textContent = 'Add Prospect';
document.getElementById('proModal').classList.add('active');
}
function closeProModal() { document.getElementById('proModal').classList.remove('active'); }
function deleteProspect(id) {
if (!confirm('Delete this prospect?')) return;
prospects = prospects.filter(x => x.id !== id);
render();
scheduleSave();
}
document.getElementById('form').addEventListener('submit', (e) => {
e.preventDefault();
const p = {
prospectName: document.getElementById('formProspectName').value.trim(),
company: document.getElementById('formCompany').value.trim(),
email: document.getElementById('formEmail').value.trim(),
callDate: document.getElementById('formCallDate').value,
status: document.getElementById('formStatus').value,
notes: document.getElementById('formNotes').value.trim()
};
if (_editingProspectId) {
const idx = prospects.findIndex(x => x.id === _editingProspectId);
if (idx >= 0) {
prospects[idx] = { ...prospects[idx], ...p };
_editingProspectId = null;
}
} else {
p.id = Math.max(...prospects.map(x => x.id || 0), 0) + 1;
prospects.push(p);
}
render();
scheduleSave();
closeProModal();
});
function scheduleSave() { if (_saveTimer) clearTimeout(_saveTimer); _saveTimer = setTimeout(doSave, 500); }
async function doSave() {
if (!_setupDone) return;
try {
_pSHA = await ghWrite(PATHS.prospects, prospects, _pSHA, 'Update prospects');
showMsg('Prospect saved');
} catch (e) {
console.error(e);
showMsg('Save error: ' + e.message);
}
}
window.doSave = doSave;
function scheduleFocusSave() { if (_focusSaveT) clearTimeout(_focusSaveT); _focusSaveT = setTimeout(doSaveFocus, 500); }
async function doSaveFocus() {
if (!_setupDone) return;
try {
_fSHA = await ghWrite(PATHS.focus, dailyFocus, _fSHA, 'Update daily focus leads');
showMsg('Focus lead saved');
} catch (e) {
console.error(e);
showMsg('Save error: ' + e.message);
}
}
async function doSaveSettings() {
if (!_setupDone) return;
try {
_sSHA = await ghWrite(PATHS.settings, appSettings, _sSHA, 'Update settings');
showMsg('Settings saved');
} catch (e) {
console.error(e);
showMsg('Save error: ' + e.message);
}
}
document.getElementById('proModal').addEventListener('click', e => { if (e.target.id === 'proModal') closeProModal(); });
function renderFocus() {
const tb = document.querySelector('#focusTable tbody');
if (!tb) return;
tb.innerHTML = '';
dailyFocus.sort((a, b) => (b.priority || 0) - (a.priority || 0)).forEach((f, idx) => {
const days = f.receivedDate ? calculateDays(f.receivedDate) : null;
const holdMsg = f.holdUntil ? ` (hold until ${formatHoldDate(f.holdUntil)})` : '';
const cell = `
<tr data-focus-id="${f.id}">
<td>${esc(f.name)}</td>
<td>${esc(f.company)}</td>
<td>${f.email ? '<a href="mailto:' + esc(f.email) + '">' + esc(f.email) + '</a>' : '—'}</td>
<td>${f.receivedDate ? formatDate(f.receivedDate) : '—'}</td>
<td><span class="badge ${f.status === 'hold' ? 'hold' : f.status === 'completed' ? 'completed' : 'open'} ">${f.status}${holdMsg}</span></td>
<td>${f.notes ? esc(f.notes.slice(0, 50)) + (f.notes.length > 50 ? '…' : '') : '—'}</td>
<td class="action-cell">
<button class="icon-btn" title="Edit" onclick="editFocusProspect(event, '${f.id}')">&#x2708;</button>
<button class="icon-btn" title="Remind" onclick="openTimePicker('${f.id}', 'focus')">&#x1F514;</button>
<button class="icon-btn del" title="Delete" onclick="deleteFocusProspect(event, '${f.id}')">&#x1F5D1;</button>
</td>
</tr>
`;
tb.innerHTML += cell;
});
const badge = document.querySelector('#focusTable .count-badge');
if (badge) badge.textContent = dailyFocus.length;
}
window.renderFocus = renderFocus;
let _editingFocusId = null;
function editFocusProspect(e, id) {
e.stopPropagation();
const f = dailyFocus.find(x => x.id === id);
if (!f) return;
_editingFocusId = id;
document.getElementById('focusFormName').value           = f.name || '';
document.getElementById('focusFormCompany').value       = f.company || '';
document.getElementById('focusFormEmail').value         = f.email || '';
document.getElementById('focusFormReceivedDate').value = f.receivedDate || '';
document.getElementById('focusFormStatus').value       = f.status;
document.getElementById('focusFormNotes').value        = f.notes || '';
document.getElementById('focusFormHoldUntil').value    = f.holdUntil || '';
toggleHoldUntil();
document.getElementById('focusModal').classList.add('active');
}
function deleteFocusProspect(e, id) {
e.stopPropagation();
if (!confirm('Remove this lead from Daily Focus?')) return;
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
document.getElementById('focusModal').addEventListener('click', e => { if (e.target.id === 'focusModal') closeFocusModal(); });
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
}
document.getElementById('settingsModal').addEventListener('click', e => { if (e.target.id === 'settingsModal') closeSettings(); });
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
let c = 0; Object.keys(_reminders).forEach(k => { c += _reminders[k].length; }); return c;
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
function renderReminders() {
const sec = document.getElementById('remindersSection');
if (!sec) return;
const all = [];
Object.keys(_reminders).forEach(id => {
_reminders[id].forEach(r => {
all.push({ prospectId: id, ...r });
});
});
all.sort((a, b) => {
const dateA = new Date(a.date + ' ' + a.time);
const dateB = new Date(b.date + ' ' + b.time);
return dateA - dateB;
});
let html = all.length === 0 ? '<p style="color: #999; padding: 10px;">No reminders set</p>' : '';
all.forEach((r, idx) => {
const name = prospects.find(p => p.id === parseInt(r.prospectId))?.prospectName ||
dailyFocus.find(f => f.id === r.prospectId)?.name || 'Unknown';
html += `
<div style="padding: 8px 12px; border-left: 3px solid #e879f9; display: flex; justify-content: space-between; align-items: center;">
<span>${fmtDateShort(r.date)} at ${fmtTimeDisplay(r.time)} · <strong>${esc(name)}</strong></span>
<button class="icon-btn small" title="Remove" onclick="removeReminder('${esc(r.prospectId)}', ${all.indexOf(r)})" style="font-size: 12px; padding: 4px 8px;">&#x2715;</button>
</div>
`;
});
sec.innerHTML = html;
}
window.renderReminders = renderReminders;
function removeReminder(prospectId, index) {
if (!_reminders[prospectId]) return;
const remList = _reminders[prospectId];
if (index >= 0 && index < remList.length) {
remList.splice(index, 1);
if (remList.length === 0) delete _reminders[prospectId];
saveReminders();
renderReminders();
showMsg('Reminder removed');
}
}
window.removeReminder = removeReminder;
function openTimePicker(id, type) {
_pickerProspectId = id;
_pickerProspectType = type;
const minDate = new Date();
const maxDate = new Date(minDate);
maxDate.setDate(maxDate.getDate() + 30);
const pickerMin = minDate.toISOString().split('T')[0];
const pickerMax = maxDate.toISOString().split('T')[0];
document.getElementById('pickerDate').min = pickerMin;
document.getElementById('pickerDate').max = pickerMax;
document.getElementById('pickerDate').value = pickerMin;
document.getElementById('pickerTime').value = '09:00';
document.getElementById('pickerOverlay').classList.add('active');
updatePickerState();
}
window.openTimePicker = openTimePicker;
function updatePickerState() {
const date = document.getElementById('pickerDate').value;
const time = document.getElementById('pickerTime').value;
const pickerSummary = document.getElementById('pickerSummary');
if (date && time) {
const d = new Date(date + 'T' + time);
const fmt = d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
pickerSummary.textContent = fmt;
}
}
window.updatePickerState = updatePickerState;
function confirmReminder() {
const date = document.getElementById('pickerDate').value;
const time = document.getElementById('pickerTime').value;
if (!date || !time) { showMsg('Pick a date and time'); return; }
if (!_reminders[_pickerProspectId]) _reminders[_pickerProspectId] = [];
const existing = _reminders[_pickerProspectId];
if (existing.length >= MAX_REMINDERS) {
showMsg(`Max ${MAX_REMINDERS} reminders per prospect`);
return;
}
existing.push({ date, time });
saveReminders();
renderReminders();
showMsg('Reminder added');
document.getElementById('pickerOverlay').classList.remove('active');
updateNotifBanner();
}
window.confirmReminder = confirmReminder;
function closePicker() {
document.getElementById('pickerOverlay').classList.remove('active');
}
window.closePicker = closePicker;
function updateNotifBanner() {
const total = getTotalReminderCount();
const banner = document.getElementById('notifBanner');
if (!banner) return;
if (total === 0) {
banner.style.display = 'none';
return;
}
banner.textContent = `🔔 ${total} reminder${total !== 1 ? 's' : ''} set`;
banner.style.display = 'block';
}
window.updateNotifBanner = updateNotifBanner;
function checkReminders() {
const now = new Date();
Object.keys(_reminders).forEach(prospectId => {
_reminders[prospectId].forEach((r, idx) => {
const reminderTime = new Date(r.date + 'T' + r.time);
if (now >= reminderTime && !r._notified) {
const name = prospects.find(p => p.id === parseInt(prospectId))?.prospectName ||
dailyFocus.find(f => f.id === prospectId)?.name || 'Unknown';
showReminderToast(`Time to call ${name}`);
if (Notification.permission === 'granted') {
new Notification('Calebrate Reminder', {
body: `Time to call: ${name}`,
tag: prospectId,
icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="85">&#x1F514;</text></svg>',
requireInteraction: true
});
}
r._notified = true;
saveReminders();
}
});
}
window.checkReminders = checkReminders;
if (Notification && Notification.permission === 'default') {
const askNotif = document.getElementById('askNotif');
if (askNotif) {
askNotif.addEventListener('click', () => {
Notification.requestPermission().then(perm => {
if (perm === 'granted') {
document.getElementById('notifBanner').style.display = 'none';
}
});
});
}
}
function showReminderToast(msg) {
const toast = document.getElementById('reminderToast');
if (!toast) return;
toast.textContent = msg;
toast.classList.add('show');
setTimeout(() => toast.classList.remove('show'), 4000);
}
window.showReminderToast = showReminderToast;
setInterval(checkReminders, 15000);
(function checkAuth() {
const token = localStorage.getItem('pt_token');
const owner = localStorage.getItem('pt_owner');
if (!token || !owner) return;
setInterval(async () => {
try {
const res = await fetch('https://api.github.com/user', {
headers: { 'Authorization': `token ${token}` }
});
if (!res.ok) throw new Error('Auth failed');
} catch (e) {
const errEl = document.getElementById('loginContainer');
if (errEl) {
errrEl.style.display = 'flex';
document.getElementById('mainApp').style.display = 'none';
errrEl.querySelector('.error-msg').textContent = '⚠ Session expired or token invalid. Please reconnect.';
errrEl.classList.add('visible');
}
}
}, 3600000);
})();
