const winTask = require('../../src/cli/service/win-task');

describe('winTask.generateTaskXml', () => {
  test('produces a UTF-8 XML config with LogonTrigger, Exec pointing at the wrapper, and RestartOnFailure', () => {
    const xml = winTask.generateTaskXml(
      'C:\\Users\\me\\AppData\\Local\\Forge\\forge-daemon.cmd',
      'C:\\Users\\me\\.forge'
    );
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<LogonTrigger>');
    // Task Scheduler rejects RestartOnFailure intervals under one minute (PT1M–P31D).
    expect(xml).toContain('<Interval>PT1M</Interval>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<Command>C:\\Users\\me\\AppData\\Local\\Forge\\forge-daemon.cmd</Command>');
    expect(xml).toContain('<WorkingDirectory>C:\\Users\\me\\.forge</WorkingDirectory>');
    // No cmd.exe wrapping inside the XML — the wrapper .cmd does that job.
    expect(xml).not.toContain('cmd.exe');
  });

  test('XML-escapes &, <, > in embedded paths', () => {
    const xml = winTask.generateTaskXml('C:\\path with & ampersand > and < lt', 'D:\\dir');
    expect(xml).toContain('<Command>C:\\path with &amp; ampersand &gt; and &lt; lt</Command>');
  });
});

describe('winTask.generateWrapperCmd', () => {
  test('starts with @echo off and redirects stdout/stderr to the log files', () => {
    const cmd = winTask.generateWrapperCmd(
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\path\\server.js',
      'C:\\Users\\me\\.forge'
    );
    expect(cmd).toMatch(/^@echo off\r?\n/);
    expect(cmd).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(cmd).toContain('"C:\\path\\server.js"');
    expect(cmd).toContain('> "C:\\Users\\me\\.forge\\daemon.log"');
    expect(cmd).toContain('2> "C:\\Users\\me\\.forge\\daemon.error.log"');
  });
});

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('child_process');
const { execFileSync } = require('child_process');

describe('winTask.install', () => {
  let localAppData;

  beforeEach(() => {
    localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-win-task-'));
    process.env.LOCALAPPDATA = localAppData;
    execFileSync.mockReset();
  });

  afterEach(() => {
    fs.rmSync(localAppData, { recursive: true, force: true });
    delete process.env.LOCALAPPDATA;
  });

  test('writes both forge-task.xml and forge-daemon.cmd to %LOCALAPPDATA%\\Forge\\', () => {
    winTask.install();
    const cfgDir = path.join(localAppData, 'Forge');
    expect(fs.existsSync(path.join(cfgDir, 'forge-task.xml'))).toBe(true);
    expect(fs.existsSync(path.join(cfgDir, 'forge-daemon.cmd'))).toBe(true);
    // XML is written as UTF-16LE with BOM — schtasks /XML rejects UTF-8 on
    // some locales ("unable to switch the encoding") — and must both declare
    // UTF-16 and reference the wrapper by absolute path.
    const xmlOnDisk = fs.readFileSync(path.join(cfgDir, 'forge-task.xml'), 'utf16le');
    expect(xmlOnDisk.charCodeAt(0)).toBe(0xfeff);
    expect(xmlOnDisk).toContain('encoding="UTF-16"');
    expect(xmlOnDisk).toContain(path.join(cfgDir, 'forge-daemon.cmd'));
    // Wrapper redirects to ~/.forge/daemon.log.
    expect(fs.readFileSync(path.join(cfgDir, 'forge-daemon.cmd'), 'utf8'))
      .toMatch(/> ".*[\\\/]\.forge[\\\/]daemon\.log"/);
  });

  test('runs schtasks.exe /Create then /Run, in that order', () => {
    winTask.install();
    expect(execFileSync).toHaveBeenCalledTimes(2);
    const firstArgs = execFileSync.mock.calls[0];
    const secondArgs = execFileSync.mock.calls[1];
    expect(firstArgs[0]).toBe('schtasks.exe');
    expect(firstArgs[1]).toEqual(expect.arrayContaining(['/Create', '/F', '/TN', '\\Forge\\ForgeDaemon']));
    expect(secondArgs[0]).toBe('schtasks.exe');
    expect(secondArgs[1]).toEqual(['/Run', '/TN', '\\Forge\\ForgeDaemon']);
    // stdio should capture stderr so failures bubble up with context.
    expect(firstArgs[2]).toEqual({ stdio: ['ignore', 'ignore', 'pipe'] });
  });
});

describe('winTask.uninstall', () => {
  let localAppData;

  beforeEach(() => {
    localAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-win-task-'));
    process.env.LOCALAPPDATA = localAppData;
    execFileSync.mockReset();
  });

  afterEach(() => {
    fs.rmSync(localAppData, { recursive: true, force: true });
    delete process.env.LOCALAPPDATA;
  });

  test('runs schtasks.exe /Delete /F AND removes both config files when task is installed', () => {
    const cfgDir = path.join(localAppData, 'Forge');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'forge-task.xml'), 'placeholder');
    fs.writeFileSync(path.join(cfgDir, 'forge-daemon.cmd'), 'placeholder');

    execFileSync.mockImplementation((cmd, args) => {
      if (args.includes('/Query')) return;
    });
    winTask.uninstall();

    const calls = execFileSync.mock.calls.map(c => c[1]);
    expect(calls).toContainEqual(['/Query', '/TN', '\\Forge\\ForgeDaemon']);
    expect(calls).toContainEqual(['/Delete', '/TN', '\\Forge\\ForgeDaemon', '/F']);
    expect(fs.existsSync(path.join(cfgDir, 'forge-task.xml'))).toBe(false);
    expect(fs.existsSync(path.join(cfgDir, 'forge-daemon.cmd'))).toBe(false);
  });

  test('is a no-op when task is not installed and no files exist', () => {
    execFileSync.mockImplementation((cmd, args) => {
      if (args.includes('/Query')) {
        const e = new Error('not found'); e.status = 1; throw e;
      }
    });
    winTask.uninstall();
    const deleteCall = execFileSync.mock.calls.find(c => c[1].includes('/Delete'));
    expect(deleteCall).toBeUndefined();
  });
});
