type Table = Record<string, unknown>;
/** Deliberately bounded TOML subset, rejected rather than guessed when unsupported. */
export declare function parseTOML(text: string): Table;
export {};
