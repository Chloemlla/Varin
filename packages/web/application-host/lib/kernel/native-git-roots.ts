import path from 'node:path';
import { readFile, stat, opendir, realpath } from 'node:fs/promises';
import type { DocumentAuthority } from '../documents/authority.js';
/** Follow Git's declared administrative dependencies, not all repository files.
 * Every external directory crosses the same Documents deployment boundary. */
export async function nativeGitRoots(root: string, documents: Pick<DocumentAuthority, 'resolveWorkspace' | 'admitWorkspaceRegistration'>, signal?: AbortSignal): Promise<string[]> {
    const admitted = new Set<string>();
    const visited = new Set<string>();
    const sourceRoot = await realpath(root);
    const text = async (file: string) => {
        signal?.throwIfAborted();
        try {
            return await readFile(file, 'utf8');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return null;
            throw error;
        }
    };
    const admit = async (directory: string) => {
        signal?.throwIfAborted();
        const canonical = await realpath(directory);
        if (visited.has(canonical)) return null;
        visited.add(canonical);
        const relative = path.relative(sourceRoot, canonical);
        // The admitted project root already covers its own Git directories.
        // Only linked administration/alternates outside it need another root.
        if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) return canonical;
        const resolved = await documents.resolveWorkspace({ path: directory });
        const mapping = await documents.admitWorkspaceRegistration(resolved.workspaceId, signal);
        if (admitted.has(mapping.canonicalPath))
            return null;
        admitted.add(mapping.canonicalPath);
        return mapping.canonicalPath;
    };
    const objects = async (directory: string): Promise<void> => {
        const canonical = await admit(directory);
        if (!canonical)
            return;
        const alternates = await text(path.join(canonical, 'info', 'alternates'));
        if (alternates)
            for (const alternate of alternates.split(/\r?\n/).filter(Boolean))
                await objects(path.resolve(canonical, alternate));
    };
    const repository = async (directory: string) => {
        const marker = path.join(directory, '.git');
        const info = await stat(marker).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return null;
            throw error;
        });
        if (!info)
            return;
        let admin = marker;
        if (info.isFile()) {
            const pointer = (await text(marker))?.trim();
            if (!pointer?.startsWith('gitdir:'))
                throw new Error('The project Git administration pointer is invalid');
            admin = path.resolve(directory, pointer.slice(7).trim());
        }
        const privateRoot = await admit(admin);
        if (!privateRoot)
            return;
        const common = (await text(path.join(privateRoot, 'commondir')))?.trim();
        const commonRoot = common ? await admit(path.resolve(privateRoot, common)) : privateRoot;
        if (commonRoot && await stat(path.join(commonRoot, 'objects')).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return null;
            throw error;
        }))
            await objects(path.join(commonRoot, 'objects'));
    };
    // First adoption may contain several repositories or linked checkouts. Only
    // discover markers here; bodies and stability checks remain Rust's one import.
    // Never follow workspace symlinks or descend into Git administration itself.
    const pending = [root];
    // libuv's default pool has four threads. Bound both open directory handles and
    // authority probes instead of fanning out over an arbitrarily large workspace.
    const scan = async (directory: string): Promise<string[]> => {
        const children: string[] = [];
        const entries = await opendir(directory);
        for await (const entry of entries) {
            signal?.throwIfAborted();
            if (entry.name === '.git') {
                try { await repository(directory); }
                catch (error) {
                    signal?.throwIfAborted();
                    throw new Error(`Cannot inspect Git administration for ${directory}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
                }
            }
            if (entry.isDirectory() && !entry.isSymbolicLink() && !['.git', '.varin'].includes(entry.name))
                children.push(path.join(directory, entry.name));
        }
        return children;
    };
    while (pending.length) {
        signal?.throwIfAborted();
        const directories = pending.splice(Math.max(0, pending.length - 4));
        const scanned = await Promise.allSettled(directories.map(scan));
        signal?.throwIfAborted();
        for (const result of scanned) {
            if (result.status === 'rejected') throw result.reason;
            for (const child of result.value) pending.push(child);
        }
    }
    return [...admitted].sort();
}
