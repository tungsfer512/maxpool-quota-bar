const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';
const exeName = isWin ? 'maxpool.cmd' : 'maxpool';

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

function drawBar(usedPct) {
  const filled = Math.min(5, Math.max(0, Math.round(usedPct / 20)));
  return '▰'.repeat(filled) + '▱'.repeat(5 - filled);
}

function parseMaxpoolStatus(output) {
  const lines = output.split(/\r?\n/);
  const accounts = [];
  let current = null;
  let routing = '';
  let switchAt = '90%';

  for (const line of lines) {
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

  if (accounts.length === 0) {
    return {
      text: '⚠️ Claude: No Acc',
      level: 'warning',
      tooltip: new vscode.MarkdownString('**Maxpool:** No OAuth accounts configured.')
    };
  }

  // Xác định mức cảnh báo màu dựa trên tài khoản đang active (hoặc mức thấp nhất nếu tất cả đều cao)
  const activeAcc = accounts.find((a) => a.active) || accounts[0];
  const activeMax = Math.max(activeAcc.sessionUsed, activeAcc.weeklyUsed);
  const minAll = Math.min(...accounts.map((a) => Math.max(a.sessionUsed, a.weeklyUsed)));

  let level = 'normal';
  if (minAll >= 90 || activeMax >= 90) {
    level = 'error';
  } else if (activeMax >= 75) {
    level = 'warning';
  }

  const text = accounts
    .map((acc) => {
      const maxUsed = Math.max(acc.sessionUsed, acc.weeklyUsed);
      const bar = drawBar(maxUsed);
      const prefix = acc.active ? '⚡' : '';
      return `${prefix}${acc.name}: ${bar} ${acc.sessionUsed}% (W:${acc.weeklyUsed}%)`;
    })
    .join('  |  ');

  // Tạo bảng Markdown chi tiết khi di chuột (hover)
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.appendMarkdown(`### ⚡ Maxpool Claude Quota\n\n`);
  md.appendMarkdown(`| Account | Status | Session (5h) | Weekly | Usage |\n`);
  md.appendMarkdown(`| :--- | :---: | :---: | :---: | :--- |\n`);

  for (const acc of accounts) {
    const label = acc.active ? `**⚡ ${acc.name}**` : acc.name;
    const totalStr = acc.totalInfo || '—';
    md.appendMarkdown(
      `| ${label} | ${acc.status} | **${acc.sessionUsed}%** | **${acc.weeklyUsed}%** | ${totalStr} |\n`
    );
  }

  md.appendMarkdown(`\n---\n`);
  if (routing) {
    md.appendMarkdown(`- **Routing:** ${routing} *(Switch at ${switchAt})*\n`);
  }
  md.appendMarkdown(`- *Click status bar item to refresh immediately*`);

  return { text, level, tooltip: md };
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

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'maxpoolQuota.refreshNow';
  item.text = '$(sync~spin) Claude...';
  item.show();

  let timer = null;

  const refresh = (showSpinner = false) => {
    if (showSpinner) {
      item.text = '$(sync~spin) Updating...';
    }
    const { bin, binDir } = resolveMaxpoolBinary();
    const env = { ...process.env };
    if (binDir) {
      env.PATH = `${binDir}${path.delimiter}${env.PATH || ''}`;
    }

    execFile(bin, ['status'], { env, timeout: 8000, shell: isWin }, (err, stdout) => {
      if (err || !stdout) {
        item.text = '⚠️ Claude: Offline';
        item.tooltip = new vscode.MarkdownString(
          '**Maxpool Proxy is Offline**\n\nMake sure `maxpool server` is running.'
        );
        applyBackgroundColor(item, 'error');
        return;
      }

      const parsed = parseMaxpoolStatus(stdout);
      item.text = parsed.text;
      item.tooltip = parsed.tooltip;
      applyBackgroundColor(item, parsed.level);
    });
  };

  const setupTimer = () => {
    if (timer) clearInterval(timer);
    const config = vscode.workspace.getConfiguration('maxpoolQuota');
    const sec = Math.max(5, config.get('refreshIntervalSeconds') || 15);
    timer = setInterval(() => refresh(false), sec * 1000);
  };

  const cmd = vscode.commands.registerCommand('maxpoolQuota.refreshNow', () => {
    refresh(true);
  });

  const cfgListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('maxpoolQuota')) {
      setupTimer();
      refresh(false);
    }
  });

  refresh(false);
  setupTimer();

  context.subscriptions.push(
    item,
    cmd,
    cfgListener,
    { dispose: () => timer && clearInterval(timer) }
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
