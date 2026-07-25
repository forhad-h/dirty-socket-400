'use strict';

/**
 * End-to-end test of the browser simulator, driven with Playwright.
 *
 * Boots the static server, loads the page in real Chromium, drives both modes
 * through full playback, and asserts on what is actually rendered — socket
 * states, the wire inspector's byte split, the event log, the verdict. Fails
 * loudly on any console error.
 *
 *   npm run test:e2e            headless
 *   npm run test:e2e -- --shots writes screenshots to screenshots/
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 4179;
const URL = `http://127.0.0.1:${PORT}/`;
const SHOTS = process.argv.includes('--shots');

let chromium;
try {
    ({ chromium } = require('playwright'));
} catch {
    console.error('\n  This test needs Playwright:\n\n    npm install\n    npx playwright install chromium\n');
    process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, extra) {
    if (cond) {
        console.log(`  ✓ ${name}`);
    } else {
        failures += 1;
        console.log(`  ✗ ${name}${extra ? '\n      ' + extra : ''}`);
    }
}

async function main() {
    const server = spawn(process.execPath, [path.join(__dirname, 'serve-web.js')], {
        env: { ...process.env, PORT: String(PORT) },
        stdio: 'ignore',
    });
    await wait(700);

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    const consoleErrors = [];
    page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    await page.goto(URL, { waitUntil: 'load' });

    console.log('\n── page load ──');
    check('title renders', (await page.title()).includes('Dirty Socket'));
    check(
        'provenance shows real capture metadata',
        /Node v\d+/.test(await page.textContent('#provenance')),
        await page.textContent('#provenance')
    );

    if (SHOTS) {
        fs.mkdirSync(path.join(ROOT, 'screenshots'), { recursive: true });
    }

    // ---------------------------------------------------------- broken
    console.log('\n── broken mode ──');
    await page.click('.mode[data-mode="broken"]');

    const brokenSteps = await page.evaluate(() => window.__TRACES.broken.steps.length);
    check('scrub max matches trace length', (await page.textContent('#scrub-max')) === String(brokenSteps));

    // Drive to the end via the scrub control (deterministic, no timing races).
    await page.fill('#scrub', String(brokenSteps));
    await page.dispatchEvent('#scrub', 'input');
    await wait(150);

    const brokenPool = await page.textContent('#pool');
    const brokenWire = await page.textContent('#wire-view');
    const brokenVerdict = await page.textContent('#verdict-status');
    const brokenWireLabel = await page.textContent('#wire-b-label');
    const brokenLogCount = await page.locator('#log li').count();

    check('verdict shows the real 400', brokenVerdict.includes('400 Bad Request'), brokenVerdict);
    check('verdict panel is visible', await page.isVisible('#verdict'));
    check('wire label reads "Dirty Socket" at some point', true); // asserted mid-timeline below
    check('event log replayed every step', brokenLogCount === brokenSteps, `${brokenLogCount} vs ${brokenSteps}`);
    check(
        'wire inspector shows the swallowed bytes',
        brokenWire.includes('swallowed as request') && brokenWire.includes('POST /chat-stream HTTP/1.'),
        brokenWire.slice(0, 120)
    );
    check(
        'wire inspector shows the stitched body',
        brokenWire.includes('{"message":"Hello",'),
        brokenWire.slice(0, 120)
    );
    check('socket pool rendered', brokenPool.includes('sock-'), brokenPool.slice(0, 80));

    // Mid-timeline: the dirty-socket state must actually appear.
    const dirtyIdx = await page.evaluate(() =>
        window.__TRACES.broken.steps.findIndex((s) => s.kind === 'proxy:abandon-upstream') + 1
    );
    await page.fill('#scrub', String(dirtyIdx));
    await page.dispatchEvent('#scrub', 'input');
    await wait(120);

    check('wire is labelled "Dirty Socket" after the abandon', (await page.textContent('#wire-b-label')) === 'Dirty Socket');
    check('socket is badged mid-message', (await page.textContent('#pool')).includes('mid-message'));
    check('socket shows outstanding body bytes', /still owes \d+ body bytes/.test(await page.textContent('#pool')));

    if (SHOTS) {
        await page.fill('#scrub', String(brokenSteps));
        await page.dispatchEvent('#scrub', 'input');
        await wait(200);
        await page.screenshot({ path: path.join(ROOT, 'screenshots', 'broken.png'), fullPage: true });
    }

    // ----------------------------------------------------------- fixed
    console.log('\n── fixed mode ──');
    await page.click('.mode[data-mode="fixed"]');
    await wait(120);

    const fixedSteps = await page.evaluate(() => window.__TRACES.fixed.steps.length);
    await page.fill('#scrub', String(fixedSteps));
    await page.dispatchEvent('#scrub', 'input');
    await wait(150);

    const fixedVerdict = await page.textContent('#verdict-status');
    const fixedPool = await page.textContent('#pool');
    const fixedLogCount = await page.locator('#log li').count();

    check('verdict shows the real 200', fixedVerdict.includes('200 OK'), fixedVerdict);
    check('event log replayed every step', fixedLogCount === fixedSteps, `${fixedLogCount} vs ${fixedSteps}`);
    check('a socket was destroyed', fixedPool.includes('destroyed'), fixedPool.slice(0, 120));
    check('a second, clean socket was used', (fixedPool.match(/sock-/g) || []).length >= 2, fixedPool.slice(0, 120));
    check('no socket is left owing bytes', !/still owes/.test(fixedPool));

    if (SHOTS) {
        await page.screenshot({ path: path.join(ROOT, 'screenshots', 'fixed.png'), fullPage: true });
    }

    // ------------------------------------------------------- playback
    console.log('\n── transport controls ──');
    await page.click('#btn-reset');
    await wait(100);
    check('reset returns to frame 0', (await page.textContent('#scrub-idx')) === '0');

    await page.click('#btn-step');
    await wait(100);
    check('step advances one frame', (await page.textContent('#scrub-idx')) === '1');

    await page.click('#btn-play');
    await wait(400);
    const playingIdx = parseInt(await page.textContent('#scrub-idx'), 10);
    check('play advances the timeline', playingIdx > 1, `idx=${playingIdx}`);
    await page.click('#btn-play'); // pause

    // ------------------------------------------------------ responsive
    console.log('\n── responsive + console ──');
    await page.setViewportSize({ width: 390, height: 844 });
    await wait(200);
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    check('no horizontal overflow at 390px', overflow <= 1, `overflow=${overflow}px`);

    if (SHOTS) {
        await page.screenshot({ path: path.join(ROOT, 'screenshots', 'mobile.png'), fullPage: true });
    }

    check('no console errors', consoleErrors.length === 0, consoleErrors.join('\n      '));

    await browser.close();
    server.kill();

    console.log(
        failures === 0
            ? '\n  All checks passed.\n'
            : `\n  ${failures} check(s) failed.\n`
    );
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
