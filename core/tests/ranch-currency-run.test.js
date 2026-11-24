const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * 牧场资产卡的「本次运行」增量。
 *
 * 口径与农场首页资产卡一致：进程内第一次观测即基线，之后只更新最新值；
 * 进程重启（= 重新 require）后从新基线重新累计，不落盘、不跨天归零。
 * 同时锁住「基线先于指纹去重落账」——否则余额没变的那次快照之后，
 * 进程内基线可能永远停在上一次的值。
 */
function loadStats(dir) {
    const mock = (name, exports) => {
        const id = require.resolve(`../dist/${name}`);
        require.cache[id] = { id, filename: id, loaded: true, exports };
    };
    mock('config/runtime-paths', { getDataDir: () => dir });
    const statsPath = require.resolve('../dist/services/ranch/stats');
    delete require.cache[statsPath];
    return require(statsPath);
}

function withAccount(id, run) {
    const previous = process.env.FARM_ACCOUNT_ID;
    process.env.FARM_ACCOUNT_ID = id;
    try {
        return run();
    }
    finally {
        if (previous === undefined) delete process.env.FARM_ACCOUNT_ID;
        else process.env.FARM_ACCOUNT_ID = previous;
    }
}

test('本次运行增量：首次观测为基线，涨跌都按基线算', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ranch-run-'));
    try {
        withAccount('acc-run-1', () => {
            const stats = loadStats(dir);

            stats.recordCurrencies({ 1007: 100, 1002: 50, 1008: 8, 7002: 3 });
            assert.deepEqual(stats.getRunCurrencies(), {
                1007: { baseline: 100, current: 100, delta: 0 },
                1002: { baseline: 50, current: 50, delta: 0 },
                1008: { baseline: 8, current: 8, delta: 0 },
                7002: { baseline: 3, current: 3, delta: 0 },
            });

            stats.recordCurrencies({ 1007: 130, 1002: 50, 1008: 5, 7002: 11 });
            const run = stats.getRunCurrencies();
            assert.equal(run['1007'].delta, 30);
            assert.equal(run['1002'].delta, 0);
            assert.equal(run['1008'].delta, -3, '消耗要能显示负增量');
            assert.equal(run['7002'].delta, 8);

            // 当日口径不受影响：仍以当天首次观测为基线。
            const day = stats.getToday().currencies;
            assert.deepEqual(day['1007'], { baseline: 100, current: 130 });
        });
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('本次运行增量：余额没变时基线仍然落账，重启后重新起算', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ranch-run-'));
    try {
        withAccount('acc-run-2', () => {
            const stats = loadStats(dir);
            stats.recordCurrencies({ 1007: 20 });
            stats.recordCurrencies({ 1007: 20 });
            assert.equal(stats.getRunCurrencies()['1007'].delta, 0);
            // 重复观测不会把基线抹掉，后续增长仍然相对第一次观测。
            stats.recordCurrencies({ 1007: 26 });
            assert.equal(stats.getRunCurrencies()['1007'].delta, 6);
        });

        // 重新 require = 进程重启：内存基线清空，第一次观测重新定基线。
        withAccount('acc-run-2', () => {
            const stats = loadStats(dir);
            stats.recordCurrencies({ 1007: 26 });
            assert.equal(stats.getRunCurrencies()['1007'].delta, 0, '重启后本次进度从 0 重新算');
            assert.equal(stats.getToday().currencies['1007'].baseline, 20, '当日基线走落盘，不随重启重置');
        });
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('本次运行增量：没有账号时不产生数据，前端据此隐藏「本次」行', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ranch-run-'));
    try {
        const previous = process.env.FARM_ACCOUNT_ID;
        delete process.env.FARM_ACCOUNT_ID;
        try {
            const stats = loadStats(dir);
            stats.recordCurrencies({ 1007: 10 });
            assert.deepEqual(stats.getRunCurrencies(), {});
        }
        finally {
            if (previous !== undefined) process.env.FARM_ACCOUNT_ID = previous;
        }
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('牧场概览快照把本次运行增量带给前端，并跟踪点券 1002', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/ranch/state.ts'), 'utf8');
    assert.match(source, /const TRACKED_CURRENCY_IDS = \[1007, 1002, 1008, 7002\] as const/);
    assert.match(source, /for \(const id of TRACKED_CURRENCY_IDS\)/);
    assert.match(source, /state\.currencyRun = stats\.getRunCurrencies\(\)/);
});
