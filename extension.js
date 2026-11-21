const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';
const exeName = isWin ? 'maxpool.cmd' : 'maxpool';

// ── Data sources ────────────────────────────────────────────

function resolveMaxpoolBinary() {
  const config = vscode.workspace.getConfiguration('maxpoolQuota');
  const customPath = (config.get('binaryPath') || '').trim();
  if (customPath && fs.existsSync(customPath)) {
    return { bin: customPath, binDir: path.dirname(customPath) };
  }

  const home = os.homedir();
  const candidates = [];

  if (isWin) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(
      path.join(appData, 'npm', 'maxpool.cmd'),
      path.join(localAppData, 'nvm', 'current', 'maxpool.cmd'),
      path.join('C:\\Program Files\\nodejs', 'maxpool.cmd')
    );
  } else {
    candidates.push(
      '/opt/homebrew/bin/maxpool',
      '/usr/local/bin/maxpool',
      '/usr/bin/maxpool',
      path.join(home, '.local', 'bin', 'maxpool'),
      path.join(home, '.npm-global', 'bin', 'maxpool')
    );

    const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmVersionsDir)) {
      try {
        const versions = fs.readdirSync(nvmVersionsDir).sort().reverse();
        for (const v of versions) {
          candidates.unshift(path.join(nvmVersionsDir, v, 'bin', 'maxpool'));
        }
      } catch (_) {}
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { bin: candidate, binDir: path.dirname(candidate) };
    }
  }

  return { bin: exeName, binDir: '' };
}

// Same lookup order as maxpool itself (src/config.js → getConfigPath)
function resolveMaxpoolConfigPath() {
  if (process.env.MAXPOOL_CONFIG) return process.env.MAXPOOL_CONFIG;
  if (process.env.TEAMCLAUDE_CONFIG) return process.env.TEAMCLAUDE_CONFIG;
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const current = path.join(configDir, 'maxpool.json');
  if (fs.existsSync(current)) return current;
  const legacy = path.join(configDir, 'teamclaude.json');
  if (fs.existsSync(legacy)) return legacy;
  return current;
}

function getJson(options) {
  return new Promise((resolve, reject) => {
    const req = http.get({ ...options, timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Next reset time (epoch ms) per account, read from the maxpool server's JSON endpoint.
// Resolves to an empty Map on any failure; the UI then shows "reset time unavailable".
async function fetchResetTimes() {
  const resets = new Map();
  try {
    const cfg = JSON.parse(fs.readFileSync(resolveMaxpoolConfigPath(), 'utf8'));
    const proxy = cfg.proxy || {};
    if (!proxy.port) return resets;
    const data = await getJson({
      host: proxy.host || '127.0.0.1',
      port: proxy.port,
      path: '/maxpool/status',
      headers: { 'x-api-key': proxy.apiKey || '' }
    });
    for (const acct of data.accounts || []) {
      const q = acct.quota || {};
      resets.set(acct.name, {
        session: Number.isFinite(q.unified5hReset) ? q.unified5hReset : null,
        weekly: Number.isFinite(q.unified7dReset) ? q.unified7dReset : null
      });
    }
  } catch (_) {}
  return resets;
}

function parseMaxpoolStatus(output) {
  const accounts = [];
  let current = null;
  let routing = '';
  let switchAt = '90%';

  for (const line of output.split(/\r?\n/)) {
    const routeMatch = line.match(/^Routing:\s*(.+)/);
    if (routeMatch) routing = routeMatch[1].trim();

    const switchMatch = line.match(/^Switch at:\s*([0-9.]+%)/);
    if (switchMatch) switchAt = switchMatch[1];

    const accMatch = line.match(/^\s+([a-zA-Z0-9_-]+)\s+\(oauth\)(\s*\*)?/);
    if (accMatch) {
      if (current) accounts.push(current);
      current = {
        name: accMatch[1],
        active: Boolean(accMatch[2]),
        status: 'active',
        sessionUsed: 0,
        weeklyUsed: 0,
        totalInfo: ''
      };
      continue;
    }

    if (!current) continue;

    const statusMatch = line.match(/^\s+Status:\s*(.+)/);
    if (statusMatch) current.status = statusMatch[1].trim();

    if (line.includes('Session:')) {
      const sMatch = line.match(/Session:\s*([0-9.]+)%/);
      const wMatch = line.match(/Weekly:\s*([0-9.]+)%/);
      if (sMatch) current.sessionUsed = Math.round(parseFloat(sMatch[1]));
      if (wMatch) current.weeklyUsed = Math.round(parseFloat(wMatch[1]));
    }

    const totalMatch = line.match(/^\s+Total:\s*(.+)/);
    if (totalMatch) current.totalInfo = totalMatch[1].trim();
  }

  if (current) accounts.push(current);
  return { accounts, routing, switchAt };
}

// ── Formatting ──────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const hhmmss = (d) => `${hhmm(d)}:${pad2(d.getSeconds())}`;
const muted = (s) => `<span style="color:var(--vscode-descriptionForeground);">${s}</span>`;

// 24-hour clock in the machine's time zone: "19:10" (today), "Tomorrow 03:00",
// "Fri 27/11 03:00", followed by a countdown.
function formatReset(ts) {
  if (!ts) return muted('—');
  const d = new Date(ts);
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  let clock;
  if (d.toDateString() === now.toDateString()) clock = hhmm(d);
  else if (d.toDateString() === tomorrow.toDateString()) clock = `Tomorrow ${hhmm(d)}`;
  else clock = `${WEEKDAYS[d.getDay()]} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${hhmm(d)}`;

  const diffMin = Math.round((ts - now.getTime()) / 60000);
  if (diffMin <= 0) return `**${clock}** · _due now_`;
  const days = Math.floor(diffMin / 1440);
  const hours = Math.floor((diffMin % 1440) / 60);
  const mins = diffMin % 60;
  const rel = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  return `**${clock}** · _in ${rel}_`;
}

// Severity is carried by theme color plus icon, never by color alone.
function usageLevel(pct) {
  if (pct >= 90) return { color: 'var(--vscode-charts-red)', icon: ' $(error)' };
  if (pct >= 75) return { color: 'var(--vscode-charts-yellow)', icon: ' $(warning)' };
  return { color: 'var(--vscode-charts-green)', icon: '' };
}

function meter(pct, segments) {
  const filled = Math.min(segments, Math.max(0, Math.round((pct / 100) * segments)));
  return { filled, empty: segments - filled };
}

// 10-segment bullet bar: the used part takes the severity color, the rest is muted
function tooltipBar(pct) {
  const { filled, empty } = meter(pct, 10);
  const used = filled ? `<span style="color:${usageLevel(pct).color};">${'■'.repeat(filled)}</span>` : '';
  return used + (empty ? muted('□'.repeat(empty)) : '');
}

function compactNumber(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

// "93934957 tokens (paid 6662441), 397 requests" → "93.9M tokens · 6.7M paid · 397 requests"
function formatTotal(info) {
  const m = info.match(/^(\d+)\s+tokens(?:\s+\(paid\s+(\d+)\))?,\s*(\d+)\s+requests?/);
  if (!m) return info;
  const parts = [`${compactNumber(+m[1])} tokens`];
  if (m[2]) parts.push(`${compactNumber(+m[2])} paid`);
  parts.push(`${m[3]} requests`);
  return parts.join(' · ');
}

// Escape text coming from the CLI before it goes into Markdown, HTML or a table cell
function escapeMd(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/([*_`$\[\]])/g, '\\$1');
}

function statusBadge(status) {
  if (status === 'active') {
    return '<span style="color:var(--vscode-charts-green);">$(pass-filled) active</span>';
  }
  return `<span style="color:var(--vscode-charts-yellow);">$(warning) ${escapeMd(status)}</span>`;
}

// ── Status bar ──────────────────────────────────────────────

function statusBarView(state) {
  if (state.kind === 'loading') return { text: '$(sync~spin) Claude...', level: 'normal' };
  if (state.kind === 'offline') return { text: '⚠️ Claude: Offline', level: 'error' };
  if (state.kind === 'empty') return { text: '⚠️ Claude: No Acc', level: 'warning' };

  const { accounts } = state;
  // Color follows the account in use, or turns red when every account is nearly exhausted
  const activeAcc = accounts.find((a) => a.active) || accounts[0];
  const activeMax = Math.max(activeAcc.sessionUsed, activeAcc.weeklyUsed);
  const minAll = Math.min(...accounts.map((a) => Math.max(a.sessionUsed, a.weeklyUsed)));

  let level = 'normal';
  if (minAll >= 90 || activeMax >= 90) level = 'error';
  else if (activeMax >= 75) level = 'warning';

  const text = accounts
    .map((acc) => {
      const { filled, empty } = meter(Math.max(acc.sessionUsed, acc.weeklyUsed), 5);
      const bar = '▰'.repeat(filled) + '▱'.repeat(empty);
      return `${acc.active ? '⚡' : ''}${acc.name}: ${bar} ${acc.sessionUsed}% (W:${acc.weeklyUsed}%)`;
    })
    .join('  |  ');

  return { text, level };
}

function applyBackgroundColor(item, level) {
  if (level === 'error') {
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (level === 'warning') {
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    item.backgroundColor = undefined;
  }
}

// ── Tooltip ─────────────────────────────────────────────────

const SETTINGS_ARGS = encodeURIComponent(JSON.stringify(['maxpoolQuota']));

// Command links double as buttons. Their presence also keeps the hover open while the
// mouse moves into it (VS Code only makes Markdown hovers sticky when they contain links).
function actionBar(state, refreshing) {
  const refresh = refreshing
    ? '$(sync~spin) Refreshing…'
    : '[$(refresh) Refresh now](command:maxpoolQuota.refreshNow "Fetch the latest quota now")';
  const settings = `[$(gear) Settings](command:workbench.action.openSettings?${SETTINGS_ARGS} "Open Maxpool Quota settings")`;
  const updated = state.updatedAt ? `&nbsp;&nbsp;&nbsp;<small>Updated ${hhmmss(state.updatedAt)}</small>` : '';
  return `${refresh} &nbsp;·&nbsp; ${settings}${updated}`;
}

function buildTooltip(state, refreshing) {
  const md = new vscode.MarkdownString('', true);
  md.supportHtml = true;
  md.isTrusted = true;

  if (state.kind === 'loading') {
    md.appendMarkdown('#### $(pulse) Maxpool Claude Quota\n\n$(loading~spin) Loading quota…');
    return md;
  }
  if (state.kind === 'offline') {
    md.appendMarkdown('#### $(debug-disconnect) Maxpool proxy is offline\n\n');
    md.appendMarkdown('Start it with `maxpool server`, then refresh.\n\n---\n\n');
    md.appendMarkdown(actionBar(state, refreshing));
    return md;
  }
  if (state.kind === 'empty') {
    md.appendMarkdown('#### $(warning) No Claude accounts\n\n');
    md.appendMarkdown('Maxpool has no OAuth accounts yet. Add one with `maxpool login`, then refresh.\n\n---\n\n');
    md.appendMarkdown(actionBar(state, refreshing));
    return md;
  }

  md.appendMarkdown('#### $(pulse) Maxpool Claude Quota\n\n');
  if (state.routing) {
    md.appendMarkdown(
      `<small>$(arrow-swap) ${escapeMd(state.routing)} · switch at **${state.switchAt}**</small>\n\n`
    );
  }

  for (const acc of state.accounts) {
    const r = state.resets.get(acc.name) || {};
    const name = `${acc.active ? '$(zap)' : '$(account)'} ${escapeMd(acc.name)}`;
    const row = (label, pct, resetTs) =>
      `| ${label} | ${tooltipBar(pct)} | **${pct}%**${usageLevel(pct).icon} | ${formatReset(resetTs)} |\n`;

    md.appendMarkdown('---\n\n');
    md.appendMarkdown(`| **${name}** | ${statusBadge(acc.status)} | | $(history) Resets |\n`);
    md.appendMarkdown('| :--- | :--- | ---: | :--- |\n');
    md.appendMarkdown(row('Session · 5h', acc.sessionUsed, r.session));
    md.appendMarkdown(row('Weekly · 7d', acc.weeklyUsed, r.weekly));
    if (acc.totalInfo) {
      md.appendMarkdown(`\n<small>$(graph) ${escapeMd(formatTotal(acc.totalInfo))}</small>\n\n`);
    }
  }

  md.appendMarkdown('---\n\n');
  md.appendMarkdown(actionBar(state, refreshing));
  return md;
}

// ── Activation ──────────────────────────────────────────────

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'maxpoolQuota.refreshNow';

  let state = { kind: 'loading', updatedAt: null };
  let inFlight = null;
  let timer = null;

  const render = (manual = false) => {
    const view = statusBarView(state);
    item.text = manual && inFlight ? '$(sync~spin) Updating...' : view.text;
    item.tooltip = buildTooltip(state, Boolean(inFlight));
    applyBackgroundColor(item, view.level);
  };

  // Overlapping calls (timer + manual refresh) share one run
  const refresh = (manual = false) => {
    if (inFlight) return inFlight;
    inFlight = new Promise((resolve) => {
      const { bin, binDir } = resolveMaxpoolBinary();
      const env = { ...process.env };
      if (binDir) env.PATH = `${binDir}${path.delimiter}${env.PATH || ''}`;

      const resetsPromise = fetchResetTimes();
      execFile(bin, ['status'], { env, timeout: 8000, shell: isWin }, async (err, stdout) => {
        const resets = await resetsPromise;
        const now = new Date();
        if (err || !stdout) {
          state = { kind: 'offline', updatedAt: now };
        } else {
          const parsed = parseMaxpoolStatus(stdout);
          state = parsed.accounts.length
            ? { kind: 'ok', ...parsed, resets, updatedAt: now }
            : { kind: 'empty', updatedAt: now };
        }
        resolve();
      });
    }).finally(() => {
      inFlight = null;
      render();
    });
    if (manual) render(true); // spinner in the status bar and the tooltip
    return inFlight;
  };

  const setupTimer = () => {
    if (timer) clearInterval(timer);
    const config = vscode.workspace.getConfiguration('maxpoolQuota');
    const sec = Math.max(5, config.get('refreshIntervalSeconds') || 15);
    timer = setInterval(() => refresh(), sec * 1000);
  };

  const cfgListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('maxpoolQuota')) {
      setupTimer();
      refresh();
    }
  });

  context.subscriptions.push(
    item,
    vscode.commands.registerCommand('maxpoolQuota.refreshNow', () => refresh(true)),
    cfgListener,
    { dispose: () => timer && clearInterval(timer) }
  );

  render();
  item.show();
  refresh();
  setupTimer();
}

function deactivate() {}

module.exports = { activate, deactivate };
