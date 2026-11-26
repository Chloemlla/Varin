const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function* installations(environment, architecture, run) {
  if (environment.VSINSTALLDIR) yield environment.VSINSTALLDIR;

  const programFilesX86 = environment['ProgramFiles(x86)'] || environment.ProgramFiles;
  const locator = path.join(programFilesX86, 'Microsoft Visual Studio/Installer/vswhere.exe');
  if (fs.existsSync(locator)) {
    const component = architecture === 'arm64' ? 'ARM64' : 'x86.x64';
    const registered = run(locator, ['-products', '*', '-requires', `Microsoft.VisualStudio.Component.VC.Tools.${component}`,
      '-property', 'installationPath', '-utf8'], { env: environment, encoding: 'utf8', windowsHide: true });
    yield* registered.trim().split(/\r?\n/).filter(Boolean);
  }

  // Build Tools can be present on disk without an instance in the Installer catalog.
  for (const base of new Set([programFilesX86, environment.ProgramFiles].filter(Boolean))) {
    const root = path.join(base, 'Microsoft Visual Studio');
    if (!fs.existsSync(root)) continue;
    for (const relative of fs.globSync('*/*/Common7/Tools/VsDevCmd.bat', { cwd: root })) {
      yield path.resolve(root, relative, '../../..');
    }
  }
}

function windowsMsvcEnvironment(architecture, environment = process.env, run = execFileSync) {
  if (environment.VSCMD_ARG_TGT_ARCH === architecture && environment.WindowsSdkDir && environment.INCLUDE) return environment;
  const host = process.arch === 'ia32' ? 'x86' : process.arch;
  for (const installation of installations(environment, architecture, run)) {
    const script = path.join(installation, 'Common7/Tools/VsDevCmd.bat');
    if (!fs.existsSync(script) || !fs.globSync(`VC/Tools/MSVC/*/bin/Host${host}/${architecture}/cl.exe`, { cwd: installation }).length) continue;

    // Keep the batch path quoted for cmd, then read its complete Unicode environment.
    const output = run('cmd.exe', ['/d', '/u', '/s', '/c', `call "%VARIN_VSDEVCMD%" -arch=${architecture} -host_arch=${host} >nul && set`], {
      env: { ...environment, VARIN_VSDEVCMD: script }, encoding: 'utf16le', windowsHide: true, windowsVerbatimArguments: true,
    });
    const result = {};
    for (const line of output.split(/\r?\n/)) {
      const split = line.indexOf('=');
      if (split > 0) result[line.slice(0, split)] = line.slice(split + 1);
    }
    delete result.VARIN_VSDEVCMD;
    return result;
  }
  throw new Error(`Cannot locate the Visual Studio C++ build tools for ${host} → ${architecture}. Install the C++ tools and Windows SDK, or set VSINSTALLDIR to an existing installation.`);
}

module.exports = { windowsMsvcEnvironment };
