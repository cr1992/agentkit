// @ts-check

const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 30;
const MAX_INTERVAL_SECONDS = 60 * 60;

/** @param {string} value */
function xmlEscape(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** @param {string} repositoryId */
export function launchAgentLabel(repositoryId) {
  const suffix = String(repositoryId)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, '')
    .slice(0, 32);
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
 * 选出要钉进 LaunchAgent 的 node 路径。纯函数：realpath 与 PATH 探测都由调用方注入以便单测。
 *
 * 规则：仅当 PATH 中第一个 `node` 与 process.execPath 指向同一真实文件（realpath 相等），且该 PATH
 * 路径本身不同于 execPath 时，才钉这个更稳定的 PATH 软链（典型 /opt/homebrew/bin/node →
 * /opt/homebrew/Cellar/node/<ver>/bin/node；node 升级后 Cellar 版本目录会被删，直接钉 execPath 会
 * spawn failed）；其余一律回退 execPath。realpath 抛错时同样 fail closed 回退 execPath。
 * @param {{execPath:string, pathNode:(string|null|undefined), realpath:(path:string)=>string}} input
 */
export function selectPinnedNodePath({ execPath, pathNode, realpath }) {
  if (!pathNode || pathNode === execPath) return execPath;
  try {
    if (realpath(pathNode) === realpath(execPath)) return pathNode;
  } catch {
    return execPath;
  }
  return execPath;
}

/**
 * 找 PATH 中第一个存在的 `node` 可执行文件路径；找不到返回 null。依赖注入以便单测。
 * @param {{pathEnv:(string|null|undefined), delimiter:string, join:(...parts:string[])=>string, existsSync:(path:string)=>boolean}} input
 */
export function resolveFirstPathNode({ pathEnv, delimiter, join, existsSync }) {
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'node');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 从 `launchctl print` 输出的 `arguments = { ... }` 块解析 ProgramArguments；解析不到返回 null。
 * 仅在已安装 plist 缺失、无法用 plutil 解析时作兜底。
 * @param {string} text
 */
export function parseLaunchctlProgramArguments(text) {
  if (!text) return null;
  const block = text.match(/arguments\s*=\s*\{([\s\S]*?)\}/u);
  if (!block) return null;
  const args = block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return args.length ? args : null;
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
    realpathSync,
    processEnv,
    delimiter,
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
    const identity = createIdentity ? ensureRepositoryIdentity(loaded.context) : readRepositoryIdentity(loaded.context);
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

  /** 本次 install 会钉的 node 路径：优先 PATH 稳定软链，否则回退 execPath。 */
  function resolvePinnedNodePath() {
    const pathNode = resolveFirstPathNode({ pathEnv: processEnv?.PATH ?? '', delimiter, join, existsSync });
    return selectPinnedNodePath({ execPath: processExecPath, pathNode, realpath: realpathSync });
  }

  /**
   * 读出已安装服务真正钉住的 ProgramArguments：优先用 plutil 解析 plist；plist 缺失（或解析失败）
   * 再退到 launchctl print 的 arguments 块；两者都不成立返回 null。
   * @param {{plist_path:string, service_target:string, working_directory:string}} value
   * @param {boolean} installed
   * @param {{ok:boolean, out:string}} probe
   */
  function readInstalledProgramArguments(value, installed, probe) {
    if (installed) {
      const converted = runFileCapture('/usr/bin/plutil', ['-convert', 'json', '-o', '-', value.plist_path], {
        cwd: value.working_directory,
      });
      if (converted.ok) {
        try {
          const parsed = JSON.parse(converted.stdout || converted.out || '');
          if (Array.isArray(parsed?.ProgramArguments) && parsed.ProgramArguments.length)
            return parsed.ProgramArguments.map((entry) => String(entry));
        } catch {
          // plutil 输出不可解析 → 落到 launchctl print 兜底。
        }
      }
    }
    if (probe.ok) {
      const parsed = parseLaunchctlProgramArguments(probe.out);
      if (parsed) return parsed;
    }
    return null;
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded */
  function watchServiceStatus(loaded) {
    if (processPlatform !== 'darwin') {
      return {
        supported: false,
        installed: false,
        loaded: false,
        platform: processPlatform,
        reason: 'macOS LaunchAgent adapter only',
      };
    }
    const value = descriptor(loaded, false);
    if (!value) {
      return {
        supported: true,
        installed: false,
        loaded: false,
        platform: processPlatform,
        reason: 'repository identity missing',
      };
    }
    const probe = runFileCapture('/bin/launchctl', ['print', value.service_target], {
      cwd: value.working_directory,
    });
    const installed = existsSync(value.plist_path);
    const jobLoaded = probe.ok;
    // 关键修复：program_available / stale 判定已安装服务里真正钉住的路径，而不是当前进程的 execPath。
    const installedArgs = readInstalledProgramArguments(value, installed, probe);
    const installedNodePath = installedArgs ? (installedArgs[0] ?? null) : null;
    const installedManagerScript = installedArgs ? (installedArgs[1] ?? null) : null;
    // 无任何安装（plist 与 job 都不在）时为 null；否则钉住的 node 与 manager 都在场才为 true。
    let programAvailable = null;
    if (installed || jobLoaded) {
      programAvailable = Boolean(
        installedNodePath &&
          installedManagerScript &&
          existsSync(installedNodePath) &&
          existsSync(installedManagerScript),
      );
    }
    const reasons = [];
    if (installed || jobLoaded) {
      if (!installed && jobLoaded) reasons.push('plist_missing_but_loaded');
      if (installedNodePath && !existsSync(installedNodePath)) reasons.push('pinned_node_missing');
      if (installedManagerScript && !existsSync(installedManagerScript)) reasons.push('pinned_manager_missing');
      if (installed && (!installedNodePath || !installedManagerScript)) reasons.push('program_arguments_unreadable');
    }
    // 钉的入口与本次调用的入口不同（例如从开发 checkout 运行、服务钉的是全局包）只是提示：
    // 两条路径都在时服务照常可用，不算 stale，也不让 doctor 报服务失效。
    const managerScriptMatchesCurrent = installedManagerScript ? installedManagerScript === managerScript : null;
    return {
      supported: true,
      installed,
      loaded: jobLoaded,
      platform: processPlatform,
      label: value.label,
      plist_path: value.plist_path,
      log_path: value.log_path,
      // node_path / manager_script 表示「本次 install 会钉的路径」，供与 installed_* 对照。
      node_path: resolvePinnedNodePath(),
      manager_script: managerScript,
      // installed_* 是已安装服务里真正钉住的路径（可能指向已被删除的旧 Node/旧包）。
      installed_node_path: installedNodePath,
      installed_manager_script: installedManagerScript,
      manager_script_matches_current: managerScriptMatchesCurrent,
      program_available: programAvailable,
      stale: reasons.length > 0,
      stale_reason: reasons.length ? reasons.join(', ') : null,
      reason: jobLoaded ? null : probe.out || 'launchd job not loaded',
    };
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {number} intervalSeconds */
  function install(loaded, intervalSeconds) {
    if (processPlatform !== 'darwin')
      die(`watch-service install 当前只支持 macOS；${processPlatform} 可继续手工运行 resume-all。`, 2);
    const value = descriptor(loaded, true);
    const nodePath = resolvePinnedNodePath();
    const plist = renderLaunchAgentPlist({
      label: value.label,
      nodePath,
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

    const wasLoaded = runFileCapture('/bin/launchctl', ['print', value.service_target], {
      cwd: value.working_directory,
    }).ok;
    if (wasLoaded) {
      const stopped = runFileCapture('/bin/launchctl', ['bootout', value.service_target], {
        cwd: value.working_directory,
      });
      if (!stopped.ok) {
        rmSync(temporary, { force: true });
        die(`无法重载现有 LaunchAgent：${stopped.out || 'launchctl bootout failed'}`);
      }
    }
    renameSync(temporary, value.plist_path);
    const started = runFileCapture('/bin/launchctl', ['bootstrap', value.domain, value.plist_path], {
      cwd: value.working_directory,
    });
    if (!started.ok) {
      if (previous === null) rmSync(value.plist_path, { force: true });
      else writeFileSync(value.plist_path, previous, { encoding: 'utf8', mode: 0o600 });
      if (wasLoaded && previous !== null)
        runFileCapture('/bin/launchctl', ['bootstrap', value.domain, value.plist_path], {
          cwd: value.working_directory,
        });
      die(`LaunchAgent 安装失败：${started.out || 'launchctl bootstrap failed'}`);
    }
    const kicked = runFileCapture('/bin/launchctl', ['kickstart', '-k', value.service_target], {
      cwd: value.working_directory,
    });
    if (!kicked.ok) die(`LaunchAgent 已加载但首次执行失败：${kicked.out || 'launchctl kickstart failed'}`);
    return { ...watchServiceStatus(loaded), interval_seconds: intervalSeconds };
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded */
  function uninstall(loaded) {
    if (processPlatform !== 'darwin') die(`watch-service uninstall 当前只支持 macOS；当前平台 ${processPlatform}。`, 2);
    const value = descriptor(loaded, false);
    if (!value) return { supported: true, installed: false, loaded: false, removed: false };
    const loadedBefore = runFileCapture('/bin/launchctl', ['print', value.service_target], {
      cwd: value.working_directory,
    }).ok;
    if (loadedBefore) {
      const stopped = runFileCapture('/bin/launchctl', ['bootout', value.service_target], {
        cwd: value.working_directory,
      });
      if (!stopped.ok) die(`LaunchAgent 停止失败：${stopped.out || 'launchctl bootout failed'}`);
    }
    const installedBefore = existsSync(value.plist_path);
    rmSync(value.plist_path, { force: true });
    return {
      supported: true,
      installed: false,
      loaded: false,
      removed: installedBefore || loadedBefore,
      label: value.label,
      plist_path: value.plist_path,
    };
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
      try {
        intervalSeconds = parseServiceInterval(flag(args.flags, 'interval-seconds'));
      } catch (error) {
        die(error instanceof Error ? error.message : String(error), 2);
      }
      result = install(loaded, intervalSeconds);
    } else if (action === 'uninstall') {
      result = uninstall(loaded);
    } else {
      result = watchServiceStatus(loaded);
    }
    if (args.flags.get('json')) console.log(JSON.stringify(result, null, 2));
    else if (action === 'install')
      log(
        `跨会话 watch-service 已安装 label=${result.label} interval=${result.interval_seconds}s node=${result.node_path}`,
      );
    else if (action === 'uninstall') log(`跨会话 watch-service ${result.removed ? '已卸载' : '原本未安装'}`);
    else {
      const parts = [`supported=${result.supported}`, `installed=${result.installed}`, `loaded=${result.loaded}`];
      if (result.supported && 'program_available' in result) {
        parts.push(`program_available=${result.program_available}`, `stale=${Boolean(result.stale)}`);
        if (result.stale_reason) parts.push(`stale_reason=${result.stale_reason}`);
      }
      if (result.reason) parts.push(`reason=${result.reason}`);
      log(`watch-service ${parts.join(' ')}`);
      if (result.stale) log('修复（照抄即可）：agentkit worktree watch-service install');
    }
  }

  return { cmdWatchService, watchServiceStatus };
}
