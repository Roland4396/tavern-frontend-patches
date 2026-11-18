#!/usr/bin/env node
import fs from 'node:fs';

const targetPath = process.argv[2] || '/home/node/app/public/script.js';

function lines(parts) {
    return parts.join('\n') + '\n';
}

function replaceInText(text, before, after, label) {
    if (text.includes(after)) return text;
    if (!text.includes(before)) {
        throw new Error(`Patch anchor not found for ${label}`);
    }
    return text.replace(before, after);
}

// Patch public/script.js: remove legacy global image proxy interception.
let scriptSource = fs.readFileSync(targetPath, 'utf8');
scriptSource = replaceInText(
    scriptSource,
    'const SAVE_UPLOAD_COMPRESSION_THRESHOLD_BYTES = 256 * 1024;',
    'const SAVE_UPLOAD_COMPRESSION_THRESHOLD_BYTES = 10 * 1024;',
    'script:save upload compression threshold',
);
const imageProxyStateBefore = lines([
    'let chatSaveTimeout;',
    'let importFlashTimeout;',
    'export let isChatSaving = false;',
]);
const imageProxyStateAfter = lines([
    'let chatSaveTimeout;',
    'let importFlashTimeout;',
    '',
    '// Image proxy: route external images through a cached same-origin endpoint.',
    '(function installImageProxyInterceptor() {',
    "    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');",
    '    if (!descriptor || !descriptor.set) return;',
    '',
    '    const originalSet = descriptor.set;',
    '    const origin = window.location.origin;',
    '',
    "    Object.defineProperty(HTMLImageElement.prototype, 'src', {",
    '        ...descriptor,',
    '        set(value) {',
    "            if (typeof value === 'string'",
    "                && (value.indexOf('://') > 0 || value.indexOf('//') === 0)",
    '                && !value.startsWith(origin)',
    "                && !value.startsWith('/api/image-proxy')) {",
    "                value = '/api/image-proxy?url=' + encodeURIComponent(value);",
    '            }',
    '',
    '            originalSet.call(this, value);',
    '        },',
    '    });',
    '})();',
    '',
    'export let isChatSaving = false;',
]);
if (scriptSource.includes(imageProxyStateAfter)) {
    scriptSource = scriptSource.replace(imageProxyStateAfter, imageProxyStateBefore);
} else if (!scriptSource.includes(imageProxyStateBefore)) {
    throw new Error('Patch anchor not found for script:remove legacy image proxy interceptor');
}
fs.writeFileSync(targetPath, scriptSource);
console.log('Patched:', targetPath);

// Patch public/scripts/chats.js: rewrite external <img> URLs before media blocking.
const chatsPath = '/home/node/app/public/scripts/chats.js';
let chatsSource = fs.readFileSync(chatsPath, 'utf8');
const chatsHookBefore = lines([
    "    DOMPurify.addHook('afterSanitizeAttributes', function (node) {",
    "        if ('target' in node) {",
    "            node.setAttribute('target', '_blank');",
    "            node.setAttribute('rel', 'noopener');",
    '        }',
    '    });',
]);
const chatsHookAfter = lines([
    "    DOMPurify.addHook('afterSanitizeAttributes', function (node) {",
    "        if ('target' in node) {",
    "            node.setAttribute('target', '_blank');",
    "            node.setAttribute('rel', 'noopener');",
    '        }',
    '',
    "        if (node.tagName === 'IMG') {",
    "            const src = node.getAttribute('src');",
    '            if (src',
    "                && (src.indexOf('://') > 0 || src.indexOf('//') === 0)",
    '                && !src.startsWith(window.location.origin)',
    "                && !src.startsWith('/api/image-proxy')) {",
    "                node.setAttribute('src', '/api/image-proxy?url=' + encodeURIComponent(src));",
    '            }',
    '        }',
    '    });',
]);
chatsSource = replaceInText(chatsSource, chatsHookBefore, chatsHookAfter, 'chats:image proxy hook');
fs.writeFileSync(chatsPath, chatsSource);
console.log('Patched:', chatsPath);

// Patch src/server-startup.js: register image proxy endpoint.
const serverStartupPath = '/home/node/app/src/server-startup.js';
let serverStartupSource = fs.readFileSync(serverStartupPath, 'utf8');
const serverImportBefore = lines([
    "import { router as imageMetadataRouter } from './endpoints/image-metadata.js';",
    "import { router as volcengineRouter } from './endpoints/volcengine.js';",
]);
const serverImportAfter = lines([
    "import { router as imageMetadataRouter } from './endpoints/image-metadata.js';",
    "import { router as imageProxyRouter } from './endpoints/image-proxy.js';",
    "import { router as volcengineRouter } from './endpoints/volcengine.js';",
]);
serverStartupSource = replaceInText(serverStartupSource, serverImportBefore, serverImportAfter, 'server-startup:image proxy import');
const serverUseBefore = lines([
    "    app.use('/api/backups', backupsRouter);",
    "    app.use('/api/image-metadata', imageMetadataRouter);",
    '}',
]);
const serverUseAfter = lines([
    "    app.use('/api/backups', backupsRouter);",
    "    app.use('/api/image-metadata', imageMetadataRouter);",
    "    app.use('/api/image-proxy', imageProxyRouter);",
    '}',
]);
serverStartupSource = replaceInText(serverStartupSource, serverUseBefore, serverUseAfter, 'server-startup:image proxy route');
fs.writeFileSync(serverStartupPath, serverStartupSource);
console.log('Patched:', serverStartupPath);

// Patch public/script.js: add targeted save compression diagnostics.
const saveCompressCheckBefore = lines([
    '    const bodySize = new TextEncoder().encode(jsonBody).byteLength;',
    '    const webkitBrowser = isLikelyWebKitBrowserForCompression();',
    "    const compressionEngines = webkitBrowser ? ['fflate'] : ['fflate', 'native'];",
    '    const canCompress = isSaveUploadCompressionEnabled()',
    '        && bodySize >= SAVE_UPLOAD_COMPRESSION_THRESHOLD_BYTES',
    '        && SAVE_UPLOAD_COMPRESSION_FORMATS.length > 0;',
    '',
    '    if (!canCompress) {',
    '        return fetch(url, plainRequest);',
    '    }',
]);
const saveCompressCheckAfter = lines([
    '    const bodySize = new TextEncoder().encode(jsonBody).byteLength;',
    '    const webkitBrowser = isLikelyWebKitBrowserForCompression();',
    "    const compressionEngines = webkitBrowser ? ['fflate'] : ['fflate', 'native'];",
    '    const compressionEnabled = isSaveUploadCompressionEnabled();',
    '    const canCompress = compressionEnabled',
    '        && bodySize >= SAVE_UPLOAD_COMPRESSION_THRESHOLD_BYTES',
    '        && SAVE_UPLOAD_COMPRESSION_FORMATS.length > 0;',
    '',
    "    console.info('[SAVE-COMPRESS] start', {",
    '        url: url,',
    '        bodySize: bodySize,',
    '        threshold: SAVE_UPLOAD_COMPRESSION_THRESHOLD_BYTES,',
    '        compressionEnabled: compressionEnabled,',
    '        webkitBrowser: webkitBrowser,',
    '        engines: compressionEngines,',
    '        formats: SAVE_UPLOAD_COMPRESSION_FORMATS,',
    '    });',
    '',
    '    if (!canCompress) {',
    "        const reason = !compressionEnabled ? 'disabled'",
    "            : bodySize < SAVE_UPLOAD_COMPRESSION_THRESHOLD_BYTES ? 'below_threshold'",
    "                : SAVE_UPLOAD_COMPRESSION_FORMATS.length === 0 ? 'no_formats'",
    "                    : 'unknown';",
    "        console.info('[SAVE-COMPRESS] skip', { url: url, reason: reason, bodySize: bodySize });",
    '        return fetch(url, plainRequest);',
    '    }',
]);
scriptSource = replaceInText(scriptSource, saveCompressCheckBefore, saveCompressCheckAfter, 'script:save compression diagnostics start');

const saveCompressResultBefore = lines([
    '                if (!compressedBody || compressedBody.byteLength >= bodySize) {',
    '                    continue;',
    '                }',
    '',
    '                const compressedResponse = await fetch(url, {',
]);
const saveCompressResultAfter = lines([
    '                if (!compressedBody || compressedBody.byteLength >= bodySize) {',
    "                    console.info('[SAVE-COMPRESS] skip compressed variant', {",
    '                        url: url,',
    '                        engine: engine,',
    '                        format: format,',
    '                        bodySize: bodySize,',
    '                        compressedSize: compressedBody?.byteLength ?? null,',
    "                        reason: !compressedBody ? 'compress_failed_or_null' : 'not_smaller',",
    '                    });',
    '                    continue;',
    '                }',
    '',
    "                console.info('[SAVE-COMPRESS] upload compressed', {",
    '                    url: url,',
    '                    engine: engine,',
    '                    format: format,',
    '                    bodySize: bodySize,',
    '                    compressedSize: compressedBody.byteLength,',
    '                });',
    '',
    '                const compressedResponse = await fetch(url, {',
]);
scriptSource = replaceInText(scriptSource, saveCompressResultBefore, saveCompressResultAfter, 'script:save compression diagnostics variant');

const saveCompressResponseBefore = lines([
    '                if (compressedResponse.ok || !SAVE_UPLOAD_COMPRESSION_RETRY_STATUSES.has(compressedResponse.status)) {',
    '                    return compressedResponse;',
    '                }',
    '',
    '                console.warn(`Compressed save request failed (${compressedResponse.status}, ${engine}/${format}), trying next fallback.`);',
]);
const saveCompressResponseAfter = lines([
    "                console.info('[SAVE-COMPRESS] compressed response', {",
    '                    url: url,',
    '                    engine: engine,',
    '                    format: format,',
    '                    status: compressedResponse.status,',
    '                    ok: compressedResponse.ok,',
    '                });',
    '',
    '                if (compressedResponse.ok || !SAVE_UPLOAD_COMPRESSION_RETRY_STATUSES.has(compressedResponse.status)) {',
    '                    return compressedResponse;',
    '                }',
    '',
    '                console.warn(`Compressed save request failed (${compressedResponse.status}, ${engine}/${format}), trying next fallback.`);',
]);
scriptSource = replaceInText(scriptSource, saveCompressResponseBefore, saveCompressResponseAfter, 'script:save compression diagnostics response');

const saveCompressFallbackBefore = lines([
    '    return fetch(url, plainRequest);',
    '}',
]);
const saveCompressFallbackAfter = lines([
    "    console.info('[SAVE-COMPRESS] fallback plain upload', { url: url, bodySize: bodySize });",
    '    return fetch(url, plainRequest);',
    '}',
]);
scriptSource = replaceInText(scriptSource, saveCompressFallbackBefore, saveCompressFallbackAfter, 'script:save compression diagnostics fallback');
fs.writeFileSync(targetPath, scriptSource);
console.log('Patched:', targetPath);

// Patch public/scripts/tokenizers.js: estimate immediately, then async backfill real counts.
const tokenizersPath = '/home/node/app/public/scripts/tokenizers.js';
let tokenizerSource = fs.readFileSync(tokenizersPath, 'utf8');

const tokenizerHelpersBefore = lines([
    'const FAST_TOKEN_ESTIMATE_LOCALSTORAGE_KEY = \'st_fast_token_estimate\';',
    '',
    'function isFastTokenEstimateEnabled() {',
    '    try {',
    '        const value = localStorage.getItem(FAST_TOKEN_ESTIMATE_LOCALSTORAGE_KEY);',
    '        // default ON to avoid heavy remote token counting in large chats',
    "        return value === null ? true : value !== '0' && value.toLowerCase() !== 'false';",
    '    } catch {',
    '        return true;',
    '    }',
    '}',
    '',
    'function toEstimateText(message) {',
    "    if (typeof message === 'string') {",
    '        return message;',
    '    }',
    '',
    '    try {',
    '        const serialized = JSON.stringify(message ?? {});',
    "        if (typeof serialized === 'string') {",
    '            return serialized;',
    '        }',
    '    } catch {',
    '        // ignore stringify failures (circular refs / BigInt / custom objects)',
    '    }',
    '',
    '    try {',
    "        return String(message ?? '');",
    '    } catch {',
    "        return '';",
    '    }',
    '}',
    '',
    'function estimateOpenAITokenCount(messages, full = false) {',
    '    if (!Array.isArray(messages)) {',
    '        messages = [messages];',
    '    }',
    '',
    '    try {',
    '        let tokenCount = -1;',
    '',
    '        for (const message of messages) {',
    '            const serialized = toEstimateText(message);',
    '            // Keep a small per-message overhead so context budgeting stays conservative.',
    '            tokenCount += Math.ceil(serialized.length / CHARACTERS_PER_TOKEN_RATIO) + 4;',
    '        }',
    '',
    '        if (!full) tokenCount -= 2;',
    '        return Math.max(0, tokenCount);',
    '    } catch {',
    '        const fallbackText = toEstimateText(messages);',
    '        return Math.max(0, Math.ceil(fallbackText.length / CHARACTERS_PER_TOKEN_RATIO));',
    '    }',
    '}',
]);
const tokenizerHelpersAfter = lines([
    'const FAST_TOKEN_ESTIMATE_LOCALSTORAGE_KEY = \'st_fast_token_estimate\';',
    'const tokenCountBackfillRequests = new Map();',
    '',
    'function isFastTokenEstimateEnabled() {',
    '    try {',
    '        const value = localStorage.getItem(FAST_TOKEN_ESTIMATE_LOCALSTORAGE_KEY);',
    '        // default ON to avoid heavy remote token counting in large chats',
    "        return value === null ? true : value !== '0' && value.toLowerCase() !== 'false';",
    '    } catch {',
    '        return true;',
    '    }',
    '}',
    '',
    'function toEstimateText(message) {',
    "    if (typeof message === 'string') {",
    '        return message;',
    '    }',
    '',
    '    try {',
    '        const serialized = JSON.stringify(message ?? {});',
    "        if (typeof serialized === 'string') {",
    '            return serialized;',
    '        }',
    '    } catch {',
    '        // ignore stringify failures (circular refs / BigInt / custom objects)',
    '    }',
    '',
    '    try {',
    "        return String(message ?? '');",
    '    } catch {',
    "        return '';",
    '    }',
    '}',
    '',
    'function estimateOpenAITokenCountForMessage(message) {',
    '    const serialized = toEstimateText(message);',
    '    return Math.ceil(serialized.length / CHARACTERS_PER_TOKEN_RATIO) + 4;',
    '}',
    '',
    'function estimateOpenAITokenCount(messages, full = false) {',
    '    if (!Array.isArray(messages)) {',
    '        messages = [messages];',
    '    }',
    '',
    '    try {',
    '        let tokenCount = -1;',
    '',
    '        for (const message of messages) {',
    '            tokenCount += estimateOpenAITokenCountForMessage(message);',
    '        }',
    '',
    '        if (!full) tokenCount -= 2;',
    '        return Math.max(0, tokenCount);',
    '    } catch {',
    '        const fallbackText = toEstimateText(messages);',
    '        return Math.max(0, Math.ceil(fallbackText.length / CHARACTERS_PER_TOKEN_RATIO));',
    '    }',
    '}',
    '',
    'function enqueueOpenAITokenCountBackfill(tokenizerEndpoint, cacheObject, cacheKey, message) {',
    '    if (typeof cacheObject?.[cacheKey] === \"number\" || tokenCountBackfillRequests.has(cacheKey)) {',
    '        return;',
    '    }',
    '',
    '    const request = Promise.resolve(jQuery.ajax({',
    '        async: true,',
    "        type: 'POST', //",
    '        url: tokenizerEndpoint,',
    '        data: JSON.stringify([message]),',
    "        dataType: 'json',",
    "        contentType: 'application/json',",
    '    }))',
    '        .then((data) => {',
    '            const tokenCount = Number(data?.token_count);',
    '            if (Number.isFinite(tokenCount) && tokenCount >= 0) {',
    '                cacheObject[cacheKey] = tokenCount;',
    '            }',
    '        })',
    '        .catch(() => {',
    '            // Ignore async tokenizer backfill failures.',
    '        })',
    '        .finally(() => {',
    '            tokenCountBackfillRequests.delete(cacheKey);',
    '        });',
    '',
    '    tokenCountBackfillRequests.set(cacheKey, request);',
    '}',
]);
tokenizerSource = replaceInText(tokenizerSource, tokenizerHelpersBefore, tokenizerHelpersAfter, 'tokenizers:helpers');

const syncHeaderBefore = lines([
    'export function countTokensOpenAI(messages, full = false) {',
    '    if (isFastTokenEstimateEnabled()) {',
    '        return estimateOpenAITokenCount(messages, full);',
    '    }',
    '',
    '    const tokenizerEndpoint = `/api/tokenizers/openai/count?model=${getTokenizerModel()}`;',
    '    const cacheObject = getTokenCacheObject();',
]);
const syncHeaderAfter = lines([
    'export function countTokensOpenAI(messages, full = false) {',
    '    const tokenizerEndpoint = `/api/tokenizers/openai/count?model=${getTokenizerModel()}`;',
    '    const cacheObject = getTokenCacheObject();',
]);
tokenizerSource = replaceInText(tokenizerSource, syncHeaderBefore, syncHeaderAfter, 'tokenizers:sync header');

const asyncHeaderBefore = lines([
    'export async function countTokensOpenAIAsync(messages, full = false) {',
    '    if (isFastTokenEstimateEnabled()) {',
    '        return estimateOpenAITokenCount(messages, full);',
    '    }',
    '',
    '    const tokenizerEndpoint = `/api/tokenizers/openai/count?model=${getTokenizerModel()}`;',
    '    const cacheObject = getTokenCacheObject();',
]);
const asyncHeaderAfter = lines([
    'export async function countTokensOpenAIAsync(messages, full = false) {',
    '    const tokenizerEndpoint = `/api/tokenizers/openai/count?model=${getTokenizerModel()}`;',
    '    const cacheObject = getTokenCacheObject();',
]);
tokenizerSource = replaceInText(tokenizerSource, asyncHeaderBefore, asyncHeaderAfter, 'tokenizers:async header');

const syncMissBefore = lines([
    '        }',
    '',
    '        else {',
    '            jQuery.ajax({',
    '                async: false,',
    "                type: 'POST', //",
    '                url: tokenizerEndpoint,',
    '                data: JSON.stringify([message]),',
    "                dataType: 'json',",
    "                contentType: 'application/json',",
    '                success: function (data) {',
    '                    token_count += Number(data.token_count);',
    '                    cacheObject[cacheKey] = Number(data.token_count);',
    '                },',
    '            });',
    '        }',
]);
const syncMissAfter = lines([
    '        } else if (isFastTokenEstimateEnabled()) {',
    '            token_count += estimateOpenAITokenCountForMessage(message);',
    '            enqueueOpenAITokenCountBackfill(tokenizerEndpoint, cacheObject, cacheKey, message);',
    '        } else {',
    '            jQuery.ajax({',
    '                async: false,',
    "                type: 'POST', //",
    '                url: tokenizerEndpoint,',
    '                data: JSON.stringify([message]),',
    "                dataType: 'json',",
    "                contentType: 'application/json',",
    '                success: function (data) {',
    '                    token_count += Number(data.token_count);',
    '                    cacheObject[cacheKey] = Number(data.token_count);',
    '                },',
    '            });',
    '        }',
]);
tokenizerSource = replaceInText(tokenizerSource, syncMissBefore, syncMissAfter, 'tokenizers:sync miss path');

const asyncMissBefore = lines([
    '        }',
    '',
    '        else {',
    '            const data = await jQuery.ajax({',
    '                async: true,',
    "                type: 'POST', //",
    '                url: tokenizerEndpoint,',
    '                data: JSON.stringify([message]),',
    "                dataType: 'json',",
    "                contentType: 'application/json',",
    '            });',
    '',
    '            token_count += Number(data.token_count);',
    '            cacheObject[cacheKey] = Number(data.token_count);',
    '        }',
]);
const asyncMissAfter = lines([
    '        } else if (isFastTokenEstimateEnabled()) {',
    '            token_count += estimateOpenAITokenCountForMessage(message);',
    '            enqueueOpenAITokenCountBackfill(tokenizerEndpoint, cacheObject, cacheKey, message);',
    '        } else {',
    '            const data = await jQuery.ajax({',
    '                async: true,',
    "                type: 'POST', //",
    '                url: tokenizerEndpoint,',
    '                data: JSON.stringify([message]),',
    "                dataType: 'json',",
    "                contentType: 'application/json',",
    '            });',
    '',
    '            token_count += Number(data.token_count);',
    '            cacheObject[cacheKey] = Number(data.token_count);',
    '        }',
]);
tokenizerSource = replaceInText(tokenizerSource, asyncMissBefore, asyncMissAfter, 'tokenizers:async miss path');

fs.writeFileSync(tokenizersPath, tokenizerSource);
console.log('Patched:', tokenizersPath);
