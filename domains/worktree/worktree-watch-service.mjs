// @ts-check

const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 60 * 60;

/** @param {string} value */
function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** @param {string} repositoryId */
export function launchAgentLabel(repositoryId) {
  const suffix = String(repositoryId).toLowerCase().replaceAll(/[^a-z0-9]/gu, '').slice(0, 32);
  if (!suffix) throw new Error('repository id 不能生成 launchd label。');
  return `io.github.cr1992.agentkit.worktree.${suffix}`;
}

/**
 * 生成固定 argv 的 LaunchAgent；不经过 shell，也不把调用会话的环境变量或凭证写进 plist。
 * @param {{label:string,nodePath:string,managerScript:string,workingDirectory:string,intervalSeconds:number,logPath:string,configPath?:string|null}} options
 */
export function renderLaunchAgentPlist(options) {
  const args = [options.nodePath, options.managerScript, 'resume-all', '--quiet'];
  if (options.configPath) args.push('--config', options.configPath);
  const argumentXml = args.map((arg) => `      <string>${xmlEscape(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(options.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(options.workingDirectory)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${options.intervalSeconds}</integer>
    <key>AbandonProcessGroup</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(options.logPath)}</string>
  </dict>
</plist>
`;
}

/** @param {unknown} raw */
export function parseServiceInterval(raw) {
  const value = raw === null || raw === undefined ? DEFAULT_INTERVAL_SECONDS : Number(raw);
  if (!Number.isInteger(value) || value < MIN_INTERVAL_SECONDS || value > MAX_INTERVAL_SECONDS) {
    throw new Error(`--interval-seconds 必须是 ${MIN_INTERVAL_SECONDS}-${MAX_INTERVAL_SECONDS} 的整数。`);
  }
  return value;
}

/**
 * @param {Record<string,any>} deps
 */
export function createCommands(deps) {
  const {
    processPlatform,
    processExecPath,
    processGetuid,
    homedir,
    randomUUID,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
    dirname,
    join,
    managerScript,
    runFileCapture,
    loadRepositoryProfile,
    readRepositoryIdentity,
    ensureRepositoryIdentity,
    traceLayout,
    flag,
    rejectUnknownFlags,
    die,
    log,
  } = deps;

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {boolean} createIdentity */
  function descriptor(loaded, createIdentity) {
    const identity = createIdentity
      ? ensureRepositoryIdentity(loaded.context)
      : readRepositoryIdentity(loaded.context);
    if (!identity) return null;
    const label = launchAgentLabel(identity.repository_id);
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const logPath = join(traceLayout(loaded.context.common_dir).root, 'watch-service.log');
    const uid = processGetuid();
    return {
      label,
      plist_path: plistPath,
      log_path: logPath,
      domain: `gui/${uid}`,
      service_target: `gui/${uid}/${label}`,
      working_directory: loaded.context.primary_worktree,
      config_path: loaded.profile_source === 'explicit' ? loaded.profile_path : null,
    };
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded */
  function watchServiceStatus(loaded) {
    if (processPlatform !== 'darwin') {
      return { supported: false, installed: false, loaded: false, platform: processPlatform, reason: 'macOS LaunchAgent adapter only' };
    }
    const value = descriptor(loaded, false);
    if (!value) {
      return { supported: true, installed: false, loaded: false, platform: processPlatform, reason: 'repository identity missing' };
    }
    const probe = runFileCapture('/bin/launchctl', ['print', value.service_target], { cwd: loaded.context.primary_worktree });
    return {
      supported: true,
      installed: existsSync(value.plist_path),
      loaded: probe.ok,
      platform: processPlatform,
      label: value.label,
      plist_path: value.plist_path,
      log_path: value.log_path,
      node_path: processExecPath,
      manager_script: managerScript,
      program_available: existsSync(processExecPath) && existsSync(managerScript),
      reason: probe.ok ? null : (probe.out || 'launchd job not loaded'),
    };
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {number} intervalSeconds */
  function install(loaded, intervalSeconds) {
    if (processPlatform !== 'darwin') die(`watch-service install 当前只支持 macOS；${processPlatform} 可继续手工运行 resume-all。`, 2);
    const value = descriptor(loaded, true);
    const plist = renderLaunchAgentPlist({
      label: value.label,
      nodePath: processExecPath,
      managerScript,
      workingDirectory: value.working_directory,
      intervalSeconds,
      logPath: value.log_path,
      configPath: value.config_path,
    });
    mkdirSync(dirname(value.plist_path), { recursive: true });
    mkdirSync(dirname(value.log_path), { recursive: true });
    const previous = existsSync(value.plist_path) ? readFileSync(value.plist_path, 'utf8') : null;
    const temporary = `${value.plist_path}.${processGetuid()}.${randomUUID()}.tmp`;
    writeFileSync(temporary, plist, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

    const wasLoaded = runFileCapture('/bin/launchctl', ['print', value.service_target], { cwd: value.working_directory }).ok;
    if (wasLoaded) {
      const stopped = runFileCapture('/bin/launchctl', ['bootout', value.service_target], { cwd: value.working_directory });
      if (!stopped.ok) {
        rmSync(temporary, { force: true });
        die(`无法重载现有 LaunchAgent：${stopped.out || 'launchctl bootout failed'}`);
      }
    }
    renameSync(temporary, value.plist_path);
    const started = runFileCapture('/bin/launchctl', ['bootstrap', value.domain, value.plist_path], { cwd: value.working_directory });
    if (!started.ok) {
      if (previous === null) rmSync(value.plist_path, { force: true });
      else writeFileSync(value.plist_path, previous, { encoding: 'utf8', mode: 0o600 });
      if (wasLoaded && previous !== null) runFileCapture('/bin/launchctl', ['bootstrap', value.domain, value.plist_path], { cwd: value.working_directory });
      die(`LaunchAgent 安装失败：${started.out || 'launchctl bootstrap failed'}`);
    }
    const kicked = runFileCapture('/bin/launchctl', ['kickstart', '-k', value.service_target], { cwd: value.working_directory });
    if (!kicked.ok) die(`LaunchAgent 已加载但首次执行失败：${kicked.out || 'launchctl kickstart failed'}`);
    return { ...watchServiceStatus(loaded), interval_seconds: intervalSeconds };
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded */
  function uninstall(loaded) {
    if (processPlatform !== 'darwin') die(`watch-service uninstall 当前只支持 macOS；当前平台 ${processPlatform}。`, 2);
    const value = descriptor(loaded, false);
    if (!value) return { supported: true, installed: false, loaded: false, removed: false };
    const loadedBefore = runFileCapture('/bin/launchctl', ['print', value.service_target], { cwd: value.working_directory }).ok;
    if (loadedBefore) {
      const stopped = runFileCapture('/bin/launchctl', ['bootout', value.service_target], { cwd: value.working_directory });
      if (!stopped.ok) die(`LaunchAgent 停止失败：${stopped.out || 'launchctl bootout failed'}`);
    }
    const installedBefore = existsSync(value.plist_path);
    rmSync(value.plist_path, { force: true });
    return { supported: true, installed: false, loaded: false, removed: installedBefore || loadedBefore, label: value.label, plist_path: value.plist_path };
  }

  function cmdWatchService(args) {
    rejectUnknownFlags(args.flags, ['json', 'config', 'interval-seconds']);
    const action = args.positionals[0] ?? 'status';
    if (args.positionals.length > 1 || !['install', 'status', 'uninstall'].includes(action)) {
      die('watch-service 用法：watch-service install|status|uninstall [--json] [--interval-seconds <seconds>]', 2);
    }
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    let result;
    if (action === 'install') {
      let intervalSeconds;
      try { intervalSeconds = parseServiceInterval(flag(args.flags, 'interval-seconds')); }
      catch (error) { die(error instanceof Error ? error.message : String(error), 2); }
      result = install(loaded, intervalSeconds);
    } else if (action === 'uninstall') {
      result = uninstall(loaded);
    } else {
      result = watchServiceStatus(loaded);
    }
    if (args.flags.get('json')) console.log(JSON.stringify(result, null, 2));
    else if (action === 'install') log(`跨会话 watch-service 已安装 label=${result.label} interval=${result.interval_seconds}s`);
    else if (action === 'uninstall') log(`跨会话 watch-service ${result.removed ? '已卸载' : '原本未安装'}`);
    else log(`watch-service supported=${result.supported} installed=${result.installed} loaded=${result.loaded}${result.reason ? ` reason=${result.reason}` : ''}`);
  }

  return { cmdWatchService, watchServiceStatus };
}
