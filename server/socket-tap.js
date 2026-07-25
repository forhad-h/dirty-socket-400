'use strict';

/**
 * Socket tap — records the actual bytes crossing a TCP socket, in order, with
 * timestamps. The browser simulator replays these recordings, so what you see
 * animated on the page is a transcript of a real connection rather than a
 * hand-written illustration.
 */

let nextId = 1;

function tapSocket(socket, { label, onEvent = () => {} } = {}) {
    const id = `sock-${nextId++}`;
    socket.__tapId = id;

    const record = {
        id,
        label,
        openedAt: Date.now(),
        closedAt: null,
        /** @type {{dir:'out'|'in', at:number, bytes:string}[]} */
        frames: [],
    };

    const originalWrite = socket.write.bind(socket);
    socket.write = (chunk, encoding, cb) => {
        if (chunk && chunk.length) {
            record.frames.push({
                dir: 'out',
                at: Date.now(),
                bytes: Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk),
            });
        }
        return originalWrite(chunk, encoding, cb);
    };

    socket.on('data', (chunk) => {
        record.frames.push({ dir: 'in', at: Date.now(), bytes: chunk.toString('utf8') });
    });

    socket.on('close', () => {
        record.closedAt = Date.now();
        onEvent({ type: 'socket:closed', detail: `${id} closed`, socketId: id });
    });

    onEvent({ type: 'socket:opened', detail: `${id} opened (${label})`, socketId: id });

    return record;
}

/** Everything the socket sent, concatenated — i.e. the raw request stream. */
function sentBytes(record) {
    return record.frames
        .filter((f) => f.dir === 'out')
        .map((f) => f.bytes)
        .join('');
}

/** Everything the socket received, concatenated — i.e. the raw response stream. */
function receivedBytes(record) {
    return record.frames
        .filter((f) => f.dir === 'in')
        .map((f) => f.bytes)
        .join('');
}

module.exports = { tapSocket, sentBytes, receivedBytes };
