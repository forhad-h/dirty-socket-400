'use strict';

/**
 * Upstream Server — a real Node HTTP server standing in for whatever sits behind
 * your proxy. It speaks the same shape as a chat backend: POST a JSON message,
 * get a Server-Sent Events stream of tokens back.
 *
 * Nothing here is faked. This is `http.createServer`, so the HTTP parser that
 * rejects a corrupted request is Node's own (llhttp) — which is the whole point
 * of the reproduction. We do not manufacture the 400; we watch a real parser
 * produce one.
 */

const http = require('http');

/** Canned replies, streamed token by token like a real model would. */
const REPLIES = {
    Hello: ['Hi', ' there', '!', ' How', ' can', ' I', ' help', ' you', ' today', '?'],
    'How are you?': ['I', "'m", ' doing', ' well', ',', ' thanks', ' for', ' asking', '.'],
};

const DEFAULT_REPLY = ['Sorry', ',', ' I', ' did', "n't", ' catch', ' that', '.'];

const TOKEN_DELAY_MS = 40;

function createUpstream({ onEvent = () => {} } = {}) {
    const server = http.createServer((req, res) => {
        onEvent({
            type: 'upstream:request-headers',
            detail: `${req.method} ${req.url}`,
            socketId: req.socket.__tapId,
        });

        if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'text/plain' });
            return res.end('Method Not Allowed\n');
        }

        const chunks = [];
        req.on('data', (c) => chunks.push(c));

        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');

            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (err) {
                // This fires when the parser handed us a body stitched together
                // from two different requests. Real symptom, real 400.
                onEvent({
                    type: 'upstream:bad-body',
                    detail: `body was not valid JSON (${raw.length} bytes): ${JSON.stringify(raw.slice(0, 60))}`,
                    socketId: req.socket.__tapId,
                });
                res.writeHead(400, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Bad Request', reason: 'malformed JSON body' }));
            }

            streamReply(req, res, parsed, onEvent);
        });

        // Client (or proxy) went away mid-request.
        req.on('aborted', () => {
            onEvent({
                type: 'upstream:request-aborted',
                detail: 'inbound request aborted before the body finished',
                socketId: req.socket.__tapId,
            });
        });
    });

    // Node replies 400 here by default. We take it over only so we can log the
    // parser's own error code — the response bytes are the same either way.
    server.on('clientError', (err, socket) => {
        onEvent({
            type: 'upstream:parse-error',
            detail: `${err.code || err.message} — refusing the request`,
            socketId: socket.__tapId,
        });

        if (socket.writable && !socket.destroyed) {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        } else {
            socket.destroy();
        }
    });

    server.keepAliveTimeout = 60_000;

    return server;
}

function streamReply(req, res, parsed, onEvent) {
    const message = parsed && parsed.message;
    const tokens = REPLIES[message] || DEFAULT_REPLY;

    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
    });

    onEvent({
        type: 'upstream:stream-open',
        detail: `streaming ${tokens.length} tokens for ${JSON.stringify(message)}`,
        socketId: req.socket.__tapId,
    });

    let i = 0;
    let timer = null;

    const stop = (why) => {
        if (timer) clearInterval(timer);
        timer = null;
        onEvent({
            type: 'upstream:stream-stopped',
            detail: `${why} after ${i}/${tokens.length} tokens`,
            socketId: req.socket.__tapId,
        });
    };

    // If the proxy destroys its request (the fix), this fires and we stop
    // producing. If it does not (the bug), we keep writing into a socket that
    // nobody is reading — which is exactly how the socket ends up dirty.
    res.on('close', () => {
        if (timer) stop('client disconnected');
    });

    timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) return stop('response already ended');

        if (i >= tokens.length) {
            clearInterval(timer);
            timer = null;
            res.write('data: [DONE]\n\n');
            res.end();
            onEvent({
                type: 'upstream:stream-complete',
                detail: `sent all ${tokens.length} tokens`,
                socketId: req.socket.__tapId,
            });
            return;
        }

        res.write(`data: ${JSON.stringify({ token: tokens[i] })}\n\n`);
        i += 1;
        onEvent({
            type: 'upstream:token',
            detail: `token ${i}/${tokens.length}`,
            socketId: req.socket.__tapId,
        });
    }, TOKEN_DELAY_MS);
}

module.exports = { createUpstream, REPLIES, TOKEN_DELAY_MS };

// Run it standalone so you can drive it by hand with nc, curl or any client:
//   node server/upstream.js --port 8080
if (require.main === module) {
    const arg = process.argv.find((a) => a.startsWith('--port='));
    const port = arg ? Number(arg.split('=')[1]) : 8080;

    const server = createUpstream({
        onEvent: (e) => {
            if (e.type === 'upstream:token') return;
            console.log(`  [upstream] ${e.type.replace('upstream:', '')}: ${e.detail}`);
        },
    });

    server.listen(port, '127.0.0.1', () => {
        console.log(`\n  Upstream Server listening on 127.0.0.1:${port}`);
        console.log(`  POST /chat-stream with {"message":"Hello"} for an SSE reply.\n`);
    });
}
