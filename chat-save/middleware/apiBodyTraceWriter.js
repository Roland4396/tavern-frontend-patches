import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getRealIpFromHeader } from '../express-common.js';
import { getConfigValue } from '../util.js';

const enabled = getConfigValue('logging.enableApiBodyTrace', true, 'boolean');
const progressIntervalMs = getConfigValue('logging.apiBodyTraceProgressIntervalMs', 10000, 'number');
const minContentLength = getConfigValue('logging.apiBodyTraceMinContentLength', 64 * 1024, 'number');
const includeQuery = getConfigValue('logging.apiBodyTraceIncludeQuery', false, 'boolean');
const maxUrlLength = getConfigValue('logging.apiBodyTraceMaxUrlLength', 300, 'number');

const trackedPaths = new Set([
    '/api/settings/save',
    '/api/chats/save',
    '/api/chats/save-append',
    '/api/worldinfo/edit',
    '/api/images/upload',
    '/api/backends/chat-completions/generate',
    '/api/novelai/generate-image',
]);

const getTracePath = () => path.join(globalThis.DATA_ROOT, 'api-body-trace.jsonl');

function decodeHeader(value) {
    if (typeof value !== 'string') {
        return value || null;
    }
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function traceHeaders(req) {
    return {
        apiTraceId: req.headers['x-st-api-trace-id'] || null,
        apiSource: decodeHeader(req.headers['x-st-api-source']),
        apiStack: decodeHeader(req.headers['x-st-api-stack']),
        apiBodyLength: req.headers['x-st-api-body-length'] || null,
        apiBodyHash: req.headers['x-st-api-body-hash'] || null,
        worldInfoTraceId: req.headers['x-worldinfo-trace-id'] || null,
        worldInfoSource: decodeHeader(req.headers['x-worldinfo-source']),
        worldInfoStack: decodeHeader(req.headers['x-worldinfo-stack']),
        worldInfoBodyHash: req.headers['x-worldinfo-body-hash'] || null,
        worldInfoEntryCount: req.headers['x-worldinfo-entry-count'] || null,
    };
}

function safeUrl(req) {
    const raw = includeQuery ? (req.originalUrl || req.url || '') : (req.path || req.url?.split('?')[0] || '');
    return String(raw).slice(0, Number.isFinite(maxUrlLength) ? maxUrlLength : 300);
}

function shouldTrace(req, url, contentLength) {
    if (!String(req.path || req.url || '').startsWith('/api/')) {
        return false;
    }
    if (trackedPaths.has(url)) {
        return true;
    }
    return Number.isFinite(contentLength) && contentLength >= minContentLength;
}

function getChunkLength(chunk) {
    if (Buffer.isBuffer(chunk)) {
        return chunk.length;
    }
    if (typeof chunk === 'string') {
        return Buffer.byteLength(chunk);
    }
    if (chunk && typeof chunk.length === 'number') {
        return chunk.length;
    }
    return 0;
}

function writeRecord(record) {
    fs.appendFile(getTracePath(), `${JSON.stringify(record)}\n`, (err) => {
        if (err) {
            console.error('Failed to write API body trace log:', err);
        }
    });
}

/**
 * Records request body receive progress without attaching a data listener.
 * Wrapping req.emit lets body-parser/multer keep their normal stream ownership.
 * @returns {import('express').RequestHandler}
 */
export default function apiBodyTraceMiddleware() {
    return function apiBodyTrace(req, res, next) {
        if (!enabled) {
            return next();
        }

        const url = safeUrl(req);
        const contentLength = Number(req.headers['content-length']);
        if (!shouldTrace(req, url, contentLength)) {
            return next();
        }

        const startedAt = process.hrtime.bigint();
        const traceId = crypto.randomUUID();
        const originalEmit = req.emit;
        let receivedBytes = 0;
        let lastProgressBytes = 0;
        let firstDataAt = null;
        let lastDataAt = null;
        let requestEnded = false;
        let requestAborted = false;
        let responseFinished = false;
        let cleaned = false;

        const baseRecord = {
            traceId,
            method: req.method,
            url,
            ip: getRealIpFromHeader(req),
            remoteAddress: req.socket?.remoteAddress || null,
            remotePort: req.socket?.remotePort || null,
            requestContentLength: Number.isFinite(contentLength) ? contentLength : null,
            requestContentEncoding: req.headers['content-encoding'] || null,
            requestContentType: req.headers['content-type'] || null,
            userAgent: req.headers['user-agent'] || null,
            trace: traceHeaders(req),
        };

        const emitRecord = (event, extra = {}) => {
            const now = process.hrtime.bigint();
            const durationMs = Number((now - startedAt) / 1000000n);
            const receivedPct = Number.isFinite(contentLength) && contentLength > 0
                ? Number(((receivedBytes / contentLength) * 100).toFixed(2))
                : null;
            const wallNow = Date.now();
            writeRecord({
                timestamp: new Date().toISOString(),
                ...baseRecord,
                event,
                durationMs,
                receivedBytes,
                receivedPct,
                bytesSinceLastProgress: receivedBytes - lastProgressBytes,
                firstDataAfterMs: firstDataAt ? firstDataAt - Number(startedAt / 1000000n) : null,
                lastDataAgoMs: lastDataAt ? wallNow - lastDataAt : null,
                requestEnded,
                requestAborted,
                requestComplete: req.complete,
                requestReadableEnded: req.readableEnded,
                requestDestroyed: req.destroyed,
                responseFinished,
                statusCode: res.statusCode || null,
                responseContentLength: res.getHeader('content-length') || null,
                responseContentEncoding: res.getHeader('content-encoding') || null,
                ...extra,
            });
            lastProgressBytes = receivedBytes;
        };

        const cleanup = () => {
            if (cleaned) {
                return;
            }
            cleaned = true;
            clearInterval(progressTimer);
            req.emit = originalEmit;
        };

        const progressTimer = setInterval(() => {
            emitRecord('progress');
        }, Number.isFinite(progressIntervalMs) && progressIntervalMs > 0 ? progressIntervalMs : 10000);
        progressTimer.unref?.();

        req.emit = function tracedEmit(event, ...args) {
            if (event === 'data') {
                const nowMs = Date.now();
                if (!firstDataAt) {
                    firstDataAt = Number(process.hrtime.bigint() / 1000000n);
                    emitRecord('first_data');
                }
                lastDataAt = nowMs;
                receivedBytes += getChunkLength(args[0]);
            } else if (event === 'end') {
                requestEnded = true;
                emitRecord('request_end');
            } else if (event === 'aborted') {
                requestAborted = true;
                emitRecord('request_aborted');
            } else if (event === 'error') {
                emitRecord('request_error', {
                    errorName: args[0]?.name || null,
                    errorMessage: args[0]?.message || String(args[0] || ''),
                    errorCode: args[0]?.code || null,
                });
            }

            return originalEmit.call(this, event, ...args);
        };

        res.once('finish', () => {
            responseFinished = true;
            emitRecord('response_finish');
            cleanup();
        });

        res.once('close', () => {
            if (!responseFinished) {
                emitRecord('response_close');
            }
            cleanup();
        });

        emitRecord('start');
        return next();
    };
}
