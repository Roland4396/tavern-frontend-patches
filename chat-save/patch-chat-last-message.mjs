function once(source, before, after, label) {
    if (source.split(before).length !== 2) throw new Error(`Single-message patch anchor mismatch: ${label}`);
    return source.replace(before, after);
}

export function patchLastMessageFrontend(source) {
    if (source.includes('export async function saveChatMessage(messageId)')) {
        const start = source.indexOf('export async function saveChatMessage(messageId)');
        const end = source.indexOf('\n}\n', start) + 3;
        let body = source.slice(start, end);
        // The actual installed host queues saves without a sequence global.
        // Repair the first deployed candidate without changing native saves.
        if (body.includes('const saveOrder = ++chatSaveSequence;')) {
            body = once(body, '        const saveOrder = ++chatSaveSequence;\n', '', 'remove nonexistent sequence');
            body = once(body, '            order: saveOrder,\n', '', 'retain native order-free queue contract');
        }
        if (body.includes('    await waitUntilCondition(() => !isChatSaving, DEFAULT_SAVE_EDIT_TIMEOUT, 100);')) {
            body = once(body,
                '    await waitUntilCondition(() => !isChatSaving, DEFAULT_SAVE_EDIT_TIMEOUT, 100);',
                '    // Native autosave may legitimately exceed its one-second edit debounce.\n' +
                '    // Queue this save until the current one completes instead of discarding it.\n' +
                '    while (isChatSaving) await new Promise(resolve => setTimeout(resolve, 100));',
                'wait for actual save completion');
        }
        return source.slice(0, start) + body + source.slice(end);
    }
    if (!source.includes('const appendSaveSnapshot = {') || !source.includes('const fullSaveSnapshot = {')) {
        throw new Error('The deployed chat-save snapshot correction must be preserved');
    }
    source = once(source,
        "import { enqueueLatestSave, setLatestSaveBaseline } from './scripts/latest-save-queue.js';",
        "import { enqueueLatestSave, setLatestSaveBaseline } from './scripts/latest-save-queue.js';\nimport { splitLastSavedMessage, hashSavedMessage } from './scripts/chat-last-message-client.js';",
        'native helper import');
    const start = source.indexOf('export async function saveChatConditional()');
    const end = source.indexOf('\n}\n', start) + 3;
    if (start < 0 || end < start) throw new Error('saveChatConditional boundary not found');
    const addition = `

/** Save only an edited final message. Older-message/group editing stays native. */
export async function saveChatMessage(messageId) {
    if (selected_group || !Number.isSafeInteger(messageId) || messageId !== chat.length - 1) {
        return saveChatConditional();
    }
    // Native autosave may legitimately exceed its one-second edit debounce.
    // Queue this save until the current one completes instead of discarding it.
    while (isChatSaving) await new Promise(resolve => setTimeout(resolve, 100));
    isChatSaving = true;
    try {
        cancelDebouncedChatSave();
        const fileName = characters[this_chid]?.chat;
        const previousBaseline = lastSavedChatHash;
        const tail = splitLastSavedMessage(previousBaseline);
        if (!fileName || fileName !== lastSavedChatName || chat.length !== lastSavedChatLength || !tail) {
            await saveChat();
            return;
        }
        const serializedMessage = JSON.stringify(chat[messageId]);
        if (serializedMessage === tail.messageJson) return;
        const snapshot = {
            file_name: fileName,
            avatar_url: characters[this_chid].avatar,
            messageId,
            expectedMessages: chat.length,
            message: JSON.parse(serializedMessage),
        };
        snapshot.expectedMessageHash = await hashSavedMessage(tail.messageJson);
        const body = JSON.stringify(snapshot);
        const queued = await enqueueLatestSave({
            key: 'chat:' + fileName,
            fingerprint: 'single-message:' + body,
            item: body,
            save: async payload => {
                const request = await compressRequest({
                    method: 'POST', cache: 'no-cache', headers: getRequestHeaders(), body: payload,
                });
                const response = await fetch('/api/chats/save-message', request);
                const data = await response.json().catch(() => ({}));
                return { ok: response.ok, status: response.status, data };
            },
        });
        if (queued.status === 'superseded' || queued.status === 'skipped') return;
        if (!queued.result?.ok) {
            // Do not overwrite a newer disk message with a stale full snapshot.
            throw new Error('单条回复保存失败：' + (queued.result?.data?.error || queued.result?.status || 'unknown'));
        }
        if (lastSavedChatName === fileName && lastSavedChatLength === snapshot.expectedMessages
            && lastSavedChatHash === previousBaseline) {
            // Only this row was persisted: keep the historical/header baseline
            // unchanged, including any unrelated edits still waiting to save.
            lastSavedChatHash = tail.prefix + serializedMessage + ']';
        }
        saveTokenCache();
        saveItemizedPrompts(fileName);
    } finally {
        isChatSaving = false;
    }
}
`;
    return source.slice(0, end) + addition + source.slice(end);
}

export function patchLastMessageBackend(source) {
    if (source.includes("router.post('/save-message',")) return source;
    source = once(source, "import express from 'express';", "import express from 'express';\nimport { replaceLastChatMessage } from '../chat-last-message-save.mjs';", 'backend helper import');
    source = once(source,
        '        const backupFile = path.join(directory,',
        "        if (typeof data === 'function') data = data();\n        const backupFile = path.join(directory,", 'lazy existing backup input');
    const route = `router.post('/save-message', validateAvatarUrlMiddleware, function (request, response) {
    try {
        const cardName = String(request.body.avatar_url).replace('.png', '');
        const chatFileName = String(request.body.file_name) + '.jsonl';
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) return response.sendStatus(400);
        const result = replaceLastChatMessage(chatFilePath, request.body);
        if (result.ok && !result.unchanged) {
            // Retain the native throttled backup policy, without retaining a
            // whole-chat string or reading the file when a backup is not due.
            getBackupFunction(request.user.profile.handle)(request.user.directories.backups, cardName,
                () => fs.readFileSync(chatFilePath, 'utf8'));
        }
        return response.status(result.status || 200).send(result);
    } catch (error) {
        console.error('Single-message save error:', error);
        return response.status(500).send({ error: 'message_save_failed' });
    }
});

`;
    return once(source, "router.post('/save-append',", route + "router.post('/save-append',", 'additive route');
}
