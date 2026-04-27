// ═══════════════════════════════════════════════════════════════════════════════
// CALEBRATE — Code.gs
// Created by:  Caleb Garritson
// Email:       caleb.garritson@gusto.com
// GitHub:      github.com/CalebGarritson/Prospect-tracker
// Created:     April 2026
//
// Calebrate — Gmail → GitHub Automation
//
// This script scans Gmail for prospect leads and writes new ones directly
// to the Prospect Tracker repo on GitHub. The tracker app reads from
// GitHub, so leads appear automatically the next time you open it.
//
// SCAN MODES:
//   Ramp-up (first 14 days): Scans full inbox, up to 1000 threads/day
//   Daily (after 14 days):   Looks back 2 days, up to 30 threads
//
// FILTERING:
//   Quote stripping:    ALL keywords are checked against fresh reply text only (quoted
//                       thread is stripped out so your own outreach templates don't trigger)
//   Blocked senders:    Configurable list with wildcard patterns (e.g. *@myworkday.com)
//   Negative keywords:  tax form, password reset, etc. — auto-skip even if lead keyword matches
//   Body-only keywords: Only match against fresh body (not subject line)
//   Duplicate check:    Checks both email address AND contact name to prevent repeats
//
// SETUP:
//   1. Open this script in Apps Script
//   2. Click the "Calebrate" menu at the top → "Initial Setup"
//   3. Enter your GitHub username and token in the popup
//   4. Click "Save & Connect" — done!
//
// GITHUB TARGET:
//   Repo  : Prospect-tracker (each user's own private repo)
//   File  : data/focus.json
// ═══════════════════════════════════════════════════════════════════════════════

const GITHUB_REPO   = 'Prospect-tracker';
const GITHUB_BRANCH = 'main';
const FOCUS_PATH    = 'data/focus.json';
const SETTINGS_PATH = 'data/settings.json';

// Gmail search queries
// Ramp-up (first 14 days) scans full inbox; daily mode looks back 2 days
const GMAIL_SEARCH_DAILY   = 'newer_than:2d in:inbox';
const GMAIL_SEARCH_INITIAL = 'in:inbox';   // no time limit — scans everything

// Keywords that flag an email as a potential lead (checked against subject + body)
// Grouped by buying intent — tier is stored with each lead for scoring in the tracker
const HIGH_INTENT_KEYWORDS = ['demo', 'pricing', 'switching', 'quote', 'interested'];
const MED_INTENT_KEYWORDS  = ['payroll', 'run payroll', 'payroll provider', 'gusto', 'benefits', 'hr solution', 'onboarding', 'referral'];
const LOW_INTENT_KEYWORDS  = ['employees', 'small business', 'direct deposit', 'contractors', 'hiring'];
const LEAD_KEYWORDS = HIGH_INTENT_KEYWORDS.concat(MED_INTENT_KEYWORDS).concat(LOW_INTENT_KEYWORDS);

// Body-only keywords — only checked against the FRESH part of a prospect's reply
// (the text they typed, not the quoted thread below). This prevents matching on
// your own outreach templates that appear in the quoted portion of replies.
const BODY_ONLY_KEYWORDS = [
  'gift card'
];

// Negative keywords — if ANY of these appear in the fresh reply text, skip the email
// even if it matches a lead keyword. Catches rejections, auto-replies, internal systems, etc.
//
// NOTE: "w-2", "w2", "1099", and "unsubscribe" were intentionally removed because
// real prospects use those terms (e.g. "18 w2 employees") and Caleb's own email
// signature contains "unsubscribe" which appears in every quoted reply.
//
// REJECTION PHRASES were added based on analysis of 23 real rejection emails.
// These catch prospects who reply to say they're not interested, already have a
// provider, left the company, etc.
const NEGATIVE_KEYWORDS = [
  // ── System / automated messages ──
  'tax form', 'password reset',
  'out of office', 'auto-reply', 'autoreply', 'delivery failed',
  'delivery status', 'returned mail', 'verify your email',
  'confirm your account', 'reset your password', 'invitation to edit',
  'do not reply', 'away from my emails', 'delay in responses',
  // ── Rejection / not interested phrases ──
  'no longer interested', 'not interested', 'no interest',
  'not at this time', 'not proceeding',
  'go in a different direction', 'went in a different direction',
  'going in a different direction', 'decided to go in a direction',
  'not in need of your services', 'not in need of',
  'stop calling', 'do not call', 'remove me', 'remove us',
  'place me on', 'take me off',
  // ── Already has a provider / already a customer ──
  'found a local', 'went with another', 'go with instead',
  'going to go with instead', 'happy with our current',
  'ok with our current', 'okay with our current',
  'already signed up', 'already a gusto customer',
  'already a customer', 'already use gusto', 'already using gusto',
  'no longer a priority',
  // ── Left the company ──
  'no longer with', 'i am no longer with',
  // ── Spam complaints ──
  'stop sending', 'spam email', 'spam emails'
];

// Blocked senders — emails from these addresses or patterns are always skipped.
// Supports wildcards: "postmaster@*" blocks any postmaster, "*@myworkday.com"
// blocks any sender from myworkday.com.
const BLOCKED_SENDERS = [
  'postmaster@*',
  '*@myworkday.com',
  'mailer-daemon@*',
  '*@mail.notion.so'       // Internal Notion notifications (subject contains "Gusto" = company workspace name)
];

// ── CUSTOM MENU ───────────────────────────────────────────────────────────────────
// Shows a "Calebrate" menu when the script editor is opened.

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Calebrate')
    .addItem('Initial Setup', 'showSetupDialog')
    .addSeparator()
    .addItem('Run Gmail Scan Now', 'checkGmailForLeads')
    .addItem('Test GitHub Connection', 'testGitHubConnection')
    .addToUi();
}

// Also works if opened directly in Apps Script (not from a spreadsheet)
function onOpenScript() {
  onOpen();
}

// ── SETUP DIALOG ──────────────────────────────────────────────────────────────────
// One-click setup: enter GitHub username + token → saves properties, creates
// trigger, tests connection, all in one step.

function showSetupDialog() {
  const props = PropertiesService.getScriptProperties();
  const existingOwner = props.getProperty('GITHUB_OWNER') || '';
  const hasToken = !!props.getProperty('GITHUB_TOKEN');

  const html = HtmlService.createHtmlOutput(`
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; background: #f8f9fa; color: #1a1a2e; }
      h2 { font-size: 18px; font-weight: 700; color: #1a1a2e; margin-bottom: 4px; }
      .subtitle { font-size: 13px; color: #6b7280; margin-bottom: 20px; line-height: 1.5; }
      .field { margin-bottom: 16px; }
      .field label { display: block; font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 5px; text-transform: uppercase; letter-spacing: .5px; }
      .field input { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; outline: none; transition: border-color .2s; }
      .field input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.1); }
      .field .hint { font-size: 11px; color: #9ca3af; margin-top: 4px; }
      .warning { background: #fef3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 10px 14px; font-size: 12px; color: #856404; margin-bottom: 16px; line-height: 1.5; }
      .status { display: none; padding: 12px; border-radius: 8px; font-size: 13px; margin-bottom: 12px; line-height: 1.5; }
      .status.success { display: block; background: #d1fae5; border: 1px solid #34d399; color: #065f46; }
      .status.error { display: block; background: #fee2e2; border: 1px solid #f87171; color: #991b1b; }
      .status.loading { display: block; background: #dbeafe; border: 1px solid #60a5fa; color: #1e40af; }
      .btn { width: 100%; padding: 12px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all .2s; }
      .btn-primary { background: linear-gradient(135deg, #3b82f6, #60a5fa); color: white; }
      .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(59,130,246,.3); }
      .btn-primary:disabled { opacity: .5; cursor: default; transform: none; box-shadow: none; }
      .existing { background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 10px 14px; font-size: 12px; color: #166534; margin-bottom: 16px; }
    </style>

    <h2>🐙 Calebrate Gmail Scanner Setup</h2>
    <p class="subtitle">Connect your GitHub repo so this script can automatically scan your Gmail and add leads to your Prospect Tracker.</p>

    ${existingOwner ? '<div class="existing">✅ Already configured for <strong>' + existingOwner + '</strong>. Re-enter to update.</div>' : ''}

    <div class="field">
      <label>GitHub Username</label>
      <input type="text" id="owner" placeholder="e.g. CalebGarritson" value="${existingOwner}">
      <div class="hint">The same username you used in the Prospect Tracker setup screen.</div>
    </div>

    <div class="field">
      <label>Personal Access Token</label>
      <input type="password" id="token" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx">
      <div class="hint">${hasToken ? '🔒 A token is already saved. Leave blank to keep it, or paste a new one to replace it.' : 'The token you created during tracker setup (starts with ghp_).'}</div>
    </div>

    <div class="warning">
      ⚠️ <strong>Important:</strong> Make sure you've already completed the Prospect Tracker setup first (the web app). This script needs your GitHub repo to already exist with data files in it.
    </div>

    <div class="status" id="status"></div>

    <button class="btn btn-primary" id="saveBtn" onclick="doSetup()">Save & Connect</button>

    <script>
      function doSetup() {
        var owner = document.getElementById('owner').value.trim();
        var token = document.getElementById('token').value.trim();
        var btn = document.getElementById('saveBtn');
        var status = document.getElementById('status');

        if (!owner) { showStatus('error', '❌ Please enter your GitHub username.'); return; }

        btn.disabled = true;
        btn.textContent = 'Connecting...';
        showStatus('loading', '⏳ Saving credentials, testing connection, and creating trigger...');

        google.script.run
          .withSuccessHandler(function(result) {
            btn.disabled = false;
            btn.textContent = 'Save & Connect';
            if (result.success) {
              showStatus('success', '✅ ' + result.message);
            } else {
              showStatus('error', '❌ ' + result.message);
            }
          })
          .withFailureHandler(function(err) {
            btn.disabled = false;
            btn.textContent = 'Save & Connect';
            showStatus('error', '❌ Error: ' + err.message);
          })
          .runInitialSetup(owner, token);
      }

      function showStatus(type, msg) {
        var el = document.getElementById('status');
        el.className = 'status ' + type;
        el.innerHTML = msg;
      }
    </script>
  `)
  .setWidth(420)
  .setHeight(520);

  // Try spreadsheet UI first, fall back to generic
  try {
    SpreadsheetApp.getUi().showModalDialog(html, 'Calebrate Setup');
  } catch (e) {
    // Not attached to a spreadsheet — use as standalone
    var ui = HtmlService.createHtmlOutput('<p>Please run "Initial Setup" from the Calebrate menu in your spreadsheet, or call <code>runInitialSetup()</code> directly.</p>');
    Logger.log('Setup dialog can only be shown from a spreadsheet context. Use runInitialSetup() directly or attach to a sheet.');
  }
}

function runInitialSetup(owner, token) {
  try {
    var props = PropertiesService.getScriptProperties();

    // Save credentials
    props.setProperty('GITHUB_OWNER', owner);
    if (token) {
      props.setProperty('GITHUB_TOKEN', token);
    }

    // Verify we actually have a token now
    if (!props.getProperty('GITHUB_TOKEN')) {
      return { success: false, message: 'No token saved. Please enter your GitHub Personal Access Token.' };
    }

    // Test connection
    try {
      var result = githubRead(FOCUS_PATH);
      var entryCount = result.data.length;
    } catch (err) {
      return { success: false, message: 'GitHub connection failed: ' + err.message + '. Check your username and token.' };
    }

    // Create daily trigger (remove any existing ones first to avoid duplicates)
    var triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(function(t) {
      if (t.getHandlerFunction() === 'checkGmailForLeads') {
        ScriptApp.deleteTrigger(t);
      }
    });

    ScriptApp.newTrigger('checkGmailForLeads')
      .timeBased()
      .everyDays(1)
      .atHour(7)
      .create();

    return {
      success: true,
      message: 'Connected to <strong>' + owner + '/Prospect-tracker</strong>! Found ' + entryCount + ' existing leads. Daily Gmail scan trigger set for 7am. You\'re all set!'
    };

  } catch (err) {
    return { success: false, message: 'Setup error: ' + err.message };
  }
}

// ── STANDALONE SETUP (no spreadsheet needed) ────────────────────────────────────────
// If someone just wants to run setup from the script editor without a spreadsheet,
// they can run this function which prompts with simple input boxes.

function initialSetupSimple() {
  var owner = Browser.inputBox(
    'Calebrate Setup — Step 1 of 2',
    'Enter your GitHub username (same one you used in the Prospect Tracker):',
    Browser.Buttons.OK_CANCEL
  );
  if (owner === 'cancel' || !owner.trim()) {
    Logger.log('Setup cancelled by user.');
    return;
  }

  var token = Browser.inputBox(
    'Calebrate Setup — Step 2 of 2',
    'Paste your GitHub Personal Access Token (starts with ghp_):',
    Browser.Buttons.OK_CANCEL
  );
  if (token === 'cancel' || !token.trim()) {
    Logger.log('Setup cancelled by user.');
    return;
  }

  var result = runInitialSetup(owner.trim(), token.trim());
  if (result.success) {
    Browser.msgBox('✅ Setup Complete!', result.message.replace(/<[^>]+>/g, ''), Browser.Buttons.OK);
  } else {
    Browser.msgBox('❌ Setup Failed', result.message, Browser.Buttons.OK);
  }
}

// ── GITHUB HELPERS ─────────────────────────────────────────────────────────────────

function getGitHubOwner() {
  const owner = PropertiesService.getScriptProperties().getProperty('GITHUB_OWNER');
  if (!owner) {
    throw new Error(
      'GITHUB_OWNER not set. Run "Initial Setup" from the Calebrate menu first.'
    );
  }
  return owner;
}

function getGitHubToken() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN not set. Run "Initial Setup" from the Calebrate menu first.'
    );
  }
  return token;
}

function githubRead(path) {
  const url = 'https://api.github.com/repos/' + getGitHubOwner() + '/' + GITHUB_REPO +
              '/contents/' + path + '?ref=' + GITHUB_BRANCH;
  const res = UrlFetchApp.fetch(url, {
    headers: {
      'Authorization': 'token ' + getGitHubToken(),
      'Accept':        'application/vnd.github.v3+json'
    },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('GitHub read error ' + res.getResponseCode() + ': ' + res.getContentText());
  }
  const json    = JSON.parse(res.getContentText());
  const decoded = Utilities.newBlob(
    Utilities.base64Decode(json.content.replace(/\n/g, ''))
  ).getDataAsString();
  return { data: JSON.parse(decoded), sha: json.sha };
}

function githubWrite(path, data, sha, message) {
  const url     = 'https://api.github.com/repos/' + getGitHubOwner() + '/' + GITHUB_REPO +
                  '/contents/' + path;
  const content = Utilities.base64Encode(
    JSON.stringify(data, null, 2),
    Utilities.Charset.UTF_8
  );
  const body = {
    message: message || ('Update ' + path),
    content: content,
    branch:  GITHUB_BRANCH
  };
  if (sha) body.sha = sha;

  const res = UrlFetchApp.fetch(url, {
    method:             'put',
    headers: {
      'Authorization': 'token ' + getGitHubToken(),
      'Accept':        'application/vnd.github.v3+json',
      'Content-Type':  'application/json'
    },
    payload:            JSON.stringify(body),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200 && res.getResponseCode() !== 201) {
    throw new Error('GitHub write error ' + res.getResponseCode() + ': ' + res.getContentText());
  }
  return JSON.parse(res.getContentText()).content.sha;
}

// ── GMAIL SCAN ─────────────────────────────────────────────────────────────────────

function checkGmailForLeads() {
  Logger.log('=== Calebrate — Gmail Lead Check ===');
  Logger.log('Created by Caleb Garritson (caleb.garritson@gusto.com)');
  Logger.log('Run time: ' + new Date().toISOString());

  try {
    // ── Determine scan mode: ramp-up (first 14 days) vs. daily ──
    var settings    = {};
    var settingsSha = null;
    var isRampUp    = false;

    try {
      var settingsResult = githubRead(SETTINGS_PATH);
      settings    = settingsResult.data;
      settingsSha = settingsResult.sha;
    } catch (e) {
      Logger.log('Could not read settings.json — treating as first-time ramp-up.');
    }

    // If no start date recorded, this is the very first run — stamp it now
    if (!settings.initialScanStartDate) {
      settings.initialScanStartDate = new Date().toISOString();
      Logger.log('First-time run detected — recording initialScanStartDate.');
    }

    // Check how many days since the initial scan started
    var daysSinceStart = Math.floor(
      (new Date() - new Date(settings.initialScanStartDate)) / (1000 * 60 * 60 * 24)
    );

    if (daysSinceStart < 14) {
      isRampUp = true;
      Logger.log('🔍 RAMP-UP MODE — day ' + (daysSinceStart + 1) + ' of 14 — scanning up to 1000 threads (full inbox)');
    } else {
      Logger.log('📬 Daily scan — looking back 2 days');
    }

    var searchQuery = isRampUp ? GMAIL_SEARCH_INITIAL : GMAIL_SEARCH_DAILY;
    var maxThreads  = isRampUp ? 1000 : 30;    // 1000/day during ramp-up, 30 after
    var batchSize   = 50;                       // GmailApp.search page size

    // ── Gather all matching threads (paginated) ──
    var allThreads = [];
    var start      = 0;
    while (start < maxThreads) {
      var batch = GmailApp.search(searchQuery, start, Math.min(batchSize, maxThreads - start));
      if (batch.length === 0) break;
      allThreads = allThreads.concat(batch);
      start += batch.length;
      if (batch.length < batchSize) break;      // no more results
    }

    Logger.log('Threads found: ' + allThreads.length + (isRampUp ? ' (ramp-up day ' + (daysSinceStart + 1) + '/14)' : ''));

    const props        = PropertiesService.getScriptProperties();
    const processedIds = JSON.parse(props.getProperty('PROCESSED_EMAIL_IDS') || '[]');
    const newLeads     = [];

    // Get user email once outside the loop — getEffectiveUser() works reliably with time-driven triggers
    const userEmail = Session.getEffectiveUser().getEmail();

    allThreads.forEach(function(thread) {
      thread.getMessages().forEach(function(message) {
        const msgId = message.getId();
        if (processedIds.indexOf(msgId) !== -1) return; // Already processed

        const subject = message.getSubject()   || '';
        const body    = message.getPlainBody() || '';
        const from    = message.getFrom()      || '';
        const date    = message.getDate();

        // Skip emails from yourself or any @gusto.com address
        if (from.toLowerCase().includes(userEmail.toLowerCase())) return;
        if (from.toLowerCase().includes('gusto.com'))             return;

        // Skip no-reply / automated senders
        const fromLower = from.toLowerCase();
        if (fromLower.includes('noreply') || fromLower.includes('no-reply') ||
            fromLower.includes('donotreply') || fromLower.includes('notifications') ||
            fromLower.includes('mailer-daemon')) return;

        // Extract just the email address for blocked sender check
        var senderEmail = fromLower;
        var emailMatch = fromLower.match(/<([^>]+)>/);
        if (emailMatch) senderEmail = emailMatch[1];

        // Check blocked senders list (supports wildcards like "postmaster@*" and "*@myworkday.com")
        var isBlocked = BLOCKED_SENDERS.some(function(pattern) {
          var p = pattern.toLowerCase().trim();
          if (p.startsWith('*') && p.endsWith('*')) {
            return senderEmail.includes(p.slice(1, -1));
          } else if (p.startsWith('*')) {
            return senderEmail.endsWith(p.slice(1));
          } else if (p.endsWith('*')) {
            return senderEmail.startsWith(p.slice(0, -1));
          } else {
            return senderEmail === p;
          }
        });
        if (isBlocked) return;

        // Strip quoted thread from body so we only match keywords against
        // the prospect's FRESH reply — not our own outreach templates that
        // get quoted below. This prevents false positives like "Devin Bloeser"
        // where the prospect said "STOP CALLING" but our quoted email below
        // contained "payroll", "gusto", "benefits", etc.
        var freshBody = body;
        var quotePatterns = [
          /\nOn .+wrote:\s*\n/i,          // "On [date], [name] wrote:"
          /\n-{2,}\s*Original Message/i,   // "--- Original Message ---"
          /\nFrom:\s*.+@.+\n/i            // "From: email@domain.com"
        ];
        for (var qi = 0; qi < quotePatterns.length; qi++) {
          var qMatch = freshBody.match(quotePatterns[qi]);
          if (qMatch) {
            freshBody = freshBody.substring(0, qMatch.index);
            break;
          }
        }

        // Check for lead keywords against subject + FRESH body only
        // (subject is always the prospect's, so it's safe to include)
        const combined = (subject + ' ' + freshBody).toLowerCase();
        var matchedKeywords = [];
        HIGH_INTENT_KEYWORDS.forEach(function(kw) { if (combined.includes(kw)) matchedKeywords.push({ kw: kw, tier: 'high' }); });
        MED_INTENT_KEYWORDS.forEach(function(kw) { if (combined.includes(kw)) matchedKeywords.push({ kw: kw, tier: 'medium' }); });
        LOW_INTENT_KEYWORDS.forEach(function(kw) { if (combined.includes(kw)) matchedKeywords.push({ kw: kw, tier: 'low' }); });

        // Also check body-only keywords (these ONLY check freshBody, not subject)
        BODY_ONLY_KEYWORDS.forEach(function(kw) {
          if (freshBody.toLowerCase().includes(kw)) matchedKeywords.push({ kw: kw, tier: 'medium' });
        });

        var isLead = matchedKeywords.length > 0;

        // Check negative keywords against fresh text — skip even if lead keywords matched.
        // Uses 'combined' (subject + freshBody) so we only check the prospect's own words,
        // not rejection phrases that might appear in the quoted outreach below.
        var hasNegative = NEGATIVE_KEYWORDS.some(function(nk) { return combined.includes(nk); });
        if (hasNegative) return;

        if (isLead) {
          const lead = parseLeadFromEmail(from, subject, date, msgId);
          if (lead) {
            lead.matchedKeywords = matchedKeywords;
            // De-duplicate within the same scan batch (by email AND name)
            var alreadyInBatch = newLeads.some(function(existing) {
              if (existing.email.toLowerCase() === lead.email.toLowerCase()) return true;
              if (lead.name && existing.name && existing.name.toLowerCase().trim() === lead.name.toLowerCase().trim()) return true;
              return false;
            });
            if (!alreadyInBatch) newLeads.push(lead);
          }
        }

        processedIds.push(msgId);
      });
    });

    // Keep only the last 1000 processed IDs to avoid bloating Script Properties
    props.setProperty('PROCESSED_EMAIL_IDS', JSON.stringify(processedIds.slice(-1000)));

    if (newLeads.length > 0) {
      // Read current focus.json from GitHub (includes SHA needed for update)
      const result         = githubRead(FOCUS_PATH);
      const current        = result.data;
      const currentSha     = result.sha;
      const existingEmails = current.map(function(f) {
        return (f.email || '').toLowerCase();
      });
      const existingNames = current.map(function(f) {
        return (f.name || '').toLowerCase().trim();
      });

      // Filter out any leads already in the list (checks BOTH email AND name)
      const unique = newLeads.filter(function(l) {
        if (!l.email) return false;
        if (existingEmails.includes(l.email.toLowerCase())) return false;
        if (l.name && existingNames.includes(l.name.toLowerCase().trim())) return false;
        return true;
      });

      if (unique.length > 0) {
        const today   = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
        const updated = current.concat(unique);
        githubWrite(
          FOCUS_PATH,
          updated,
          currentSha,
          (isRampUp ? 'Ramp-up scan (day ' + (daysSinceStart + 1) + '/14): ' : 'Gmail scan: ') +
          'added ' + unique.length + ' new lead(s) — ' + today
        );
        Logger.log('✅ Added ' + unique.length + ' new lead(s) to Daily Focus on GitHub.');
        unique.forEach(function(l) { Logger.log('   • ' + l.name + ' <' + l.email + '>'); });
      } else {
        Logger.log('All matching leads already exist in focus list — no changes made.');
      }
    } else {
      Logger.log('No new leads found in inbox.');
    }

    // ── Save settings on first run (stamps the start date for the 14-day ramp-up) ──
    if (!settingsSha || daysSinceStart === 0) {
      // First-ever run or first day — write the start date so future runs can count days
      githubWrite(
        SETTINGS_PATH,
        settings,
        settingsSha,
        'Record initial scan start date'
      );
      Logger.log('✅ Saved initialScanStartDate to settings.json.');
    }
    if (isRampUp) {
      Logger.log('📅 Ramp-up day ' + (daysSinceStart + 1) + '/14 complete — ' + (13 - daysSinceStart) + ' days remaining before switching to daily mode.');
    }

    const syncTime = new Date().toISOString();
    props.setProperty('LAST_GMAIL_SYNC', syncTime);
    Logger.log('Scan complete: ' + syncTime);
    return { newLeads: newLeads.length, syncTime: syncTime, wasRampUp: isRampUp, rampUpDay: isRampUp ? daysSinceStart + 1 : null };

  } catch (err) {
    Logger.log('❌ Gmail check error: ' + err.message);
    throw err;
  }
}

function parseLeadFromEmail(from, subject, date, msgId) {
  try {
    let name  = '';
    let email = '';

    // Parse "Display Name <email@domain.com>" format
    const match = from.match(/^(.*?)\s*<([^>]+)>/);
    if (match) {
      name  = match[1].replace(/"/g, '').trim();
      email = match[2].trim();
    } else {
      email = from.trim();
      name  = email.split('@')[0].replace(/[._]/g, ' ');
    }

    if (!email) return null;

    // Capitalize name words
    name = name.split(' ').map(function(w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
    if (!name) name = email.split('@')[0];

    // Infer company from email domain (skip generic providers)
    const domain = (email.split('@')[1] || '').toLowerCase();
    const genericDomains = [
      'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
      'icloud.com', 'me.com', 'aol.com', 'live.com', 'msn.com'
    ];
    let company = '';
    if (domain && !genericDomains.includes(domain)) {
      const domainBase = domain.split('.')[0];
      company = domainBase.charAt(0).toUpperCase() +
                domainBase.slice(1).replace(/-/g, ' ');
    }

    const receivedDate = Utilities.formatDate(
      date,
      Session.getScriptTimeZone(),
      'yyyy-MM-dd'
    );

    return {
      id:           'gm_' + msgId.substring(0, 10),
      name:         name,
      company:      company,
      email:        email,
      status:       'new',
      holdUntil:    null,
      receivedDate: receivedDate,
      priority:     0,
      notes:        'Subject: ' + subject,
      source:       'gmail'
    };
  } catch (err) {
    Logger.log('Failed to parse email from "' + from + '": ' + err.message);
    return null;
  }
}

// ── TEST FUNCTION ──────────────────────────────────────────────────────────────────
// Run this to confirm the connection works. Check Logs (View → Logs) for result.

function testGitHubConnection() {
  Logger.log('=== Calebrate — Connection Test ===');
  Logger.log('Created by Caleb Garritson (caleb.garritson@gusto.com)');
  try {
    const result = githubRead(FOCUS_PATH);
    Logger.log('✅ GitHub connection OK.');
    Logger.log('   focus.json has ' + result.data.length + ' entries.');
    Logger.log('   Current SHA: ' + result.sha);

    // Also show in dialog if running from spreadsheet
    try {
      SpreadsheetApp.getUi().alert(
        '✅ Connection Successful',
        'Connected to GitHub! Found ' + result.data.length + ' leads in your Daily Focus.',
        SpreadsheetApp.getUi().ButtonSet.OK
      );
    } catch (e) { /* Not in spreadsheet context — log only */ }

  } catch (err) {
    Logger.log('❌ GitHub connection failed: ' + err.message);
    try {
      SpreadsheetApp.getUi().alert('❌ Connection Failed', err.message, SpreadsheetApp.getUi().ButtonSet.OK);
    } catch (e) { /* Not in spreadsheet context — log only */ }
  }
}
