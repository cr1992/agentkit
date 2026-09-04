import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCHEMA_DIR = join(ROOT, 'schemas');
const SKILLS = ['orchestrate-subagents', 'manage-worktrees', 'verify-agent-output', 'run-agent-verify-loop'];
const names = () => readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.json')).sort();
const schema = (name) => JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf8'));

// 收敛前这里比较四个 Skill 各自携带的副本是否一致；收敛后只有一份 canonical 文件，
// 那类比较不再可能失败，真正要守的是「副本不会重新长回来」和「canonical 集合本身不漂移」。
test('公共 v1 envelope 只有一份 canonical schema，Skill 目录不再携带副本', () => {
  for (const skill of SKILLS) {
    assert.equal(existsSync(join(ROOT, skill, 'references', 'schemas')), false, `${skill} 重新携带了 schema 副本`);
  }
  for (const shared of [
    'artifact-ref-v1.schema.json',
    'review-result-v1.schema.json',
    'verification-profile-v1.schema.json',
    'reflection-record-v1.schema.json',
    'improvement-proposal-v1.schema.json',
    'task-contract-v1.schema.json',
  ]) {
    assert.ok(existsSync(join(SCHEMA_DIR, shared)), `缺少 canonical schema ${shared}`);
  }
});

test('canonical schema 集合无重名、无重复 $id', () => {
  const all = names();
  assert.equal(all.length, 17, `canonical schema 数量应为 17，实际 ${all.length}`);
  assert.equal(new Set(all).size, all.length);
  const ids = all.map((name) => schema(name).$id);
  for (const id of ids) assert.equal(typeof id, 'string');
  assert.equal(new Set(ids).size, ids.length, '存在重复 $id');
});

test('所有公开 schema 均声明 draft 2020-12 且可由标准 JSON 解析', () => {
  for (const name of names()) {
    assert.equal(schema(name).$schema, 'https://json-schema.org/draft/2020-12/schema', name);
  }
});

test('Task Contract v1 保留全部必填字段', () => {
  const required = [...schema('task-contract-v1.schema.json').required].sort();
  for (const field of ['schema_version', 'contract_id', 'objective', 'scope', 'acceptance', 'permissions', 'environment', 'skill_set', 'stop_conditions', 'extensions', 'contract_digest']) {
    assert.equal(required.includes(field), true, field);
  }
});

test('Batch Result schema 与 runtime 共享合同摘要和环境元数据门禁', () => {
  const value = schema('batch-result-v1.schema.json');
  const passedOrFailed = value.allOf[0].then.properties.evidence_manifest.allOf[1].properties;
  assert.equal(passedOrFailed.contract_digest.$ref, '#/$defs/digest');

  const environment = value.$defs.check.properties.environment;
  const [identifierRule, sensitiveRule] = environment.propertyNames.allOf;
  assert.equal(new RegExp(identifierRule.pattern).test('os_version'), true);
  assert.equal(new RegExp(identifierRule.pattern).test('OS_VERSION'), false);
  assert.equal(new RegExp(sensitiveRule.not.pattern).test('api_key'), true);
  const stringValue = environment.additionalProperties.oneOf.find((item) => item.type === 'string');
  assert.equal(stringValue.maxLength, 500);
  assert.equal(new RegExp(stringValue.pattern).test('ios simulator'), true);
  assert.equal(new RegExp(stringValue.pattern).test('line1\nline2'), false);
});
