// @ts-check
// 按耗时把用例分片，供多容器并行跑。
//
// 为什么不按编号均分：一轮 33 个会话串行要 105 分钟，其中第 4、5、7 条就占 61 分钟
// （issue #15 的后续项 4）。均分编号会把它们堆到同一片上，那一片自己就是串行时长的一多半，
// 并行等于白做。所以按 `cases.mjs` 里的 `weight`（一次会话的粗略秒数）装箱。
//
// 算法是 LPT（longest processing time first）贪心：耗时从大到小，每条丢进当前最轻的那一片。
// 对这个规模（11 条、2–4 片）它离最优足够近，而且是确定性的——同一组输入永远分出同一份结果，
// 分片之间因此可比，也能在测试里钉住。
//
// ⚠️ 分片只改「谁跟谁一起跑」，不改任何判定口径。合并后的报告必须与串行报告逐项相等，
// `tests/shard.test.mjs` 拿回放驱动器把这件事跑出来对一遍。

/**
 * 解析 `--shard i/n`。
 * @param {string} spec
 * @returns {{ index: number, total: number }} index 从 1 起。
 */
export function parseShardSpec(spec) {
  const match = /^(\d+)\s*\/\s*(\d+)$/u.exec(String(spec).trim());
  if (!match) throw new Error(`--shard 要写成 i/n（例如 1/3），收到 ${spec}`);
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1) throw new Error('--shard 的 n 必须 ≥ 1');
  if (index < 1 || index > total) throw new Error(`--shard 的 i 必须在 1..${total} 之间，收到 ${index}`);
  return { index, total };
}

/**
 * 把用例装进 `total` 个箱子，按 `weight` 均衡。
 *
 * 每片内部按用例 id 升序返回，和不分片时的顺序一致——报告的逐条明细因此不会因为
 * 分片而换一个排法。
 *
 * @param {Array<{ id: number, weight?: number }>} cases
 * @param {number} total
 * @returns {Array<Array<any>>} 长度恒为 total；用例比片还少时后面的片是空的。
 */
export function planShards(cases, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error('分片数必须是正整数');
  /** @type {Array<{ load: number, items: any[] }>} */
  const bins = Array.from({ length: total }, () => ({ load: 0, items: [] }));
  // 排序要稳定且与输入顺序无关：先按耗时降序，同耗时按 id 升序。
  const ordered = [...cases].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.id - b.id);
  for (const item of ordered) {
    let lightest = bins[0];
    for (const bin of bins) if (bin.load < lightest.load) lightest = bin;
    lightest.items.push(item);
    lightest.load += item.weight ?? 0;
  }
  return bins.map((bin) => bin.items.sort((a, b) => a.id - b.id));
}

/**
 * 取某一片。
 * @param {Array<{ id: number, weight?: number }>} cases
 * @param {{ index: number, total: number }} shard
 */
export function selectShard(cases, { index, total }) {
  return planShards(cases, total)[index - 1] ?? [];
}

/** 每片的耗时合计，报告与排障用。 */
export function shardLoads(cases, total) {
  return planShards(cases, total).map((items) => items.reduce((sum, item) => sum + (item.weight ?? 0), 0));
}
