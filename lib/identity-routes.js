import { readIdentityFiles, writeIdentityFile } from './identity.js';
/** Unified JSON response (route use). */
function writeJson(res, status, body) {
    try {
        const r = res;
        r.writeHead?.(status, { 'content-type': 'application/json' });
        r.end?.(JSON.stringify(body));
    }
    catch {
        /* response failure is not fatal */
    }
}
/** Read a POST JSON body (64 KB cap; empty body = {}). */
function readJsonBody(req, maxBytes = 65_536) {
    return new Promise((resolve, reject) => {
        const r = req;
        const chunks = [];
        let size = 0;
        r.on?.('data', (chunk) => {
            const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''));
            size += buf.length;
            if (size > maxBytes) {
                reject(new Error('request body too large'));
                return;
            }
            chunks.push(buf);
        });
        r.on?.('end', () => {
            if (chunks.length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            }
            catch (e) {
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        });
        r.on?.('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
    });
}
/**
 * Register the `/memory/identity` route. Returns a disposer that only cancels the
 * registration retry timer; the route itself lives in a ctx.effect so the fiber
 * un-registers it on dispose.
 */
export function registerIdentityRoutes(ctx, store) {
    let routeTimer;
    let done = false;
    const tryRegister = (attempt) => {
        if (done)
            return;
        const ws = ctx.get?.('webServer');
        if (ws !== undefined && typeof ws.register === 'function') {
            const register = ws.register;
            try {
                ctx.effect(() => register({
                    kind: 'exact',
                    path: '/memory/identity',
                    handler: (req, res) => {
                        void (async () => {
                            try {
                                const method = req.method;
                                if (method === 'POST') {
                                    const body = await readJsonBody(req);
                                    const file = body.file === 'soul' || body.file === 'user' ? body.file : undefined;
                                    const content = typeof body.content === 'string' ? body.content : '';
                                    if (file === undefined) {
                                        writeJson(res, 400, { ok: false, error: "file must be 'soul' or 'user'" });
                                        return;
                                    }
                                    writeIdentityFile(store.dir, file, content);
                                    writeJson(res, 200, { ok: true });
                                    return;
                                }
                                const files = readIdentityFiles(store.dir);
                                writeJson(res, 200, { ok: true, soul: files.soul, user: files.user });
                            }
                            catch (e) {
                                writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
                            }
                        })();
                    },
                }));
            }
            catch (e) {
                if (!done)
                    console.warn('[dsh-memory] identity route registration failed:', e instanceof Error ? e.message : e);
            }
            return;
        }
        if (attempt < 20)
            routeTimer = setTimeout(() => tryRegister(attempt + 1), 1000);
        else
            console.warn('[dsh-memory] webServer service unavailable; identity routes not registered');
    };
    tryRegister(0);
    return () => {
        done = true;
        if (routeTimer !== undefined)
            clearTimeout(routeTimer);
    };
}
