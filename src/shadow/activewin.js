'use strict';
// Which app and window is in front, polled every second or so. No native modules:
// macOS uses AppleScript, Windows a long-running PowerShell helper, Linux xdotool/xprop.
const { execFile, spawn } = require('child_process');

const run = (cmd, args, timeout = 1500) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
});

// ---------------------------------------------------------------- macOS
const MAC_SCRIPT = `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set winTitle to ""
  try
    set winTitle to name of front window of frontApp
  end try
end tell
set theURL to ""
try
  if appName is "Google Chrome" then
    tell application "Google Chrome" to set theURL to URL of active tab of front window
  else if appName is "Microsoft Edge" then
    tell application "Microsoft Edge" to set theURL to URL of active tab of front window
  else if appName is "Brave Browser" then
    tell application "Brave Browser" to set theURL to URL of active tab of front window
  else if appName is "Arc" then
    tell application "Arc" to set theURL to URL of active tab of front window
  else if appName is "Safari" then
    tell application "Safari" to set theURL to URL of front document
  end if
end try
return appName & tab & winTitle & tab & theURL`;

async function macActive() {
  const out = await run('osascript', ['-e', MAC_SCRIPT], 2500);
  if (!out) return null;
  const [app = '', title = '', url = ''] = out.split('\t');
  return { app, title, url };
}

// ---------------------------------------------------------------- Windows
const WIN_SCRIPT = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$last = ""
while ($true) {
  $h = [FG]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][FG]::GetWindowText($h, $sb, 512)
  $procId = 0
  [void][FG]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = ""
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  $line = $name + [char]9 + $sb.ToString()
  if ($line -ne $last) { [Console]::Out.WriteLine($line); [Console]::Out.Flush(); $last = $line }
  Start-Sleep -Milliseconds 700
}`;

function windowsWatcher(onChange, onError) {
  let child = null;
  let stopped = false;
  let failures = 0;
  // -EncodedCommand (UTF-16LE base64) avoids Windows mangling quotes and newlines in the script.
  const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
  const startChild = () => {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    child.on('error', (err) => onError(`Can’t start PowerShell to see the front window (${err.message})`));
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf = (errBuf + d.toString('utf8')).slice(-400); });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        const [app = '', title = ''] = line.split('\t');
        failures = 0;
        onChange({ app, title, url: '' });
      }
    });
    child.on('exit', () => {
      if (stopped) return;
      failures++;
      if (failures >= 3) { onError(`Can’t see which app is in front${errBuf ? `: ${errBuf.trim().split('\n').pop()}` : ''}`); return; }
      setTimeout(startChild, 3000);
    });
  };
  startChild();
  return () => { stopped = true; if (child) child.kill(); };
}

// ---------------------------------------------------------------- Linux (X11)
async function linuxActive() {
  let id = await run('xdotool', ['getactivewindow']);
  if (!id) id = await run('xdotool', ['getwindowfocus']);
  if (!id) return null;
  const title = (await run('xdotool', ['getwindowname', id])) || '';
  const cls = (await run('xprop', ['-id', id, 'WM_CLASS'])) || '';
  const m = cls.match(/"([^"]*)"\s*$/);
  return { app: m ? m[1] : '', title, url: '' };
}

/**
 * Calls onChange({app, title, url}) whenever the front window changes, and onError(message)
 * if the front window can't be read for a while. Returns a stop function.
 */
function watchActiveWindow(onChange, intervalMs = 1200, onError = () => {}) {
  if (process.platform === 'win32') return windowsWatcher(onChange, onError);
  const read = process.platform === 'darwin' ? macActive : linuxActive;
  const hint = process.platform === 'darwin'
    ? 'Allow The Pill to control System Events (Privacy & Security → Automation) and Accessibility'
    : 'Install xdotool (sudo apt install xdotool) and use an X11 session';
  let last = '';
  let busy = false;
  let misses = 0;
  let reported = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const w = await read();
      if (!w) {
        misses++;
        if (misses >= 5 && !reported) { reported = true; onError(`Can’t see which app is in front. ${hint}.`); }
        return;
      }
      misses = 0;
      if (reported) { reported = false; onError(null); }
      const key = `${w.app}\t${w.title}\t${w.url}`;
      if (key !== last) { last = key; onChange(w); }
    } finally { busy = false; }
  }, intervalMs);
  return () => clearInterval(timer);
}

module.exports = { watchActiveWindow };
