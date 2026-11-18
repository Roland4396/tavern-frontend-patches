import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');

// Scan raw bytes, not JSON objects. Memory is bounded by one chunk and the last
// message; the header and every earlier record are copied without reserializing.
function inspectTail(fd, size) {
    const chunk = Buffer.allocUnsafe(Math.min(size || 1, 1024 * 1024));
    let offset = 0, lineFeeds = 0, lastLf = -1, previousLf = -1, lastByte;
    while (offset < size) {
        const bytes = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
        if (!bytes) throw new Error('Unexpected EOF while locating the final message');
        for (let i = 0; i < bytes; i++) {
            if (chunk[i] === 10) { lineFeeds++; previousLf = lastLf; lastLf = offset + i; }
        }
        lastByte = chunk[bytes - 1];
        offset += bytes;
    }
    const trailingLf = lastByte === 10;
    const start = (trailingLf ? previousLf : lastLf) + 1;
    const end = trailingLf ? size - 1 : size;
    const tail = Buffer.alloc(end - start);
    let read = 0;
    while (read < tail.length) {
        const bytes = fs.readSync(fd, tail, read, tail.length - read, start + read);
        if (!bytes) throw new Error('Unexpected EOF reading the final message');
        read += bytes;
    }
    const crlf = tail.at(-1) === 13;
    return {
        start,
        lineCount: lineFeeds + (trailingLf ? 0 : 1),
        json: tail.subarray(0, crlf ? -1 : undefined).toString('utf8'),
        terminator: trailingLf ? (crlf ? '\r\n' : '\n') : '',
    };
}

function sameFile(a, b) {
    return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Atomic, optimistic replacement of the last JSONL message, never its header. */
export function replaceLastChatMessage(filePath, payload) {
    const started = performance.now();
    if (!Number.isSafeInteger(payload?.messageId) || payload.messageId < 0
        || !Number.isSafeInteger(payload.expectedMessages) || payload.expectedMessages < 1
        || payload.messageId !== payload.expectedMessages - 1
        || !/^[a-f0-9]{64}$/.test(payload.expectedMessageHash || '')
        || !payload.message || typeof payload.message !== 'object' || Array.isArray(payload.message)) {
        return { ok: false, status: 400, error: 'invalid_message_update' };
    }
    if (!fs.existsSync(filePath)) return { ok: false, status: 404, error: 'file_not_found' };
    const fd = fs.openSync(filePath, 'r');
    let temporary;
    try {
        const before = fs.fstatSync(fd);
        const tail = inspectTail(fd, before.size);
        if (tail.lineCount !== payload.expectedMessages + 1) {
            return { ok: false, status: 409, error: 'line_mismatch', actualMessages: tail.lineCount - 1 };
        }
        const existing = JSON.parse(tail.json);
        const oldJson = JSON.stringify(existing);
        const nextJson = JSON.stringify(payload.message);
        if (oldJson === nextJson) return { ok: true, unchanged: true, messageId: payload.messageId };
        if (digest(oldJson) !== payload.expectedMessageHash) {
            return { ok: false, status: 409, error: 'message_changed' };
        }
        // Preserve atomic rename, unlike truncating the live chat in place.
        // Reflink when supported; ordinary byte copying remains the safe fallback.
        temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.message-${randomUUID()}.tmp`);
        fs.copyFileSync(filePath, temporary, fs.constants.COPYFILE_FICLONE);
        const out = fs.openSync(temporary, 'r+');
        try {
            const replacement = Buffer.from(nextJson + tail.terminator, 'utf8');
            fs.ftruncateSync(out, tail.start);
            let written = 0;
            while (written < replacement.length) {
                const bytes = fs.writeSync(out, replacement, written, replacement.length - written, tail.start + written);
                if (!bytes) throw new Error('Unable to write final message');
                written += bytes;
            }
            fs.fchmodSync(out, before.mode & 0o777);
            const owner = fs.fstatSync(out);
            if (owner.uid !== before.uid || owner.gid !== before.gid) fs.fchownSync(out, before.uid, before.gid);
            fs.fsyncSync(out);
        } finally { fs.closeSync(out); }
        if (!sameFile(before, fs.statSync(filePath))) {
            return { ok: false, status: 409, error: 'file_changed' };
        }
        fs.renameSync(temporary, filePath);
        temporary = undefined;
        return {
            ok: true,
            messageId: payload.messageId,
            updatedBytes: Buffer.byteLength(nextJson),
            preservedPrefixBytes: tail.start,
            elapsedMs: Math.round((performance.now() - started) * 100) / 100,
        };
    } finally {
        fs.closeSync(fd);
        if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}
