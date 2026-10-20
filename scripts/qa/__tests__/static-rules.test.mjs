import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runStaticCheck, stripComments } from '../lib/static-rules.mjs';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../static-check.mjs', import.meta.url));

async function makeFixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dssaas-qa-static-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return root;
}

async function withFixture(files, fn) {
  const root = await makeFixture(files);
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const rulesOf = (result) => result.violations.map((v) => v.rule);

describe('CT-01 金额单位', () => {
  test('命中 _micro_cny', async () => {
    await withFixture(
      { 'apps/api/src/price.ts': 'export const p = row.price_micro_cny;\n' },
      async (root) => {
        const result = await runStaticCheck({ root, ruleSets: ['contracts'] });
        assert.equal(result.ok, false);
        assert.deepEqual(rulesOf(result), ['CT-01']);
        assert.match(result.violations[0].message, /_cents/);
        assert.equal(result.violations[0].line, 1);
      },
    );
  });

  test('_cents 不命中', async () => {
    await withFixture(
      { 'apps/api/src/price.ts': 'export const p = row.price_cents;\n' },
      async (root) => {
        const result = await runStaticCheck({ root, ruleSets: ['contracts'] });
        assert.equal(result.ok, true, JSON.stringify(result.violations));
      },
    );
  });
});

describe('CT-02 model_route 作用域建模', () => {
  test('命中 scope_value', async () => {
    await withFixture(
      { 'packages/core/src/route.ts': "const key = { scope: 'role', scope_value: 'ops' };\n" },
      async (root) => {
        const result = await runStaticCheck({ root, ruleSets: ['contracts'] });
        assert.equal(result.ok, false);
        assert.ok(rulesOf(result).includes('CT-02'));
      },
    );
  });

  test('命中 Prisma model_route 的 scope_ref 换名规避', async () => {
    const schema = `model ModelRoute {\n  id String @id\n  scope String\n  scopeRef String? @map("scope_ref")\n  purpose String\n  @@map("model_route")\n}\n`;
    await withFixture({ 'packages/db/prisma/schema.prisma': schema }, async (root) => {
      const result = await runStaticCheck({ root, ruleSets: ['contracts'] });
      assert.equal(result.ok, false);
      assert.equal(rulesOf(result).filter((r) => r === 'CT-02').length, 2);
    });
  });

  test('命中 SQL model_route 的旧列', async () => {
    const sql = `CREATE TABLE "model_route" (\n    "id" UUID NOT NULL,\n    "scope" TEXT,\n    "scope_ref" TEXT,\n    PRIMARY KEY ("id")\n);\n`;
    await withFixture({ 'packages/db/prisma/migrations/0001_init/migration.sql': sql }, async (root) => {
      const result = await runStaticCheck({ root, ruleSets: ['contracts'] });
      assert.equal(result.ok, false);
      assert.equal(rulesOf(result).filter((r) => r === 'CT-02').length, 2);
      assert.equal(result.violations[0].line, 3);
    });
  });

  test('拆列后通过', async () => {
    const schema = `model ModelRoute {\n  id String @id\n  scopeType String @map("scope_type")\n  scopeRoleId String? @map("scope_role_id")\n  scopeUserId String? @map("scope_user_id")\n  @@map("model_route")\n}\n`;
    await withFixture({ 'packages/db/prisma/schema.prisma': schema }, async (root) => {
      const result = await runStaticCheck({ root, ruleSets: ['contracts'] });
      assert.equal(result.ok, true, JSON.stringify(result.violations));
    });
  });
});

describe('CT-03 判定值词表', () => {
  test('命中 Prisma enum 中的 revise / block', async () => {
    const schema = `enum JudgmentVerdict {\n  pass\n  revise\n  block\n}\n`;
    await withFixture({ 'packages/db/prisma/schema.prisma': schema }, async (root) => {
      const result = await runStaticCheck({ root, ruleSets: ['contracts'] });
      assert.equal(result.ok, false);
      const hits = result.violations.filter((v) => v.rule === 'CT-03');
      assert.equal(hits.length, 2);
      assert.ok(hits.some((v) => v.line === 3));
      assert.ok(hits.some((v) => v.line === 4));
    });
  });

  test('命中 verdict 对象字面量', async () => {
    await withFixture(
      { 'apps/api/src/judge.ts': "export const verdict = { verdict: 'revise' };\n" },
      async (root) => {
        const result = await runStaticCheck({ root, ruleSets: ['contracts'] });
        assert.equal(result.ok, false);
        assert.ok(rulesOf(result).includes('CT-03'));
      },
    );
  });

  test('blocker / display:block / rollback 不误报', async () => {
    const code = `const severity = 'blocker';\nconst css = { display: 'block' };\nfunction rollback() {}\n`;
    await withFixture({ 'apps/api/src/ui.ts': code }, async (root) => {
      const result = await runStaticCheck({ root, ruleSets: ['contracts'] });
      assert.equal(result.ok, true, JSON.stringify(result.violations));
    });
  });
});

describe('CT-05 状态字段命名与 workflow state 词表', () => {
  test('命中 workflow_run.status / listing.state', async () => {
    const schema = `model WorkflowRun {\n  id String @id\n  status String\n  state String @default("pending")\n  @@map("workflow_run")\n}\n\nmodel Listing {\n  id String @id\n  status String @default("draft")\n  state String?\n  @@map("listing")\n}\n`;
    await withFixture({ 'packages/db/prisma/schema.prisma': schema }, async (root) => {
      const result = await runStaticCheck({ root, ruleSets: ['contracts'] });
      assert.equal(result.ok, false);
      const hits = result.violations.filter((v) => v.rule === 'CT-05');
      assert.equal(hits.length, 2);
    });
  });

  test('命中非法 workflow state 默认值 queued', async () => {
    const schema = `model WorkflowRun {\n  id String @id\n  state String @default("queued")\n  stage String?\n  @@map("workflow_run")\n}\n`;
    await withFixture({ 'packages/db/prisma/schema.prisma': schema }, async (root) => {
      const result = await runStaticCheck({ root, ruleSets: ['contracts'] });
      assert.equal(result.ok, false);
      assert.match(result.violations[0].message, /queued/);
    });
  });

  test('命中 SQL workflow_run 旧列与旧枚举', async () => {
    const sql = `CREATE TABLE "workflow_run" (\n    "id" UUID NOT NULL,\n    "state" "WorkflowState" NOT NULL DEFAULT 'draft',\n    "status" TEXT,\n    PRIMARY KEY ("id")\n);\n`;
    await withFixture({ 'packages/db/prisma/migrations/0001_init/migration.sql': sql }, async (root) => {
      const result = await runStaticCheck({ root, ruleSets: ['contracts'] });
      assert.equal(result.ok, false);
      const hits = result.violations.filter((v) => v.rule === 'CT-05');
      assert.ok(hits.length >= 2, JSON.stringify(hits));
    });
  });

  test('对齐 docs/21 的 schema 通过', async () => {
    const schema = `model WorkflowRun {\n  id String @id\n  state String @default("pending")\n  stage String?\n  @@map("workflow_run")\n}\n\nmodel Listing {\n  id String @id\n  status String @default("draft")\n  platformState String? @map("platform_state")\n  @@map("listing")\n}\n`;
    await withFixture({ 'packages/db/prisma/schema.prisma': schema }, async (root) => {
      const result = await runStaticCheck({ root, ruleSets: ['contracts'] });
      assert.equal(result.ok, true, JSON.stringify(result.violations));
    });
  });
});

describe('BD 边界规则（docs/15 §10）', () => {
  test('BD-01 命中 .jsonl 字符串', async () => {
    await withFixture(
      { 'apps/api/src/session.ts': "export const f = 'runtime/session.jsonl';\n" },
      async (root) => {
        const result = await runStaticCheck({ root, ruleSets: ['boundaries'] });
        assert.equal(result.ok, false);
        assert.deepEqual(rulesOf(result), ['BD-01']);
      },
    );
  });

  test('BD-01 说明性注释不误报', async () => {
    await withFixture(
      { 'apps/api/src/session.ts': '// 业务代码禁止读 .jsonl（说明性注释）\nexport const x = 1;\n' },
      async (root) => {
        const result = await runStaticCheck({ root, ruleSets: ['boundaries'] });
        assert.equal(result.ok, true, JSON.stringify(result.violations));
      },
    );
  });

  test('BD-02 命中 DSH_HOME / dsh-data', async () => {
    await withFixture(
      { 'packages/core/src/paths.ts': 'export const home = process.env.DSH_HOME;\nexport const d = "/var/lib/dsh-data";\n' },
      async (root) => {
        const result = await runStaticCheck({ root, ruleSets: ['boundaries'] });
        assert.equal(result.ok, false);
        assert.equal(rulesOf(result).filter((r) => r === 'BD-02').length, 2);
      },
    );
  });

  test('BD-03 命中 storage-json import，且不重复报 BD-02', async () => {
    await withFixture(
      { 'apps/api/src/storage.ts': "import { open } from '@deepseek-ai/dsh-storage-json';\n" },
      async (root) => {
        const result = await runStaticCheck({ root, ruleSets: ['boundaries'] });
        assert.deepEqual(rulesOf(result), ['BD-03']);
      },
    );
  });

  test('BD-04 业务代码 import @prisma/client 命中，packages/db 豁免', async () => {
    await withFixture(
      {
        'apps/api/src/db.ts': "import { PrismaClient } from '@prisma/client';\n",
        'packages/db/src/index.ts': "export { PrismaClient } from '@prisma/client';\n",
      },
      async (root) => {
        const result = await runStaticCheck({ root, ruleSets: ['boundaries'] });
        assert.equal(result.ok, false);
        assert.deepEqual(rulesOf(result), ['BD-04']);
        assert.match(result.violations[0].file, /apps\/api/);
      },
    );
  });

  test('BD-05 业务目录 .sql 命中，packages/db 豁免', async () => {
    await withFixture(
      {
        'apps/api/sql/adhoc.sql': 'SELECT 1;\n',
        'packages/db/prisma/migrations/0001_init/migration.sql': 'CREATE TABLE "x" ("id" UUID);\n',
      },
      async (root) => {
        const result = await runStaticCheck({ root, ruleSets: ['boundaries'] });
        assert.equal(result.ok, false);
        assert.deepEqual(rulesOf(result), ['BD-05']);
        assert.match(result.violations[0].file, /apps\/api/);
      },
    );
  });

  test('BD-06 浏览器自动化依赖命中', async () => {
    await withFixture(
      { 'apps/web/package.json': JSON.stringify({ name: 'web', devDependencies: { playwright: '^1.0.0' } }, null, 2) },
      async (root) => {
        const result = await runStaticCheck({ root, ruleSets: ['boundaries'] });
        assert.equal(result.ok, false);
        assert.deepEqual(rulesOf(result), ['BD-06']);
      },
    );
  });

  test('BD-01 行号在块注释后仍准确（注释剥离不破坏偏移）', async () => {
    const code = '/*\n multi\n line\n*/\nexport const f = "a.jsonl";\n';
    await withFixture({ 'apps/api/src/x.ts': code }, async (root) => {
      const result = await runStaticCheck({ root, ruleSets: ['boundaries'] });
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].line, 5);
      assert.match(stripComments(code, '.ts').split('\n')[4], /a\.jsonl/);
    });
  });
});

describe('CLI 与退出码', () => {
  test('有违规时退出码 1 且输出规则编号', async () => {
    await withFixture({ 'apps/api/src/bad.ts': "export const f = 'x.jsonl';\n" }, async (root) => {
      const error = await execFileAsync(process.execPath, [CLI, '--root', root, '--boundaries']).catch((e) => e);
      assert.equal(error.code, 1);
      assert.match(String(error.stdout), /BD-01/);
      assert.match(String(error.stdout), /CI 必须失败/);
    });
  });

  test('干净仓库退出码 0', async () => {
    await withFixture({ 'apps/api/src/ok.ts': 'export const priceCents = 100;\n' }, async (root) => {
      const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root]);
      assert.match(stdout, /通过：0 处违规/);
    });
  });

  test('--json 输出可解析', async () => {
    await withFixture({ 'apps/api/src/bad.ts': "export const f = 'x.jsonl';\n" }, async (root) => {
      const error = await execFileAsync(process.execPath, [CLI, '--root', root, '--json']).catch((e) => e);
      const parsed = JSON.parse(String(error.stdout));
      assert.equal(parsed.ok, false);
      assert.equal(parsed.violations[0].rule, 'BD-01');
      assert.ok(Array.isArray(parsed.enabledRules));
    });
  });
});
