/**
 * 面板在线更新与版本回滚。
 *
 * 这条链路最容易「看起来对、其实不能用」：真的跑一次更新要拉代码、构建、重启，
 * 还得赌网络。所以把可验证的部分全部拆出来做单元测试：
 *   - 归档目录的命名/解析/快照/恢复/清理（release-layout，纯文件系统）
 *   - 归档列表的配对与兼容性判定（release-store）
 *   - 更新服务的各种拒绝路径（脏工作区、无上游、任务在跑、不支持的运行形态）
 * 真正「按下按钮」的那一步由执行器 `tools/farm-release.mjs` 负责，这里只做静态护栏。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const layout = require('../dist/services/release-layout');
const releaseStore = require('../dist/services/release-store');
const { createSystemUpdateService } = require('../dist/services/system-update');

const REPO_ROOT = path.join(__dirname, '..', '..');

function read(relative) {
    return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/** 造一个最小可用的假仓库：core/client.js + core/dist + web/dist + version.json。 */
function makeFakeRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-release-'));
    const write = (relative, content) => {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
    };
    write('core/client.js', '// entry\n');
    write('core/dist/config/config.js', "const DEFAULT_CLIENT_VERSION = '1.17.0.3_20261117';\nconst DEFAULT_WX_CLIENT_VERSION = '1.17.0.6_20261117';\n");
    write('core/dist/index.js', '// compiled\n');
    write('web/dist/index.html', '<html></html>\n');
    write('version.json', JSON.stringify({ version: '1.0.0', build: 1 }));
    // 一键更新要求仓库里存在执行器；没有它 applySupported 直接为 false，就测不到后面的拒绝路径。
    write('tools/farm-release.mjs', '// stub\n');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    return root;
}

function cleanup(root) {
    fs.rmSync(root, { recursive: true, force: true });
}

test('release-layout：目录名可生成也可反向解析', () => {
    const stamp = layout.formatStamp(new Date(Date.UTC(2026, 10, 24, 12, 30, 45)));
    assert.equal(stamp, '20261124123045');

    const id = layout.buildReleaseId('backend', stamp, 'abc1234');
    assert.equal(id, 'backend-20261124123045-abc1234');

    const parsed = layout.parseReleaseId(id);
    assert.ok(parsed);
    assert.equal(parsed.kind, 'backend');
    assert.equal(parsed.shortCommit, 'abc1234');
    assert.equal(parsed.createdAt, Date.UTC(2026, 10, 24, 12, 30, 45));

    assert.equal(layout.parseReleaseId('not-a-release'), null);
    assert.equal(layout.parseReleaseId('backend-bogus'), null);
    assert.ok(layout.isValidReleaseId('web', 'web-20261124123045-abc1234'));
    assert.ok(!layout.isValidReleaseId('web', 'backend-20261124123045-abc1234'));
});

test('release-layout：快照与恢复是互逆的', () => {
    const root = makeFakeRepo();
    try {
        const snap = layout.snapshotRelease({
            repoRoot: root,
            kind: 'backend',
            commit: 'abcdef1234567890',
            shortCommit: 'abcdef1',
            commitSubject: '测试提交',
            version: '1.0.0',
            build: 1,
            stamp: '20261124123045',
        });
        assert.equal(snap.releaseId, 'backend-20261124123045-abcdef1');
        assert.ok(fs.existsSync(path.join(snap.dir, 'client.js')));
        assert.ok(fs.existsSync(path.join(snap.dir, 'dist', 'index.js')));
        assert.equal(snap.meta.commitSubject, '测试提交');
        assert.ok(snap.meta.artifactSizeBytes > 0);

        // 破坏现场再恢复，验证产物确实被覆盖回去了。
        fs.rmSync(path.join(root, 'core', 'dist'), { recursive: true, force: true });
        fs.writeFileSync(path.join(root, 'core', 'client.js'), '// 被改坏了\n', 'utf8');

        const restored = layout.restoreRelease({ repoRoot: root, releaseId: snap.releaseId });
        assert.equal(restored.kind, 'backend');
        assert.ok(fs.existsSync(path.join(root, 'core', 'dist', 'index.js')), 'dist 应该被恢复');
        assert.equal(fs.readFileSync(path.join(root, 'core', 'client.js'), 'utf8'), '// entry\n');
    }
    finally {
        cleanup(root);
    }
});

test('release-layout：缺产物时拒绝归档，并给出缺了哪些', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-release-empty-'));
    try {
        assert.throws(
            () => layout.snapshotRelease({ repoRoot: root, kind: 'backend', commit: 'x', shortCommit: 'x' }),
            (err) => {
                assert.equal(err.code, 'RELEASE_ARTIFACTS_MISSING');
                assert.match(err.message, /core\/client\.js/);
                return true;
            },
        );
    }
    finally {
        cleanup(root);
    }
});

test('release-layout：激活状态记住 active / previous / history，且不会把同一个重复计入历史', () => {
    const root = makeFakeRepo();
    try {
        const runtimeDir = layout.resolveRuntimeDir(root);
        layout.activateRelease(runtimeDir, 'backend', 'backend-20261124123045-aaaaaaa');
        layout.activateRelease(runtimeDir, 'backend', 'backend-20261124124045-bbbbbbb');
        let state = layout.readActiveState(runtimeDir);
        assert.equal(state.backend.active, 'backend-20261124124045-bbbbbbb');
        assert.equal(state.backend.previous, 'backend-20261124123045-aaaaaaa');
        assert.deepEqual(state.backend.history, ['backend-20261124124045-bbbbbbb', 'backend-20261124123045-aaaaaaa']);

        // 重复激活同一个版本不应影响 previous。
        layout.activateRelease(runtimeDir, 'backend', 'backend-20261124124045-bbbbbbb');
        state = layout.readActiveState(runtimeDir);
        assert.equal(state.backend.previous, 'backend-20261124123045-aaaaaaa');
        assert.deepEqual(state.backend.history, ['backend-20261124124045-bbbbbbb', 'backend-20261124123045-aaaaaaa']);
    }
    finally {
        cleanup(root);
    }
});

test('release-layout：只保留最近 N 个版本，但绝不删当前运行的', () => {
    const root = makeFakeRepo();
    try {
        const runtimeDir = layout.resolveRuntimeDir(root);
        const releasesDir = layout.resolveReleasesDir(root);
        for (let i = 0; i < 4; i += 1) {
            layout.snapshotRelease({
                repoRoot: root,
                kind: 'backend',
                commit: `commit${i}`,
                shortCommit: `sha000${i}`,
                version: '1.0.0',
                build: i,
                stamp: `2026112412304${i}`,
            });
        }
        const activeId = 'backend-20261124123040-sha0000';
        layout.activateRelease(runtimeDir, 'backend', activeId);

        // keep=1 本应只留最新的那个，但 active 是最旧的，必须一起保住。
        const removed = layout.pruneReleases({
            releasesDir,
            keep: 1,
            active: layout.readActiveState(runtimeDir),
        });
        const remaining = layout.listReleaseDirs(releasesDir).map((item) => item.releaseId);
        assert.ok(remaining.includes(activeId), '当前运行版本不能被清理');
        assert.ok(remaining.includes('backend-20261124123043-sha0003'), '最新版本要保留');
        assert.equal(removed.length, 2);
    }
    finally {
        cleanup(root);
    }
});

test('release-store：后端与前端按同一次构建配对，兼容性按客户端版本判定', () => {
    const root = makeFakeRepo();
    try {
        const runtimeDir = layout.resolveRuntimeDir(root);
        const shared = {
            repoRoot: root,
            commit: 'abcdef1234567890',
            shortCommit: 'abcdef1',
            commitSubject: '同一次构建',
            version: '9.9.9',
            build: 9,
            stamp: '20261124123045',
        };
        layout.snapshotRelease({ ...shared, kind: 'backend' });
        layout.snapshotRelease({ ...shared, kind: 'web' });
        layout.activateRelease(runtimeDir, 'backend', 'backend-20261124123045-abcdef1');
        layout.activateRelease(runtimeDir, 'web', 'web-20261124123045-abcdef1');

        const snapshot = releaseStore.listReleases({ repoRoot: root });
        assert.equal(snapshot.releases.length, 2);

        const backend = snapshot.releases.find((item) => item.kind === 'backend');
        const web = snapshot.releases.find((item) => item.kind === 'web');
        assert.equal(backend.pairedReleaseId, 'web-20261124123045-abcdef1');
        assert.equal(web.pairedReleaseId, 'backend-20261124123045-abcdef1');
        assert.ok(backend.isActive);
        assert.equal(backend.canRollback, false, '当前运行版本不能回滚到自己');
        assert.ok(backend.compat.compatible, '和当前运行版本同源，应当判为兼容');
        assert.equal(snapshot.summary.activeVersion, '9.9.9');
        assert.equal(snapshot.summary.totalCount, 2);
        assert.equal(snapshot.summary.orphanWebCount, 0);
    }
    finally {
        cleanup(root);
    }
});

test('release-store：客户端版本不同时标记为不兼容，但不阻断回滚', () => {
    const root = makeFakeRepo();
    try {
        // 先造一个「当前运行版本」，让下面这个旧版本处于可回滚位置。
        layout.snapshotRelease({
            repoRoot: root,
            kind: 'backend',
            commit: 'fedcba9876543210',
            shortCommit: 'fedcba9',
            version: '2.0.0',
            build: 2,
            stamp: '20261124124045',
        });
        layout.activateRelease(layout.resolveRuntimeDir(root), 'backend', 'backend-20261124124045-fedcba9');

        const dir = path.join(layout.resolveReleasesDir(root), 'backend-20261124123045-abcdef1');
        fs.mkdirSync(path.join(dir, 'dist', 'config'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'client.js'), '// old\n', 'utf8');
        fs.writeFileSync(
            path.join(dir, 'dist', 'config', 'config.js'),
            "const DEFAULT_CLIENT_VERSION = '1.0.0.1_20260101';\nconst DEFAULT_WX_CLIENT_VERSION = '1.0.0.2_20260101';\n",
            'utf8',
        );
        fs.writeFileSync(path.join(dir, 'release-meta.json'), JSON.stringify({
            releaseId: 'backend-20261124123045-abcdef1',
            kind: 'backend',
            commit: 'abcdef1234567890',
            shortCommit: 'abcdef1',
            version: '1.0.0',
            build: 1,
            createdAt: Date.now(),
        }), 'utf8');

        const snapshot = releaseStore.listReleases({ repoRoot: root });
        const item = snapshot.releases.find((entry) => entry.releaseId === 'backend-20261124123045-abcdef1');
        assert.ok(item);
        assert.equal(item.compat.compatible, false);
        assert.match(item.compat.reasons.join(''), /QQ 客户端版本不同/);
        // 不兼容只是「风险提示」，归档完整就仍然允许回滚，由用户二次确认。
        assert.equal(item.canRollback, true);
        assert.equal(snapshot.summary.incompatibleCount, 1);
    }
    finally {
        cleanup(root);
    }
});

test('release-store：时间戳不同但提交相同也能配对，且前端沿用后端的兼容性结论', () => {
    const root = makeFakeRepo();
    try {
        // 历史归档里真的出现过「后端 04:46:53 / 前端 04:46:59」这种跨秒的情况，
        // 只按时间戳配对会让前端永远显示「没有配套版本」，从而无法一起回滚。
        layout.snapshotRelease({
            repoRoot: root,
            kind: 'backend',
            commit: 'abcdef1234567890',
            shortCommit: 'abcdef1',
            version: '1.0.0',
            build: 1,
            stamp: '20261124044653',
        });
        layout.snapshotRelease({
            repoRoot: root,
            kind: 'web',
            commit: 'abcdef1234567890',
            shortCommit: 'abcdef1',
            version: '1.0.0',
            build: 1,
            stamp: '20261124044659',
        });

        const snapshot = releaseStore.listReleases({ repoRoot: root });
        const backend = snapshot.releases.find((item) => item.kind === 'backend');
        const web = snapshot.releases.find((item) => item.kind === 'web');
        assert.equal(backend.pairedReleaseId, 'web-20261124044659-abcdef1');
        assert.equal(web.pairedReleaseId, 'backend-20261124044653-abcdef1');
        assert.ok(web.compat.compatible, '前端归档没有 config.js，不能因此判成不兼容');
        assert.equal(snapshot.summary.orphanWebCount, 0);
    }
    finally {
        cleanup(root);
    }
});

test('release-store：没有 active 记录时把最新版本当作当前版本，避免面板出现「无一在运行」', () => {
    const root = makeFakeRepo();
    try {
        layout.snapshotRelease({
            repoRoot: root,
            kind: 'backend',
            commit: 'aaaaaaa1111',
            shortCommit: 'aaaaaaa',
            version: '1.0.0',
            build: 1,
            stamp: '20261124123045',
        });
        const snapshot = releaseStore.listReleases({ repoRoot: root });
        const active = snapshot.releases.filter((item) => item.isActive);
        assert.equal(active.length, 1);
        assert.equal(active[0].releaseId, 'backend-20261124123045-aaaaaaa');
    }
    finally {
        cleanup(root);
    }
});

/** 构造一个可控的 git 假实现：按命令返回预设输出。 */
function fakeGit(responses) {
    const calls = [];
    const execGit = async (cwd, args) => {
        const key = args.join(' ');
        calls.push(key);
        for (const [pattern, value] of responses) {
            if (key.includes(pattern)) {
                if (value instanceof Error) throw value;
                return value;
            }
        }
        return '';
    };
    return { execGit, calls };
}

function makeService(root, responses) {
    const { execGit, calls } = fakeGit(responses);
    const service = createSystemUpdateService({
        repoRoot: root,
        runtimeDir: path.join(root, 'core', 'runtime'),
        releasesDir: path.join(root, 'releases'),
        isPackaged: false,
        execGit,
        spawnRunner: () => {
            throw new Error('测试里不应该真的拉起执行器');
        },
    });
    return { service, calls };
}

const BASE_GIT = [
    ['rev-parse --is-inside-work-tree', 'true\n'],
    ['rev-parse --abbrev-ref --symbolic-full-name', 'origin/master\n'],
    ['rev-parse --abbrev-ref HEAD', 'master\n'],
    ['rev-parse --short=7 HEAD', 'abc1234\n'],
    ['rev-parse HEAD', 'abcdef1234567890abcdef1234567890abcdef12\n'],
    ['log -1 --format=%s', '修复某处\n'],
    ['status --porcelain', ''],
    ['rev-list --left-right --count', '0\t0\n'],
];

test('system-update：非 git 目录直接给出「不支持」的原因，而不是抛错', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-release-nogit-'));
    try {
        const service = createSystemUpdateService({
            repoRoot: root,
            runtimeDir: path.join(root, 'runtime'),
            releasesDir: path.join(root, 'releases'),
            isPackaged: false,
            execGit: async () => {
                throw new Error('should not run');
            },
        });
        const status = await service.getStatus();
        assert.equal(status.gitSupported, false);
        assert.match(status.unsupportedReason, /没有找到 git 仓库/);
        assert.equal(status.canApply, false);
    }
    finally {
        cleanup(root);
    }
});

test('system-update：工作区脏时拒绝一键更新，不拉起执行器', async () => {
    const root = makeFakeRepo();
    try {
        const { service } = makeService(root, [
            ...BASE_GIT.filter(([pattern]) => pattern !== 'status --porcelain'),
            ['status --porcelain', ' M core/src/index.ts\n'],
        ]);
        await assert.rejects(
            () => service.applyUpdate({ pullFirst: true }),
            (err) => {
                assert.equal(err.code, 'DIRTY_WORKTREE');
                assert.match(err.message, /未提交改动/);
                return true;
            },
        );
    }
    finally {
        cleanup(root);
    }
});

test('system-update：没有跟踪远端分支时拒绝更新', async () => {
    const root = makeFakeRepo();
    try {
        const { service } = makeService(root, [
            ...BASE_GIT.filter(([pattern]) => pattern !== 'rev-parse --abbrev-ref --symbolic-full-name'),
            ['rev-parse --abbrev-ref --symbolic-full-name', new Error('no upstream')],
        ]);
        await assert.rejects(
            () => service.applyUpdate({ pullFirst: true }),
            (err) => {
                assert.equal(err.code, 'NO_UPSTREAM');
                return true;
            },
        );
    }
    finally {
        cleanup(root);
    }
});

test('system-update：代码已是最新且运行的也是它时，拒绝空更新', async () => {
    const root = makeFakeRepo();
    try {
        const { service } = makeService(root, BASE_GIT);
        // 让 startupCommit 与 HEAD 相同（默认实现就是这么读的）。
        await service.getStatus();
        await assert.rejects(
            () => service.applyUpdate({ pullFirst: true }),
            (err) => {
                assert.equal(err.code, 'NOTHING_TO_APPLY');
                return true;
            },
        );
    }
    finally {
        cleanup(root);
    }
});

test('system-update：作业状态写着 running 但进程已死时，判定为失败并落盘', async () => {
    const root = makeFakeRepo();
    try {
        const runtimeDir = path.join(root, 'core', 'runtime');
        fs.mkdirSync(runtimeDir, { recursive: true });
        layout.writeJsonAtomic(path.join(runtimeDir, 'update-job.json'), {
            id: 'upd_dead',
            action: 'update',
            // 一个几乎不可能存在的 pid：判定逻辑必须看 pid 活性，而不是只看状态位。
            pid: 999999,
            status: 'running',
            phase: '构建前端',
            startedAt: Date.now() - 60000,
            updatedAt: Date.now() - 30000,
            recentLines: ['[阶段] 构建前端'],
        });
        const service = createSystemUpdateService({
            repoRoot: root,
            runtimeDir,
            releasesDir: path.join(root, 'releases'),
            isPackaged: false,
            execGit: fakeGit(BASE_GIT).execGit,
        });
        const job = service.readJob();
        assert.equal(job.status, 'failed');
        assert.match(job.error, /更新进程已退出/);
        const persisted = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'update-job.json'), 'utf8'));
        assert.equal(persisted.status, 'failed', '尸检结果要落盘，否则面板会一直转圈');
    }
    finally {
        cleanup(root);
    }
});

test('system-update：回滚必须选后端版本，且运行中/归档缺失的不给回滚', async () => {
    const root = makeFakeRepo();
    try {
        const runtimeDir = layout.resolveRuntimeDir(root);
        const shared = {
            repoRoot: root,
            commit: 'abcdef1234567890',
            shortCommit: 'abcdef1',
            version: '1.0.0',
            build: 1,
            stamp: '20261124123045',
        };
        layout.snapshotRelease({ ...shared, kind: 'backend' });
        layout.snapshotRelease({ ...shared, kind: 'web' });
        layout.activateRelease(runtimeDir, 'backend', 'backend-20261124123045-abcdef1');

        const { service } = makeService(root, BASE_GIT);
        await assert.rejects(
            () => service.rollback({ releaseId: 'web-20261124123045-abcdef1' }),
            (err) => {
                assert.equal(err.code, 'WRONG_RELEASE_KIND');
                return true;
            },
        );
        await assert.rejects(
            () => service.rollback({ releaseId: 'backend-20261124123045-abcdef1' }),
            (err) => {
                assert.equal(err.code, 'RELEASE_NOT_ROLLBACKABLE');
                return true;
            },
        );
        await assert.rejects(
            () => service.rollback({ releaseId: 'backend-20200101000000-deadbee' }),
            (err) => {
                assert.equal(err.code, 'RELEASE_NOT_FOUND');
                return true;
            },
        );
    }
    finally {
        cleanup(root);
    }
});

test('system-update：删除版本时保护运行中与上一版', async () => {
    const root = makeFakeRepo();
    try {
        const runtimeDir = layout.resolveRuntimeDir(root);
        for (const stamp of ['20261124123040', '20261124123041', '20261124123042']) {
            layout.snapshotRelease({
                repoRoot: root,
                kind: 'backend',
                commit: `commit-${stamp}`,
                shortCommit: `sha${stamp.slice(-2)}`,
                version: '1.0.0',
                build: 1,
                stamp,
            });
        }
        layout.activateRelease(runtimeDir, 'backend', 'backend-20261124123040-sha40');
        layout.activateRelease(runtimeDir, 'backend', 'backend-20261124123041-sha41');

        const { service } = makeService(root, BASE_GIT);
        // 运行中（sha41）与上一版（sha40）都不能删。
        for (const protectedId of ['backend-20261124123041-sha41', 'backend-20261124123040-sha40']) {
            await assert.rejects(
                () => service.deleteReleases({ releaseIds: [protectedId] }),
                (err) => {
                    assert.equal(err.code, 'RELEASE_NOT_DELETABLE');
                    return true;
                },
            );
        }
        const result = await service.deleteReleases({ releaseIds: ['backend-20261124123042-sha42'] });
        assert.deepEqual(result.deleted, ['backend-20261124123042-sha42']);
        assert.ok(result.freedBytes > 0);
    }
    finally {
        cleanup(root);
    }
});

test('执行器与后端共用同一份目录布局实现，不允许各自复制一套命名规则', () => {
    const runner = read('tools/farm-release.mjs');
    assert.match(runner, /release-layout\.js/, '执行器必须 require release-layout.js，而不是自己拼目录名');
    assert.ok(
        !/backend-\\d\{14\}/.test(runner),
        '执行器里不该出现第二套 releaseId 正则',
    );
    // 执行器必须能脱离父进程运行：detached 由后端负责，这里守住关键调用形态。
    const service = read('core/src/services/system-update.ts');
    assert.match(service, /detached: true/, '后端拉起执行器时必须 detached');
    assert.match(service, /child\.unref\(\)/, '必须 unref，否则后端退出会带走执行器');
});

test('启动脚本与忽略规则：运行时目录不能污染工作区', () => {
    const gitignore = read('.gitignore');
    assert.match(gitignore, /^releases\/$/m, 'releases/ 必须忽略，否则脏工作区检查永远过不了');
    assert.match(gitignore, /^core\/runtime\/$/m, 'core/runtime/ 必须忽略');
});

test('执行器有稳定副本：回滚到没有 tools/farm-release.mjs 的旧版本也删不掉它', () => {
    const root = makeFakeRepo();
    try {
        // 真实仓库里执行器依赖这份布局实现，副本要把它一起搬过去。
        const layoutSource = path.join(root, 'core', 'src', 'services', 'release-layout.js');
        fs.mkdirSync(path.dirname(layoutSource), { recursive: true });
        fs.writeFileSync(layoutSource, '// layout stub\n', 'utf8');

        const first = layout.installStableRunner(root);
        assert.equal(first.installed, true);
        assert.equal(first.updated, true, '首次安装必须写盘');
        assert.equal(first.runnerPath, path.join(root, 'core', 'runtime', 'runner', 'farm-release.mjs'));
        assert.ok(fs.existsSync(first.runnerPath), '副本要落在 core/runtime/runner 下');
        assert.ok(fs.existsSync(first.layoutPath), '布局实现要跟着搬，执行器才能完全脱离工作树');
        assert.equal(layout.locateRunner(root), first.runnerPath, '有副本时优先用副本');

        // 内容没变就不重写，避免每次拉起都把 mtime 刷掉。
        const second = layout.installStableRunner(root);
        assert.equal(second.installed, true);
        assert.equal(second.updated, false);

        // 模拟回滚：git reset 到还没有执行器的旧提交，tools/ 下的源码整目录消失。
        fs.rmSync(path.join(root, 'tools'), { recursive: true, force: true });
        const third = layout.installStableRunner(root);
        assert.equal(third.installed, false, '源码没了要如实报告，但不能抛错');
        assert.match(third.reason, /farm-release\.mjs/);
        assert.ok(fs.existsSync(first.runnerPath), '副本必须还在');
        assert.equal(layout.locateRunner(root), first.runnerPath);
    }
    finally {
        cleanup(root);
    }
});

test('执行器先自举到稳定目录再干活，避免回滚时把自己删掉', () => {
    const runner = read('tools/farm-release.mjs');
    assert.match(runner, /installStableRunner\(/, '干活之前必须先安装稳定副本');
    assert.match(runner, /STABLE_MARK/, '要有递归保护标记，否则会不断重启自己');

    const bootstrapAt = runner.indexOf('await ensureRunningFromStableCopy()');
    const jobAt = runner.indexOf('const currentJob = readJob()');
    assert.ok(bootstrapAt > 0, '必须真的调用自举');
    assert.ok(bootstrapAt < jobAt, '自举要早于读作业状态，否则父进程会先写脏作业状态再退出');
});

test('后端拉起的是稳定副本，不是工作树里的执行器', () => {
    const service = read('core/src/services/system-update.ts');
    assert.match(service, /layout\.installStableRunner\(/, '拉起前刷新副本');
    assert.match(service, /layout\.locateRunner\(/, '拉起路径必须走 locateRunner');
});

test('重启成功的判据是接口能答话，而不是 pid 还活着', () => {
    const runner = read('tools/farm-release.mjs');
    assert.match(runner, /\/api\/game-version/, '必须探测这个接口：它不需要鉴权，还带运行版本号');
    assert.match(runner, /async function probeService/);
    assert.match(runner, /shellAlive/, 'Windows 上 pid 文件里是 MSYS pid，必须交给 shell 再判一次');
    assert.match(
        runner,
        /if \(shell && isAlive\(recorded\)/,
        'pid 文件里有活进程就走 stop.sh，不能要求它与调用方 pid 相等（会退化成只杀父进程）',
    );
});

test('路由挂载：接口挂在管理端鉴权之后', () => {
    const routes = read('core/src/controllers/admin/system-update-routes.ts');
    assert.match(routes, /app\.use\('\/api\/system-update', createAuthRequired\(ctx\)\)/, '必须先过鉴权');
    for (const endpoint of ['/status', '/check', '/apply', '/rollback', '/job', '/releases/delete']) {
        assert.ok(routes.includes(`/api/system-update${endpoint}`), `缺少接口 ${endpoint}`);
    }
    const index = read('core/src/controllers/admin/index.ts');
    assert.match(index, /mountSystemUpdateRoutes\(app, ctx\)/, '路由要在 index.ts 里挂上');
    assert.match(index, /createSystemUpdateSafely/, '服务初始化失败必须降级，不能拖垮管理端');
});

test('前端入口 HTML 必须每次回源，否则更新后浏览器还在跑旧 bundle', () => {
    const index = read('core/src/controllers/admin/index.ts');
    assert.match(index, /no-cache, no-store, must-revalidate/, 'index.html 要禁用缓存');
});
