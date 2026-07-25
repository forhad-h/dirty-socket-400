'use strict';

/**
 * The reproduction. Zero dependencies — `net` and `http` only.
 *
 * WHAT IS BEING REPRODUCED
 * ------------------------
 * A proxy forwards a streaming chat request to an upstream server over a
 * pooled keep-alive socket. The user sends a rapid follow-up, so the browser
 * aborts the first request. The proxy notices the client is gone and stops
 * forwarding — but it never destroys its *upstream* request. Bytes for request
 * #1 are already on the wire and the upstream's HTTP parser is still waiting
 * for the rest of the body it was promised.
 *
 * That socket goes back into the keep-alive pool looking perfectly healthy. It
 * is not. The next request is written onto it, the upstream swallows the new
 * request's header bytes as the tail of the old body, resyncs somewhere in the
 * middle of a header line, and rejects what it finds.
 *
 * The result is a 400 on a request that was never malformed — the previous
 * request corrupted it.
 *
 * HOW THIS FILE MODELS IT
 * -----------------------
 * We drive a real TCP socket by hand instead of going through `http.Agent`,
 * because the agent will not hand out a socket it knows is mid-request. That
 * bookkeeping is precisely what a proxy defeats when it abandons a request
 * without destroying it, so we model the pool explicitly and keep every other
 * part of the stack real: real server, real llhttp parser, real 400.
 */

const net = require('net');
const { createUpstream } = require('./upstream');
const { tapSocket } = require('./socket-tap');

const FIRST_MESSAGE = 'Hello';
const FOLLOW_UP_MESSAGE = 'How are you?';

/** How much of request #1's body makes it onto the wire before the abort. */
const ABORT_AFTER_BODY_BYTES = 20;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function buildRequest({ port, message, sessionId }) {
    const body = JSON.stringify({ message, sessionId });
    const head =
        `POST /chat-stream HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: keep-alive\r\n` +
        `\r\n`;
    return { head, body, wire: head + body };
}

/**
 * Runs the abort-then-follow-up scenario once.
 * @param {'broken'|'fixed'} mode
 */
async function runScenario(mode, { port, log, bindUpstreamEvents = () => {} }) {
    const steps = [];
    const sockets = {};
    const t0 = Date.now();

    const push = (kind, actor, detail, extra = {}) => {
        const step = { t: Date.now() - t0, kind, actor, detail, ...extra };
        steps.push(step);
        log(step);
        return step;
    };

    const onEvent = (e) => {
        // Per-token events are useful for counting elsewhere, but they would
        // bury the interesting steps in the timeline.
        if (e.type === 'upstream:token') return;
        push(e.type, 'upstream', e.detail, { socketId: e.socketId });
    };

    // Let the upstream server's own events (parser errors, stream lifecycle)
    // land in this scenario's timeline.
    bindUpstreamEvents(onEvent);

    // ---- Request #1: the stream the user is about to abandon -------------
    const first = buildRequest({ port, message: FIRST_MESSAGE, sessionId: 'sess-a1b2c3' });

    const s1 = net.connect({ port, host: '127.0.0.1' });
    const s1Record = tapSocket(s1, { label: 'proxy → upstream (pooled)', onEvent });
    sockets[s1Record.id] = s1Record;
    await new Promise((resolve) => s1.once('connect', resolve));

    push('client:send', 'client', `user sends ${JSON.stringify(FIRST_MESSAGE)}`);

    const partialBody = first.body.slice(0, ABORT_AFTER_BODY_BYTES);
    const owed = Buffer.byteLength(first.body) - Buffer.byteLength(partialBody);

    s1.write(first.head + partialBody);
    push(
        'proxy:forward-partial',
        'proxy',
        `forwarded headers + ${partialBody.length} of ${first.body.length} body bytes`,
        { socketId: s1Record.id, bytes: first.head + partialBody, owedBytes: owed }
    );

    await wait(60);

    // ---- The abort -------------------------------------------------------
    push('client:abort', 'client', 'user sends a follow-up; browser aborts the first request');

    if (mode === 'fixed') {
        s1.destroy();
        push(
            'proxy:destroy-upstream',
            'proxy',
            'proxyReq.destroy() — upstream request torn down, socket leaves the pool',
            { socketId: s1Record.id }
        );
    } else {
        push(
            'proxy:abandon-upstream',
            'proxy',
            'upstream request abandoned but never destroyed — socket returns to the pool',
            { socketId: s1Record.id, owedBytes: owed }
        );
    }

    push('pool:state', 'pool', mode === 'fixed' ? `${s1Record.id} destroyed` : `${s1Record.id} marked idle (still owes ${owed} body bytes)`, {
        socketId: s1Record.id,
        owedBytes: mode === 'fixed' ? 0 : owed,
        healthy: mode === 'fixed',
    });

    await wait(60);

    // ---- Request #2: the follow-up ---------------------------------------
    const second = buildRequest({ port, message: FOLLOW_UP_MESSAGE, sessionId: 'sess-a1b2c3' });
    push('client:send', 'client', `user sends ${JSON.stringify(FOLLOW_UP_MESSAGE)}`);

    let s2;
    let s2Record;
    let reused;

    if (mode === 'fixed') {
        s2 = net.connect({ port, host: '127.0.0.1' });
        s2Record = tapSocket(s2, { label: 'proxy → upstream (fresh)', onEvent });
        sockets[s2Record.id] = s2Record;
        await new Promise((resolve) => s2.once('connect', resolve));
        reused = false;
        push('pool:checkout', 'pool', `pool has no idle socket — dialled a fresh one (${s2Record.id})`, {
            socketId: s2Record.id,
        });
    } else {
        s2 = s1;
        s2Record = s1Record;
        reused = true;
        push('pool:checkout', 'pool', `pool reuses ${s1Record.id} — it looks idle, but it is mid-message`, {
            socketId: s1Record.id,
            owedBytes: owed,
        });
    }

    const response = await new Promise((resolve) => {
        let buf = '';
        const done = (why) => resolve({ text: buf, why });

        s2.on('data', (c) => {
            buf += c.toString('utf8');
            if (buf.includes('data: [DONE]')) done('stream complete');
        });
        s2.on('close', () => done('socket closed'));
        s2.on('error', () => done('socket error'));

        s2.write(second.wire);
        push('proxy:forward', 'proxy', `forwarded the follow-up (${second.wire.length} bytes)`, {
            socketId: s2Record.id,
            bytes: second.wire,
        });

        if (mode === 'broken') {
            push(
                'upstream:steals-bytes',
                'upstream',
                `parser is still owed ${owed} body bytes for request #1 — it takes them from the front of request #2`,
                {
                    socketId: s2Record.id,
                    owedBytes: owed,
                    // The two halves the simulator highlights: what gets eaten as
                    // the tail of request #1's body, and where the parser then
                    // tries — and fails — to find a new request line.
                    stolen: second.wire.slice(0, owed),
                    resyncRemainder: second.wire.slice(owed),
                    stitchedBody: partialBody + second.wire.slice(0, owed),
                }
            );
        }

        setTimeout(() => done('timed out'), 2500);
    });

    s1.destroy();
    if (s2 !== s1) s2.destroy();

    const statusLine = (response.text.split('\r\n')[0] || '').trim();
    const ok = /^HTTP\/1\.1 200/.test(statusLine);

    push(ok ? 'client:ok' : 'client:error', 'client', statusLine || '(no response)', {
        bytes: response.text,
    });

    return {
        mode,
        reusedDirtySocket: reused,
        owedBytes: owed,
        steps,
        sockets,
        outcome: {
            statusLine,
            ok,
            raw: response.text,
            endedBecause: response.why,
            tokensReceived: (response.text.match(/data: \{/g) || []).length,
        },
    };
}

/** Boots the upstream, runs one or both modes, tears everything down. */
async function main({ modes = ['broken', 'fixed'], quiet = false } = {}) {
    const results = {};

    // Rebound per scenario so upstream events land in the right timeline.
    let upstreamSink = () => {};
    const server = createUpstream({ onEvent: (e) => upstreamSink(e) });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    if (!quiet) console.log(`\nUpstream Server listening on 127.0.0.1:${port}\n`);

    for (const mode of modes) {
        if (!quiet) {
            console.log('─'.repeat(72));
            console.log(
                mode === 'broken'
                    ? 'BROKEN — proxy abandons the upstream request on client abort'
                    : 'FIXED  — proxy calls proxyReq.destroy() on client abort'
            );
            console.log('─'.repeat(72));
        }

        results[mode] = await runScenario(mode, {
            port,
            bindUpstreamEvents: (sink) => {
                upstreamSink = sink;
            },
            log: (s) => {
                if (quiet) return;
                const at = String(s.t).padStart(4, ' ');
                console.log(`  ${at}ms  ${s.actor.padEnd(8)} ${s.detail}`);
            },
        });

        if (!quiet) {
            const { outcome } = results[mode];
            console.log(`\n  → follow-up got: ${outcome.statusLine || '(nothing)'}`);
            console.log(`  → tokens streamed back: ${outcome.tokensReceived}\n`);
        }

        await wait(120);
    }

    await new Promise((resolve) => server.close(resolve));
    return results;
}

module.exports = { runScenario, main, FIRST_MESSAGE, FOLLOW_UP_MESSAGE, ABORT_AFTER_BODY_BYTES };

if (require.main === module) {
    const arg = process.argv.find((a) => a.startsWith('--mode='));
    const modes = arg ? [arg.split('=')[1]] : ['broken', 'fixed'];

    main({ modes })
        .then((results) => {
            console.log('═'.repeat(72));
            console.log('SUMMARY');
            console.log('═'.repeat(72));
            for (const [mode, r] of Object.entries(results)) {
                console.log(
                    `  ${mode.padEnd(7)} reused dirty socket: ${String(r.reusedDirtySocket).padEnd(6)} ` +
                        `follow-up: ${r.outcome.statusLine || '(nothing)'}`
                );
            }
            console.log('');
            process.exit(0);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
