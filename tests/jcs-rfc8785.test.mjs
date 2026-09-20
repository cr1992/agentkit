// RFC 8785（JCS）官方测试向量对 core/digest.mjs 的回归集。
//
// ADR-5 把 canonical JSON 定为零依赖本地实现，约束里写了「必须实现 RFC 8785 本身」。
// 向量全部内联，取自 RFC 8785 正文：§3.2.2 的输入样例、§3.2.4 给出的该样例规范化后的
// UTF-8 字节、§3.2.3 的属性排序样例，以及附录 B 的数值序列化表。
//
// 宣称的输入域（见 core/digest.mjs）：
// - strict=true（verify / loop 用）拒绝非有限 number 与未配对代理对，正对应 RFC 的两条
//   MUST-error 条款，因此 RFC 一致性断言全部跑在 strict kit 上；
// - strict=false（orchestrate / content-digest 用）是刻意保留的宽松档：它把 NaN / Infinity
//   按 JSON.stringify 的口径变成 null，并原样放行未配对代理对，两者都偏离 RFC。这里把宽松档
//   的现状一并锁住，让偏离可见；收敛严格度是一次独立决策，不在本用例范围内。
// - undefined / function / bigint / symbol 不在 canonical JSON 的输入域，两档都抛错。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDigestKit } from '../core/digest.mjs';

class JcsError extends Error {}

const strict = createDigestKit({ ValidationError: JcsError, strict: true });
const lenient = createDigestKit({ ValidationError: JcsError, strict: false });

/** IEEE 754 双精度的十六进制表示还原成 JS number（附录 B 的输入列就是这个形式）。 */
function ieee754(hex) {
  const view = new DataView(new ArrayBuffer(8));
  for (let index = 0; index < 8; index += 1) view.setUint8(index, Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
  return view.getFloat64(0, false);
}

// RFC 8785 §3.2.2「Serialization of Primitive Data Types」的输入样例，逐字照抄。
const SECTION_322_INPUT = `{
  "numbers": [333333333.33333329, 1E30, 4.50,
              2e-3, 0.000000000000000000000000001],
  "string": "\\u20ac$\\u000F\\u000aA'\\u0042\\u0022\\u005c\\\\\\"\\/",
  "literals": [null, true, false]
}`;

// RFC 8785 §3.2.4「UTF-8 Generation」：上面这份样例规范化后应产生的 UTF-8 字节。
// 用字节而不是字符串比对，是为了绕开转抄转义序列时最容易出错的那一层。
const SECTION_324_BYTES = `
  7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72
  75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a
  5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31
  65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37
  5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30
  30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d`.split(/\s+/u).filter(Boolean).join('');

test('RFC 8785 §3.2.2 + §3.2.4：样例规范化后逐字节等于 RFC 给出的 UTF-8 序列', () => {
  const canonical = strict.canonicalJson(JSON.parse(SECTION_322_INPUT));
  assert.equal(Buffer.from(canonical, 'utf8').toString('hex'), SECTION_324_BYTES);
});

// RFC 8785 §3.2.3「Sorting of Object Properties」的排序样例与期望顺序。
// 键覆盖控制字符、ASCII 数字、U+0080、拉丁扩展、货币符号、希伯来字母与星平面 emoji，
// 正好证伪"按 UTF-8 字节排序"和"按码点排序"这两种常见错误实现。
test('RFC 8785 §3.2.3：属性按 UTF-16 code unit 排序，含非 ASCII 与星平面键', () => {
  const sample = {
    '€': 'Euro Sign',
    '\r': 'Carriage Return',
    'דּ': 'Hebrew Letter Dalet With Dagesh',
    1: 'One',
    '😀': 'Emoji: Grinning Face',
    '': 'Control',
    'ö': 'Latin Small Letter O With Diaeresis',
  };
  const canonical = strict.canonicalJson(sample);
  const order = [...canonical.matchAll(/:"([^"]*)"/gu)].map((match) => match[1]);
  assert.deepEqual(order, [
    'Carriage Return',
    'One',
    'Control',
    'Latin Small Letter O With Diaeresis',
    'Euro Sign',
    'Emoji: Grinning Face',
    'Hebrew Letter Dalet With Dagesh',
  ]);
});

test('RFC 8785 §3.2.3：嵌套对象递归排序，数组元素顺序不变', () => {
  assert.equal(
    strict.canonicalJson({ b: 1, a: { d: [{ f: 2, e: 1 }, { h: 4, g: 3 }], c: 0 } }),
    '{"a":{"c":0,"d":[{"e":1,"f":2},{"g":3,"h":4}]},"b":1}',
  );
});

// RFC 8785 附录 B「Number Serialization Samples」。NaN 与 Infinity 两行没有 JSON 表示，
// 由下面单独的拒绝用例覆盖；其余各行全部在 JS number 可表示范围内，逐项断言。
const APPENDIX_B = [
  ['0000000000000000', '0', 'Zero'],
  ['8000000000000000', '0', 'Minus zero'],
  ['0000000000000001', '5e-324', 'Min pos number'],
  ['8000000000000001', '-5e-324', 'Min neg number'],
  ['7fefffffffffffff', '1.7976931348623157e+308', 'Max pos number'],
  ['ffefffffffffffff', '-1.7976931348623157e+308', 'Max neg number'],
  ['4340000000000000', '9007199254740992', 'Max pos int'],
  ['c340000000000000', '-9007199254740992', 'Max neg int'],
  ['4430000000000000', '295147905179352830000', '~2**68'],
  ['44b52d02c7e14af5', '9.999999999999997e+22', ''],
  ['44b52d02c7e14af6', '1e+23', ''],
  ['44b52d02c7e14af7', '1.0000000000000001e+23', ''],
  ['444b1ae4d6e2ef4e', '999999999999999700000', ''],
  ['444b1ae4d6e2ef4f', '999999999999999900000', ''],
  ['444b1ae4d6e2ef50', '1e+21', ''],
  ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7', ''],
  ['3eb0c6f7a0b5ed8d', '0.000001', ''],
  ['41b3de4355555553', '333333333.3333332', ''],
  ['41b3de4355555554', '333333333.33333325', ''],
  ['41b3de4355555555', '333333333.3333333', ''],
  ['41b3de4355555556', '333333333.3333334', ''],
  ['41b3de4355555557', '333333333.33333343', ''],
  ['becbf647612f3696', '-0.0000033333333333333333', ''],
  ['43143ff3c1cb0959', '1424953923781206.2', 'Round to even'],
];

test('RFC 8785 附录 B：数值序列化逐项匹配', () => {
  const mismatches = APPENDIX_B
    .map(([hex, expected, comment]) => ({ hex, expected, comment, actual: strict.canonicalJson(ieee754(hex)) }))
    .filter((row) => row.actual !== row.expected);
  assert.deepEqual(mismatches, []);
});

test('RFC 8785 §3.2.2.3：strict 档拒绝 NaN 与 Infinity；宽松档偏离 RFC，按 null 输出', () => {
  for (const hex of ['7fffffffffffffff', '7ff0000000000000']) {
    const value = ieee754(hex);
    assert.throws(() => strict.canonicalJson(value), JcsError);
    assert.equal(lenient.canonicalJson(value), 'null');
  }
  assert.throws(() => strict.canonicalJson(-Infinity), JcsError);
});

test('RFC 8785 §3.2.2.2：strict 档拒绝未配对代理对；宽松档偏离 RFC，原样转义放行', () => {
  for (const [input, escaped] of [
    ['\ud800', '"\\ud800"'],
    ['\udead', '"\\udead"'],
    ['a\ud83d', '"a\\ud83d"'],
    ['\ude00b', '"\\ude00b"'],
  ]) {
    assert.throws(() => strict.canonicalJson(input), JcsError);
    assert.equal(lenient.canonicalJson(input), escaped);
  }
  // 配对正确的星平面字符必须原样通过，不能被代理对校验误伤。
  assert.equal(strict.canonicalJson('😀'), '"😀"');
});

test('canonical JSON 的输入域之外一律抛错，不静默降级', () => {
  for (const kit of [strict, lenient]) {
    for (const value of [undefined, () => {}, 1n, Symbol('x')]) {
      assert.throws(() => kit.canonicalJson(value), JcsError);
    }
  }
});
