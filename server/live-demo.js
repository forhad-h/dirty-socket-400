'use strict';

/**
 * The same scenario, run through the actual libraries.
 *
 * `raw-repro.js` proves the protocol mechanism with zero dependencies. This
 * file closes the remaining gap: it puts a real Express app in front of the
 * real upstream and runs the abort-then-follow-up sequence twice —
 *
 *   A. express-http-proxy      — no explicit abort handling
 *   B. http-proxy-middleware   — with proxyReq.destroy() on client disconnect
 *
 * It measures abort propagation: after the client aborts mid-upload, is the
 * upstream left holding a half-read request?
 *
 * HONEST RESULT, so you are not surprised when you run it: over a direct
 * localhost hop on Node 18+, BOTH variants pass. Destroying the client socket
 * tears down the piped upstream request on its own, and both follow-ups return
 * 200. This script does not manufacture a difference that is not there.
 *
 * The explicit destroy earns its keep when something keeps the upstream socket
 * alive independently of the client socket — an intermediary in the middle, or
 * a keep-alive agent under concurrency that reuses the socket before teardown
 * completes. `raw-repro.js` shows what happens then, deterministically.
 *
 * Requires `npm install`.
 */

const http = require('http');
const { createUpstream } = require('./upstream');

let express, ehp, hpm;
try {
    express = require('express');
    ehp = require('express-http-proxy');
    hpm = require('http-proxy-middleware');
} catch (err) {
    console.error('\n  This demo needs the optional dependencies:\n\n    npm install\n');
    process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** One socket to the upstream, so reuse is guaranteed rather than lucky. */
function makeAgent() {
    return new http.Agent({ keepAlive: true, maxSockets: 1 });
}

// ---------------------------------------------------------------- proxies

function buildAbandoningProxy(targetOrigin) {
    const app = express();
    const agent = makeAgent();

    // No abort handling — the library gives us no hook for it, and this is
    // exactly how the streaming routes were originally mounted.
    app.use(
        '/chat-stream',
        ehp(targetOrigin, {
            parseReqBody: false,
            proxyReqPathResolver: () => '/chat-stream',
            proxyReqOptDecorator: (opts) => {
                opts.agent = agent;
                return opts;
            },
        })
    );

    return { app, agent };
}

function buildDestroyingProxy(targetOrigin) {
    const app = express();
    const agent = makeAgent();

    app.use(
        '/chat-stream',
        hpm.createProxyMiddleware({
            target: targetOrigin,
            changeOrigin: true,
            agent,
            proxyTimeout: 0,
            timeout: 0,
            pathRewrite: () => '/chat-stream',
            on: {
                proxyReq: (proxyReq, req, res) => {
                    // The fix.
                    const abortUpstream = () => {
                        try {
                            proxyReq.destroy && proxyReq.destroy();
                        } catch {}
                    };
                    req.on('aborted', abortUpstream);
                    res.on('close', abortUpstream);
                },
            },
        })
    );

    return { app, agent };
}

// ---------------------------------------------------------------- client

/**
 * @param {object} opts
 * @param {number} [opts.abortAfterMs]  destroy the request after this long
 * @param {boolean} [opts.partialBody]  declare a Content-Length larger than what
 *   we actually send, then abort — this is the state the bug depends on: the
 *   upstream is promised body bytes that never arrive.
 */
function postStreaming(port, message, { abortAfterMs, partialBody } = {}) {
    return new Promise((resolve) => {
        const full = JSON.stringify({ message, sessionId: 'sess-live', pad: 'x'.repeat(400) });
        const body = partialBody ? full.slice(0, 40) : full;

        const req = http.request(
            {
                port,
                path: '/chat-stream',
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(full),
                },
            },
            (res) => {
                let text = '';
                res.on('data', (c) => {
                    text += c.toString('utf8');
                });
                res.on('end', () =>
                    resolve({ status: res.statusCode, tokens: (text.match(/data: \{/g) || []).length })
                );
                res.on('close', () =>
                    resolve({ status: res.statusCode, tokens: (text.match(/data: \{/g) || []).length })
                );
            }
        );

        req.on('error', (err) => resolve({ status: 0, error: err.code || err.message, tokens: 0 }));

        req.write(body);
        // A partial upload is deliberately never ended — the upstream is left
        // waiting for the rest of a body that is not coming.
        if (!partialBody) req.end();

        if (abortAfterMs != null) {
            setTimeout(() => {
                req.destroy();
                resolve({ status: 'aborted', tokens: 0, aborted: true });
            }, abortAfterMs);
        }
    });
}

// ---------------------------------------------------------------- runner

async function runVariant(label, build, upstreamPort, counters) {
    const { app } = build(`http://127.0.0.1:${upstreamPort}`);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    console.log('─'.repeat(72));
    console.log(label);
    console.log('─'.repeat(72));

    // 1. Upload part of a body, then abort — the way a chat UI does when the
    //    user fires off a second message.
    counters.reset();
    await postStreaming(port, 'Hello', { abortAfterMs: 120, partialBody: true });
    console.log('  client aborted mid-upload after 120ms (body never completed)');

    await wait(400);

    const hanging = counters.hangingRequests();
    console.log(
        `  upstream still holding ${hanging} half-read request(s)` +
            (hanging > 0
                ? '   ← the abort never reached it; its socket is mid-message'
                : '   ← abort propagated, nothing left half-read')
    );

    // 2. The rapid follow-up, over the same pooled socket.
    const followUp = await postStreaming(port, 'How are you?');
    console.log(`  follow-up status: ${followUp.status}   tokens received: ${followUp.tokens}`);
    if (followUp.error) console.log(`  follow-up error:  ${followUp.error}`);

    await new Promise((r) => server.close(r));
    console.log('');

    return { label, hanging, followUp };
}

async function main() {
    const counters = {
        tokens: 0,
        opened: 0,     // requests whose headers the upstream has parsed
        resolved: 0,   // ...that then aborted, streamed, or were rejected
        reset() {
            this.tokens = 0;
            this.opened = 0;
            this.resolved = 0;
        },
        /** Requests the upstream is still waiting on a body for. */
        hangingRequests() {
            return Math.max(0, this.opened - this.resolved);
        },
    };

    const upstream = createUpstream({
        onEvent: (e) => {
            if (e.type === 'upstream:token') counters.tokens += 1;
            if (e.type === 'upstream:request-headers') counters.opened += 1;
            if (
                e.type === 'upstream:request-aborted' ||
                e.type === 'upstream:stream-open' ||
                e.type === 'upstream:bad-body' ||
                e.type === 'upstream:parse-error'
            ) {
                counters.resolved += 1;
            }
        },
    });

    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = upstream.address().port;
    console.log(`\nUpstream Server on 127.0.0.1:${upstreamPort}\n`);

    const results = [];
    results.push(await runVariant('A. express-http-proxy — no explicit abort handling', buildAbandoningProxy, upstreamPort, counters));
    results.push(await runVariant('B. http-proxy-middleware + proxyReq.destroy()', buildDestroyingProxy, upstreamPort, counters));

    console.log('═'.repeat(72));
    console.log('SUMMARY');
    console.log('═'.repeat(72));
    for (const r of results) {
        console.log(
            `  ${r.label}\n` +
                `      half-read requests left upstream : ${r.hanging}\n` +
                `      follow-up status                 : ${r.followUp.status}\n`
        );
    }
    const anyHanging = results.some((r) => r.hanging > 0);

    if (!anyHanging) {
        console.log(
            '  Both variants propagated the abort — nothing was left half-read, and\n' +
                '  both follow-ups succeeded. That is the expected result here: over a\n' +
                '  direct localhost hop on modern Node, destroying the client socket\n' +
                '  tears down the piped upstream request on its own.\n' +
                '\n' +
                '  This is worth stating plainly rather than dressing up. The explicit\n' +
                '  proxyReq.destroy() is not what saves you in THIS setup — it is what\n' +
                '  saves you when something holds the upstream socket open independently\n' +
                '  of the client socket: a load balancer or TLS terminator in the middle,\n' +
                '  or a keep-alive agent under concurrency handing the socket to the next\n' +
                '  request before teardown finishes. Then the abort does not propagate,\n' +
                '  and you get the failure `npm run repro` demonstrates deterministically.\n'
        );
    } else {
        console.log(
            '  A half-read request was left on the upstream. That socket is\n' +
                '  mid-message and must never be reused — see `npm run repro`.\n'
        );
    }

    await new Promise((r) => upstream.close(r));
    process.exit(0);
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
