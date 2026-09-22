// @ts-check

// change-request 适配器契约：错误基类与接口 typedef。刻意独立成模块，避免注册表和具体
// 适配器之间因「适配器 extends 基类、注册表 import 适配器」形成 import 环——基类放在
// 无依赖的这里，注册表与各适配器都只单向依赖它。

/**
 * change-request 适配器的错误基类；各适配器的错误类继承它并带稳定 `code`。
 * 通用错误处理（worktree-mgr）只认这个基类，不感知任何具体平台。
 */
export class ChangeRequestSubmitError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ChangeRequestSubmitError';
    this.code = code;
  }
}

/**
 * 提交上下文：只携带已解析好的值与「执行固定 argv」的函数。适配器不 spawn 进程、
 * 不读环境变量、不碰 token；一切外部调用都经由注入的 gitTry / runFileCapture。
 * @typedef {Object} ChangeRequestSubmitContext
 * @property {string} remote 目标 remote 名
 * @property {string} sourceBranch 源分支
 * @property {string} targetBranch 目标分支
 * @property {string} headSha 待提交的 head SHA
 * @property {string} title change request 标题
 * @property {string|null} description change request 描述
 * @property {Record<string, any>} changeRequest Profile 的 change_request 段
 * @property {string} cwd record 路径（git 命令的工作目录）
 * @property {(args: string[], cwd?: string, options?: {timeoutMs?: number}) => {ok: boolean, out: string}} gitTry
 * @property {(command: string, args: string[], options?: {cwd?: string, timeoutMs?: number}) => any} runFileCapture
 * @property {number} fetchTimeoutMs ls-remote 等只读探测的超时
 * @property {number} submitPushTimeoutMs 提交 push 的超时
 */

/**
 * 提交结果：由通用层据此写 trace、arm watcher 并回显。
 * @typedef {Object} ChangeRequestSubmitResult
 * @property {boolean} ok 是否提交成功
 * @property {string|null} change_ref 稳定的 change 引用（URL 或退化文案）
 * @property {string|null} url 平台返回的 change request URL（可空）
 * @property {string|null} detail 失败时的诊断细节
 * @property {string} message 成功时回显、失败时用于 die 的整段文案
 */

/**
 * change-request 适配器接口。`precheck`/`submit` 为 null 表示该 provider 没有该能力
 * （例如 manual 只登记、不提交）。
 * @typedef {Object} ChangeRequestProvider
 * @property {string} name provider 名，与 Profile 取值一致
 * @property {((ctx: ChangeRequestSubmitContext) => string|null)|null} precheck
 *   平台特有前置检查；返回拒绝原因字符串，或 `null` 表示通过
 * @property {((ctx: ChangeRequestSubmitContext) => ChangeRequestSubmitResult)|null} submit
 *   执行提交；`null` 表示无提交能力
 * @property {typeof ChangeRequestSubmitError} SubmitError 该适配器的错误类
 */
