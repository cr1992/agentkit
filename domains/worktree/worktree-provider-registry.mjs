// @ts-check

// change-request provider 注册表：按名分发适配器，并向 Profile 校验暴露合法 provider 名清单。
// worktree 通用层只依赖本模块，不 import 任何具体 worktree-provider-<平台>.mjs。

import { ChangeRequestSubmitError } from './worktree-provider-contract.mjs';
import { gitlabChangeRequestProvider } from './worktree-provider-gitlab.mjs';

export { ChangeRequestSubmitError } from './worktree-provider-contract.mjs';

/** @typedef {import('./worktree-provider-contract.mjs').ChangeRequestProvider} ChangeRequestProvider */

/**
 * manual：登记在册但没有 submit 能力的一项。声明为合法 provider（Profile 可选它），
 * 但 `submit`/`precheck` 为 null，走仓库自己的人工 change request 流程。
 * @type {ChangeRequestProvider}
 */
const manualChangeRequestProvider = {
  name: 'manual',
  precheck: null,
  submit: null,
  SubmitError: ChangeRequestSubmitError,
};

/** 新增适配器只需在此登记一行；provider 名清单与分发都从这里派生。 */
const PROVIDERS = [manualChangeRequestProvider, gitlabChangeRequestProvider];

const PROVIDER_BY_NAME = new Map(PROVIDERS.map((adapter) => [adapter.name, adapter]));

/** 合法 provider 名清单（含 manual），供 Profile 校验使用。 */
export const CHANGE_REQUEST_PROVIDER_NAMES = PROVIDERS.map((adapter) => adapter.name);

/**
 * 按名解析 change-request 适配器。
 * @param {string} name
 * @returns {ChangeRequestProvider|null}
 */
export function resolveChangeRequestProvider(name) {
  return PROVIDER_BY_NAME.get(name) ?? null;
}
