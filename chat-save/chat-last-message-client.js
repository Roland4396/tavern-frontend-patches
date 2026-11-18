// Read only the final object of the native JSON-array save baseline. Do not
// parse/stringify the historical messages to persist one edited final reply.
export function splitLastSavedMessage(serialized) {
    if (typeof serialized !== 'string' || serialized.at(-1) !== ']') return null;
    let depth = 0, quoted = false;
    for (let i = serialized.length - 2; i >= 0; i--) {
        const c = serialized[i];
        if (c === '"') {
            let escapes = 0;
            for (let j = i - 1; j >= 0 && serialized[j] === '\\'; j--) escapes++;
            if (escapes % 2 === 0) quoted = !quoted;
            continue;
        }
        if (quoted) continue;
        if (c === '}' || c === ']') depth++;
        else if (c === '{' || c === '[') {
            depth--;
            if (depth === 0 && c === '{') {
                return { prefix: serialized.slice(0, i), messageJson: serialized.slice(i, -1) };
            }
            if (depth < 0) return null;
        }
    }
    return null;
}

export async function hashSavedMessage(serialized) {
    const bytes = new TextEncoder().encode(serialized);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
