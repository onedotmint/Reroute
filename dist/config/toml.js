import { RerouteError, invariant } from '../core/errors.js';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function split(text, delimiter) {
    const parts = [];
    let current = '', quote = '', escaped = false, depth = 0;
    for (const c of text) {
        if (quote) {
            current += c;
            if (escaped)
                escaped = false;
            else if (c === '\\' && quote === '"')
                escaped = true;
            else if (c === quote)
                quote = '';
        }
        else if (c === '"' || c === "'") {
            quote = c;
            current += c;
        }
        else if (c === '[' || c === '{') {
            depth++;
            current += c;
        }
        else if (c === ']' || c === '}') {
            depth--;
            current += c;
        }
        else if (c === delimiter && depth === 0) {
            parts.push(current.trim());
            current = '';
        }
        else
            current += c;
    }
    invariant(!quote && depth === 0, 'CONFIG', 'Unterminated TOML value; multiline strings/tables are not supported');
    return [...parts, current.trim()];
}
function value(text) {
    if (text.startsWith('"')) {
        try {
            return JSON.parse(text);
        }
        catch {
            throw new RerouteError('CONFIG', 'Invalid quoted TOML string');
        }
    }
    if (text.startsWith("'") && text.endsWith("'"))
        return text.slice(1, -1);
    if (text === 'true' || text === 'false')
        return text === 'true';
    if (/^[+-]?\d+(?:\.\d+)?$/.test(text))
        return Number(text);
    if (text.startsWith('[') && text.endsWith(']'))
        return split(text.slice(1, -1), ',').filter(Boolean).map(value);
    if (text.startsWith('{') && text.endsWith('}')) {
        const table = Object.create(null);
        for (const item of split(text.slice(1, -1), ',').filter(Boolean))
            assign(table, item);
        return table;
    }
    throw new RerouteError('CONFIG', `Unsupported TOML value: ${text.slice(0, 60)}. Use quoted strings, numbers, booleans, arrays or inline tables.`);
}
function keys(text) {
    const result = text.split('.').map(k => k.trim());
    invariant(result.every(k => /^[A-Za-z_][\w-]*$/.test(k) && !forbidden.has(k)), 'CONFIG', 'Invalid or unsafe configuration key');
    return result;
}
function descend(table, path) {
    for (const key of path) {
        if (table[key] === undefined)
            table[key] = Object.create(null);
        invariant(table[key] !== null && typeof table[key] === 'object' && !Array.isArray(table[key]), 'CONFIG', 'Conflicting TOML table');
        table = table[key];
    }
    return table;
}
function assign(table, line) {
    const chunks = split(line, '=');
    invariant(chunks.length >= 2, 'CONFIG', 'Expected key = value');
    const path = keys(chunks.shift());
    const leaf = path.pop();
    const target = descend(table, path);
    invariant(!Object.hasOwn(target, leaf), 'CONFIG', 'Duplicate TOML key');
    target[leaf] = value(chunks.join('='));
}
/** Deliberately bounded TOML subset, rejected rather than guessed when unsupported. */
export function parseTOML(text) {
    const root = Object.create(null);
    let current = root;
    text.split(/\r?\n/).forEach((source, index) => {
        let quoted = '', escaped = false, line = '';
        for (const c of source) {
            if (!quoted && c === '#')
                break;
            line += c;
            if (escaped)
                escaped = false;
            else if (quoted === '"' && c === '\\')
                escaped = true;
            else if (quoted && c === quoted)
                quoted = '';
            else if (!quoted && (c === '"' || c === "'"))
                quoted = c;
        }
        line = line.trim();
        if (!line)
            return;
        try {
            if (line.startsWith('[') && line.endsWith(']') && !line.startsWith('[['))
                current = descend(root, keys(line.slice(1, -1)));
            else
                assign(current, line);
        }
        catch (error) {
            throw new RerouteError('CONFIG', `reroute.toml line ${index + 1}: ${error instanceof Error ? error.message : 'Invalid value'}`);
        }
    });
    return root;
}
