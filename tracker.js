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
if (!str) return '\u2014';
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