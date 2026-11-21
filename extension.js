const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function resolveMaxpoolBinary() {
  const config = vscode.workspace.getConfiguration('maxpoolQuota');
  const customPath = (config.get('binaryPath') || '').trim();
  if (customPath && fs.existsSync(customPath)) {
    return { bin: customPath, binDir: path.dirname(customPath) };
  }

  const home = os.homedir();
  const candidates = [
    '/usr/local/bin/maxpool',
    '/usr/bin/maxpool',
    path.join(home, '.local', 'bin', 'maxpool'),
    path.join(home, '.npm-global', 'bin', 'maxpool')
  ];

  // Quét tự động các phiên bản Node trong nvm (nếu người dùng cài qua nvm)
  const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
  if (fs.existsSync(nvmVersionsDir)) {
    try {
      const versions = fs.readdirSync(nvmVersionsDir).sort().reverse();
      for (const v of versions) {
        candidates.unshift(path.join(nvmVersionsDir, v, 'bin', 'maxpool'));
      }
    } catch (_) {}
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { bin: candidate, binDir: path.dirname(candidate) };
    }
  }

  return { bin: 'maxpool', binDir: '' };
}

function drawBar(usedPct) {
  const filled = Math.min(5, Math.max(0, Math.round(usedPct / 20)));
  return '▰'.repeat(filled) + '▱'.repeat(5 - filled);
}

function parseMaxpoolStatus(output) {
  const lines = output.split(/\r?\n/);
  const accounts = [];
  let current = null;

  for (const line of lines) {
    const accMatch = line.match(/^\s+([a-zA-Z0-9_-]+)\s+\(oauth\)(\s*\*)?/);
    if (accMatch) {
      current = {
        name: accMatch[1],
        active: Boolean(accMatch[2]),
        sessionUsed: 0,
        weeklyUsed: 0
      };
      continue;
    }

    if (current && line.includes('Session:')) {
      const sMatch = line.match(/Session:\s*([0-9.]+)%/);
      const wMatch = line.match(/Weekly:\s*([0-9.]+)%/);
      if (sMatch) current.sessionUsed = Math.round(parseFloat(sMatch[1]));
      if (wMatch) current.weeklyUsed = Math.round(parseFloat(wMatch[1]));
      accounts.push(current);
      current = null;
    }
  }

  if (accounts.length === 0) {
    return '⚠️ Claude: No Acc';
  }

  return accounts
    .map((acc) => {
      const maxUsed = Math.max(acc.sessionUsed, acc.weeklyUsed);
      const bar = drawBar(maxUsed);
      const prefix = acc.active ? '⚡' : '';
      return `${prefix}${acc.name}: ${bar} ${acc.sessionUsed}% (W:${acc.weeklyUsed}%)`;
    })
    .join('  |  ');
}

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.tooltip = 'Claude Team token usage via Maxpool (Click to refresh now)';
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
      env.PATH = `${binDir}:${env.PATH || ''}`;
    }

    execFile(bin, ['status'], { env, timeout: 8000 }, (err, stdout) => {
      if (err || !stdout) {
        item.text = '⚠️ Claude: Offline';
        return;
      }
      item.text = parseMaxpoolStatus(stdout);
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
