/** Create empty soul.md / user.md under `dir` when absent. Files stay empty until
 *  the human writes real content — the injection renderer treats an empty file
 *  as "no identity section". Never touches existing files (a human-authored file
 *  is never overwritten). */
export declare function autocreateIdentityFiles(dir: string): {
    created: string[];
    skipped: string[];
};
/** Read both identity files (missing file → empty string). Used by the settings
 *  UI's identity editor over the HTTP route. */
export declare function readIdentityFiles(dir: string): {
    soul: string;
    user: string;
};
/** Overwrite one identity file with UTF-8 (no BOM — the Windows trap). `file`
 *  is narrowed to the two known names, so a caller cannot escape the identity
 *  directory via path traversal. */
export declare function writeIdentityFile(dir: string, file: 'soul' | 'user', content: string): void;
