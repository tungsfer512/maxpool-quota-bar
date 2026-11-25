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

function readProxyConfig() {
  const cfg = JSON.parse(fs.readFileSync(resolveMaxpoolConfigPath(), 'utf8'));
  const proxy = cfg.proxy || {};
  if (!proxy.port) throw new Error('maxpool config has no proxy.port');
  return { host: proxy.host || '127.0.0.1', port: proxy.port, apiKey: proxy.apiKey || '' };
}

const toPct = (v) => (Number.isFinite(v) ? Math.round(v * 100) : null);
const toTs = (v) => (Number.isFinite(v) ? v : null);

// Primary source: the proxy's /maxpool/status JSON, the same data `maxpool status` prints.
// It lists every account whatever its name looks like, and carries the reset times.
async function fetchStatusJson() {
  const proxy = readProxyConfig();
  const data = await getJson({
    host: proxy.host,
    port: proxy.port,
    path: '/maxpool/status',
    headers: { 'x-api-key': proxy.apiKey }
  });
  if (!Array.isArray(data.accounts)) throw new Error('unexpected /maxpool/status payload');

  const accounts = data.accounts.map((acct) => {
    const q = acct.quota || {}; // benched duplicates report quota: null
    const u = acct.usage || {};
    return {
      name: String(acct.name),
      active: acct.name === data.currentAccount,
      status: acct.enabled === false ? 'disabled' : acct.status || 'unknown',
      sessionUsed: toPct(q.unified5h),
      weeklyUsed: toPct(q.unified7d),
      sessionReset: toTs(q.unified5hReset),
      weeklyReset: toTs(q.unified7dReset),
      usage: Number.isFinite(u.totalRequests)
        ? {
            tokens: (u.totalInputTokens || 0) + (u.totalOutputTokens || 0),
            paid: Number.isFinite(u.totalPaidTokens) ? u.totalPaidTokens : null,
            requests: u.totalRequests
          }
        : null
    };
  });

  const routing =
    data.routing && data.routing.mode === 'preferred'
      ? `prefer ${data.routing.preferredAccount} with automatic failover`
      : 'automatic load balancing';
  const switchAt = Number.isFinite(data.switchThreshold)
    ? `${(data.switchThreshold * 100).toFixed(0)}%`
    : '';
  return { accounts, routing, switchAt };
}

// Fallback source: the text output of `maxpool status` (it has no reset times).
function parseMaxpoolStatus(output) {
  const accounts = [];
  let current = null;
  let routing = '';
  let switchAt = '';

  for (const line of output.split(/\r?\n/)) {
    const routeMatch = line.match(/^Routing:\s*(.+)/);
    if (routeMatch) routing = routeMatch[1].trim();

    const switchMatch = line.match(/^Switch at:\s*([0-9.]+%)/);
    if (switchMatch) switchAt = switchMatch[1];

    // Account header, e.g. "  me@example.com (oauth) *". Names may contain any character.
    const accMatch = line.match(/^ {2}(\S.*?)\s+\(([a-z-]+)\)(\s*\*)?\s*$/);
    if (accMatch) {
      if (current) accounts.push(current);
      current = {
        name: accMatch[1],
        active: Boolean(accMatch[3]),
        status: 'unknown',
        sessionUsed: null,
        weeklyUsed: null,
        sessionReset: null,
        weeklyReset: null,
        usage: null
      };
      continue;
    }

    if (!current) continue;

    const statusMatch = line.match(/^\s+Status:\s*(.+)/);
    if (statusMatch) current.status = statusMatch[1].trim();

    const sMatch = line.match(/Session:\s*([0-9.]+)%/);
    const wMatch = line.match(/Weekly:\s*([0-9.]+)%/);
    if (sMatch) current.sessionUsed = Math.round(parseFloat(sMatch[1]));
    if (wMatch) current.weeklyUsed = Math.round(parseFloat(wMatch[1]));

    const totalMatch = line.match(/^\s+Total:\s*(\d+)\s+tokens(?:\s+\(paid\s+(\d+)\))?,\s*(\d+)\s+requests?/);
    if (totalMatch) {
      current.usage = {
        tokens: +totalMatch[1],
        paid: totalMatch[2] != null ? +totalMatch[2] : null,
        requests: +totalMatch[3]
      };
    }
  }

  if (current) accounts.push(current);
  return { accounts, routing, switchAt };
}

function runMaxpoolStatus() {
  return new Promise((resolve, reject) => {
    const { bin, binDir } = resolveMaxpoolBinary();
    const env = { ...process.env };
    if (binDir) env.PATH = `${binDir}${path.delimiter}${env.PATH || ''}`;
    execFile(bin, ['status'], { env, timeout: 8000, shell: isWin }, (err, stdout) => {
      if (err || !stdout) reject(err || new Error('empty output'));
      else resolve(parseMaxpoolStatus(stdout));
    });
  });
}

// Rejects only when both sources fail, which means the proxy is offline.
async function fetchStatus() {
  try {
    return await fetchStatusJson();
  } catch (_) {
    return runMaxpoolStatus();
  }
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

const fmtPct = (pct) => (pct == null ? '—' : `${pct}%`);

// Severity is carried by theme color plus icon, never by color alone.
function usageLevel(pct) {
  if (pct >= 90) return { color: 'var(--vscode-charts-red)', icon: ' $(error)' };
  if (pct >= 75) return { color: 'var(--vscode-charts-yellow)', icon: ' $(warning)' };
  return { color: 'var(--vscode-charts-green)', icon: '' };
}

// 10-segment bullet bar: the used part takes the severity color, the rest is muted
function tooltipBar(pct) {
  if (pct == null) return muted('□'.repeat(10));
  const filled = Math.min(10, Math.max(0, Math.round(pct / 10)));
  const used = filled ? `<span style="color:${usageLevel(pct).color};">${'■'.repeat(filled)}</span>` : '';
  return used + (filled < 10 ? muted('□'.repeat(10 - filled)) : '');
}

function compactNumber(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

// { tokens: 93934957, paid: 6662441, requests: 397 } → "93.9M tokens · 6.7M paid · 397 requests"
function formatUsage(usage) {
  const parts = [`${compactNumber(usage.tokens)} tokens`];
  if (usage.paid != null) parts.push(`${compactNumber(usage.paid)} paid`);
  parts.push(`${usage.requests} requests`);
  return parts.join(' · ');
}

// Escape text coming from Maxpool before it goes into Markdown, HTML or a table cell.
// "@" becomes an entity so e-mail style account names don't turn into mailto links.
function escapeMd(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '&#64;')
    .replace(/\|/g, '\\|')
    .replace(/([*_`$\[\]])/g, '\\$1');
}

// Status bar names are cut to `maxLength` characters plus "…" (0 = never cut).
function truncateName(name, maxLength) {
  const chars = Array.from(name);
  return maxLength > 0 && chars.length > maxLength ? `${chars.slice(0, maxLength).join('')}…` : name;
}

function statusBadge(status) {
  if (status === 'active') {
    return '<span style="color:var(--vscode-charts-green);">$(pass-filled) active</span>';
  }
  return `<span style="color:var(--vscode-charts-yellow);">$(warning) ${escapeMd(status)}</span>`;
}

// ── Status bar ──────────────────────────────────────────────

// Every account is listed: "⚡name: 24% (W:4%)". Plain text with no background color;
// meters and severity colors live in the hover card only.
function statusBarView(state, nameLength = 10) {
  if (state.kind === 'loading') return { text: '$(sync~spin) Claude...' };
  if (state.kind === 'offline') return { text: '⚠️ Claude: Offline' };
  if (state.kind === 'empty') return { text: '⚠️ Claude: No Acc' };

  const text = state.accounts
    .map((acc) => {
      const name = truncateName(acc.name, nameLength);
      return `${acc.active ? '⚡' : ''}${name}: ${fmtPct(acc.sessionUsed)} (W:${fmtPct(acc.weeklyUsed)})`;
    })
    .join('  |  ');

  return { text };
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
    // "prefer <account> with automatic failover" → the account name in bold
    const preferred = state.routing.match(/^prefer (.+) with automatic failover$/);
    const routing = preferred
      ? `prefer **${escapeMd(preferred[1])}** with automatic failover`
      : escapeMd(state.routing);
    const switchAt = state.switchAt ? ` · switch at **${state.switchAt}**` : '';
    md.appendMarkdown(`<small>$(arrow-swap) ${routing}${switchAt}</small>\n\n`);
  }

  for (const acc of state.accounts) {
    const name = `${acc.active ? '$(zap)' : '$(account)'} ${escapeMd(acc.name)}`;
    const row = (label, pct, resetTs) => {
      const icon = pct == null ? '' : usageLevel(pct).icon;
      return `| ${label} | ${tooltipBar(pct)} | **${fmtPct(pct)}**${icon} | ${formatReset(resetTs)} |\n`;
    };

    md.appendMarkdown('---\n\n');
    md.appendMarkdown(`| **${name}** | ${statusBadge(acc.status)} | | $(history) Resets |\n`);
    md.appendMarkdown('| :--- | :--- | ---: | :--- |\n');
    md.appendMarkdown(row('Session · 5h', acc.sessionUsed, acc.sessionReset));
    md.appendMarkdown(row('Weekly · 7d', acc.weeklyUsed, acc.weeklyReset));
    if (acc.usage) {
      md.appendMarkdown(`\n<small>$(graph) ${escapeMd(formatUsage(acc.usage))}</small>\n\n`);
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
    const config = vscode.workspace.getConfiguration('maxpoolQuota');
    const nameLength = config.get('statusBarNameLength');
    const view = statusBarView(state, Number.isFinite(nameLength) ? Math.max(0, nameLength) : 10);
    item.text = manual && inFlight ? '$(sync~spin) Updating...' : view.text;
    item.tooltip = buildTooltip(state, Boolean(inFlight));
  };

  // Overlapping calls (timer + manual refresh) share one run
  const refresh = (manual = false) => {
    if (inFlight) return inFlight;
    inFlight = fetchStatus()
      .then((data) => {
        const now = new Date();
        state = data.accounts.length ? { kind: 'ok', ...data, updatedAt: now } : { kind: 'empty', updatedAt: now };
      })
      .catch(() => {
        state = { kind: 'offline', updatedAt: new Date() };
      })
      .finally(() => {
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
