// src/cli/service/win-task.js

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function generateWrapperCmd(nodeExec, daemonScript, forgeDir) {
  return `@echo off
"${nodeExec}" "${daemonScript}" > "${forgeDir}\\daemon.log" 2> "${forgeDir}\\daemon.error.log"
`;
}

function generateTaskXml(wrapperCmdPath, forgeDir) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Forge dev process orchestration daemon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <!-- Task Scheduler rejects intervals under one minute (PT1M–P31D) -->
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(wrapperCmdPath)}</Command>
      <WorkingDirectory>${xmlEscape(forgeDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

const TASK_NAME = '\\Forge\\ForgeDaemon';

function configDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Forge');
}

function taskXmlPath()    { return path.join(configDir(), 'forge-task.xml'); }
function wrapperCmdPath() { return path.join(configDir(), 'forge-daemon.cmd'); }

function install() {
  const daemonScript = path.resolve(__dirname, '../../daemon/server.js');
  const forgeDir = path.join(os.homedir(), '.forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  fs.mkdirSync(configDir(), { recursive: true });

  const wrapperPath = wrapperCmdPath();
  fs.writeFileSync(wrapperPath, generateWrapperCmd(process.execPath, daemonScript, forgeDir));

  const xmlPath = taskXmlPath();
  // schtasks /XML on some locales refuses UTF-8 task XML ("unable to switch the
  // encoding") — write UTF-16LE with BOM, the format schtasks itself exports.
  const xml = generateTaskXml(wrapperPath, forgeDir).replace('encoding="UTF-8"', 'encoding="UTF-16"');
  fs.writeFileSync(xmlPath, '\ufeff' + xml, 'utf16le');

  // /F overwrites if the task already exists — satisfies idempotency.
  // stdio captures stderr so a schtasks failure throws with the actual error text.
  try {
    execFileSync('schtasks.exe', [
      '/Create', '/XML', xmlPath, '/TN', TASK_NAME, '/F',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    // Some machines (group policy, restricted accounts) deny task creation to
    // non-elevated users. Turn the raw stack trace into an actionable message.
    const stderr = String(err.stderr ?? '');
    if (err.status === 5 || /access is denied|0x80070005/i.test(stderr)) {
      throw new Error(
        'Registering the logon task was denied — this machine requires elevation.\n' +
        'Run this once from an Administrator PowerShell, then the daemon starts at every logon:\n\n' +
        `  schtasks /Create /XML "${xmlPath}" /TN ${TASK_NAME} /F\n` +
        `  schtasks /Run /TN ${TASK_NAME}\n\n` +
        `Until then, start the daemon manually:\n  node "${daemonScript}"`,
      );
    }
    throw err;
  }

  execFileSync('schtasks.exe', [
    '/Run', '/TN', TASK_NAME,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

function isInstalled() {
  try {
    execFileSync('schtasks.exe', ['/Query', '/TN', TASK_NAME], { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function uninstall() {
  const xmlPath = taskXmlPath();
  const wrapperPath = wrapperCmdPath();
  const filesExist = fs.existsSync(xmlPath) || fs.existsSync(wrapperPath);
  const installed = isInstalled();
  if (!installed && !filesExist) return;

  if (installed) {
    // /F skips the [Y/N] confirmation prompt.
    execFileSync('schtasks.exe', [
      '/Delete', '/TN', TASK_NAME, '/F',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  try { fs.unlinkSync(xmlPath); } catch {}
  try { fs.unlinkSync(wrapperPath); } catch {}
}

module.exports = { generateTaskXml, generateWrapperCmd, xmlEscape, install, uninstall, isInstalled, taskXmlPath, wrapperCmdPath };
