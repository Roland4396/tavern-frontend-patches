function replaceExactlyOnce(source, before, after, label) {
    if (source.split(before).length !== 2) {
        throw new Error(`Chat save snapshot patch anchor mismatch: ${label}`);
    }
    return source.replace(before, after);
}

/** Keep incremental-save baselines tied to the serialized request, not live objects. */
export function patchChatSaveSnapshot(source) {
    const start = source.indexOf('export async function saveChat(');
    const end = source.indexOf('\n}\n', start) + 3;
    if (start < 0 || end < start) throw new Error('saveChat function boundary not found');
    let body = source.slice(start, end);
    const hasAppend = body.includes('const appendSaveSnapshot = {');
    const hasFull = body.includes('const fullSaveSnapshot = {');
    if (hasAppend && hasFull) return source;
    if (hasAppend || hasFull) throw new Error('Partial chat save snapshot patch detected');

    body = replaceExactlyOnce(body,
        '            const appendRequest = await compressRequest({',
        '            // The HTTP request owns this snapshot even if a plugin edits chat during await.\n' +
        '            const appendSaveSnapshot = {\n' +
        '                length: trimmedChat.length,\n' +
        '                hash: computeChatHash(trimmedChat, trimmedChat.length),\n' +
        '            };\n' +
        '            const appendRequest = await compressRequest({',
        'append snapshot before async compression');
    body = replaceExactlyOnce(body,
        '                lastSavedChatLength = trimmedChat.length;\n' +
        '                lastSavedChatHash = computeChatHash(trimmedChat, trimmedChat.length);',
        '                lastSavedChatLength = appendSaveSnapshot.length;\n' +
        '                lastSavedChatHash = appendSaveSnapshot.hash;',
        'append snapshot commit');
    body = replaceExactlyOnce(body,
        '        const fullSaveKey = `chat:${fileName}`;',
        '        const fullSaveSnapshot = {\n' +
        '            length: trimmedChat.length,\n' +
        '            hash: computeChatHash(trimmedChat, trimmedChat.length),\n' +
        '        };\n' +
        '        const fullSaveKey = `chat:${fileName}`;',
        'full snapshot after synchronous serialization');
    body = replaceExactlyOnce(body,
        '            lastSavedChatLength = trimmedChat.length;\n' +
        '            lastSavedChatHash = computeChatHash(trimmedChat, trimmedChat.length);',
        '            lastSavedChatLength = fullSaveSnapshot.length;\n' +
        '            lastSavedChatHash = fullSaveSnapshot.hash;',
        'full snapshot commit');
    return source.slice(0, start) + body + source.slice(end);
}
