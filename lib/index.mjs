import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

//#region paths
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const BUNDLED_VIDEO = join(PKG_ROOT, "assets", "boot-fish.mp4");

/**
 * Locate the profile this package is installed into.
 *
 * `DSH_PROFILE_DIR` is a tool-shell convenience variable, not a guarantee inside
 * the host process, so deriving the profile from our own install path is the
 * dependable route — and it keeps working when the harness home moves drive.
 */
function resolveProfileDir() {
	const fromEnv = process.env.DSH_PROFILE_DIR;
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
	// Installed as <home>/profiles/<name>/node_modules/<package>.
	if (basename(dirname(PKG_ROOT)) === "node_modules" && basename(dirname(dirname(dirname(PKG_ROOT)))) === "profiles") {
		return dirname(dirname(PKG_ROOT));
	}
	const home = process.env.DSH_HOME;
	if (typeof home === "string" && home.trim() !== "") return join(home.trim(), "profiles", "desktop");
	return join(homedir(), ".dsh", "profiles", "desktop");
}

const PROFILE_DIR = resolveProfileDir();
/** Hand-editable copy of every knob the startup animation reads. */
const CONFIG_PATH = join(PROFILE_DIR, "fish-boot.json");
//#endregion

//#region configuration
/** Defaults chosen so the clip bows out as soon as the shell is ready. */
const DEFAULTS = Object.freeze({
	enabled: true,
	source: "",
	muted: true,
	loop: false,
	/** Leave as soon as the app has finished booting; see `minSeconds`/`maxSeconds` for the bounds. */
	waitForApp: true,
	minSeconds: 0,
	maxSeconds: 0,
	skippable: true,
	hideBootScreen: true,
	fadeMs: 450,
	scale: "contain",
	backgroundColor: "#000000"
});

const BOOLEAN_KEYS = ["enabled", "muted", "loop", "skippable", "hideBootScreen", "waitForApp"];

function clampNumber(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** Coerce whatever is on disk or in the request body into the shape the client expects. */
function normalize(raw) {
	const input = raw !== null && typeof raw === "object" ? raw : {};
	const out = { ...DEFAULTS };
	for (const key of BOOLEAN_KEYS) {
		if (typeof input[key] === "boolean") out[key] = input[key];
	}
	if (typeof input.source === "string") out.source = input.source.trim();
	out.minSeconds = clampNumber(input.minSeconds, DEFAULTS.minSeconds, 0, 60);
	out.maxSeconds = clampNumber(input.maxSeconds, DEFAULTS.maxSeconds, 0, 600);
	out.fadeMs = Math.round(clampNumber(input.fadeMs, DEFAULTS.fadeMs, 0, 5000));
	out.scale = input.scale === "cover" ? "cover" : "contain";
	if (typeof input.backgroundColor === "string" && /^#[0-9a-fA-F]{3,8}$/u.test(input.backgroundColor.trim())) {
		out.backgroundColor = input.backgroundColor.trim();
	}
	return out;
}

async function saveConfig(config) {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/**
 * Strip a UTF-8 BOM. Windows editors and PowerShell 5.1's `Set-Content -Encoding
 * UTF8` both add one, and `JSON.parse` rejects it outright — a config that looks
 * fine in Notepad would otherwise silently read as defaults forever.
 */
function stripBom(text) {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Read the config, healing it into existence so the user can edit it by hand. */
async function loadConfig(logger) {
	let raw;
	try {
		raw = await readFile(CONFIG_PATH, "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") logger?.warn?.(error);
		const fallback = normalize(DEFAULTS);
		try {
			await saveConfig(fallback);
		} catch (writeError) {
			logger?.warn?.(writeError);
		}
		return fallback;
	}
	let parsed;
	try {
		parsed = JSON.parse(stripBom(raw));
	} catch (error) {
		logger?.warn?.(`dsh-fish-boot: ${CONFIG_PATH} is not valid JSON, falling back to defaults`);
		logger?.warn?.(error);
		return normalize(DEFAULTS);
	}
	return normalize({ ...DEFAULTS, ...parsed });
}

/** Resolve a configured source to an absolute path; empty means the bundled clip. */
function resolveVideo(source) {
	const value = typeof source === "string" ? source.trim() : "";
	if (value === "" || value === "bundled") return BUNDLED_VIDEO;
	return isAbsolute(value) ? value : resolve(PROFILE_DIR, value);
}

const CONTENT_TYPES = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".webm": "video/webm",
	".ogv": "video/ogg",
	".gif": "image/gif",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp"
};
//#endregion

//#region http helpers
const local = (value) => value === "localhost" || value?.startsWith("localhost:") === true || value === "127.0.0.1" || value?.startsWith("127.0.0.1:") === true || value === "[::1]" || value?.startsWith("[::1]:") === true;

/**
 * The desktop shell serves the product page from `dsh-app://app`, so every fetch
 * it makes carries that Origin instead of a localhost one. Accepting it is what
 * lets the settings panel save; every other rule stays localhost-only.
 */
const TRUSTED_APP_SCHEME = "dsh-app:";
const TRUSTED_APP_HOSTS = new Set(["app", "shell"]);

function trustedOrigin(origin) {
	// Same-origin GETs arrive without an Origin header, and a page cannot forge one.
	if (typeof origin !== "string" || origin === "") return true;
	let url;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (local(url.host)) return true;
	return url.protocol === TRUSTED_APP_SCHEME && TRUSTED_APP_HOSTS.has(url.host);
}

/** Only the app's own origins may read or rewrite this plugin's state. */
function trusted(req) {
	if (!local(req.headers.host)) return false;
	return trustedOrigin(req.headers.origin);
}

function sendJson(res, status, body) {
	const payload = Buffer.from(JSON.stringify(body), "utf8");
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(payload.length),
		"cache-control": "no-store"
	});
	res.end(payload);
}

async function readJsonBody(req, limit = 64 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new Error("request body too large");
		chunks.push(chunk);
	}
	if (size === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Serve the clip, honouring Range so the element can seek and loop cleanly. */
async function serveVideo(req, res, file, logger) {
	let info;
	try {
		info = await stat(file);
	} catch {
		sendJson(res, 404, { error: "video not found", path: file });
		return;
	}
	if (!info.isFile()) {
		sendJson(res, 404, { error: "not a file", path: file });
		return;
	}
	const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
	const total = info.size;
	const range = req.headers.range;
	const base = {
		"content-type": type,
		"accept-ranges": "bytes",
		"cache-control": "no-store"
	};

	if (typeof range === "string") {
		const match = /^bytes=(\d*)-(\d*)$/u.exec(range.trim());
		if (match === null) {
			res.writeHead(416, { ...base, "content-range": `bytes */${String(total)}` });
			res.end();
			return;
		}
		const [, rawStart, rawEnd] = match;
		let start;
		let end;
		if (rawStart === "") {
			const suffix = Number(rawEnd);
			if (!Number.isFinite(suffix) || suffix <= 0) {
				res.writeHead(416, { ...base, "content-range": `bytes */${String(total)}` });
				res.end();
				return;
			}
			start = Math.max(0, total - suffix);
			end = total - 1;
		} else {
			start = Number(rawStart);
			end = rawEnd === "" ? total - 1 : Number(rawEnd);
		}
		if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
			res.writeHead(416, { ...base, "content-range": `bytes */${String(total)}` });
			res.end();
			return;
		}
		end = Math.min(end, total - 1);
		res.writeHead(206, {
			...base,
			"content-range": `bytes ${String(start)}-${String(end)}/${String(total)}`,
			"content-length": String(end - start + 1)
		});
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		createReadStream(file, { start, end }).on("error", (error) => {
			logger?.warn?.(error);
			res.destroy();
		}).pipe(res);
		return;
	}

	res.writeHead(200, { ...base, "content-length": String(total) });
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	createReadStream(file).on("error", (error) => {
		logger?.warn?.(error);
		res.destroy();
	}).pipe(res);
}
//#endregion

//#region plugin
const name = "dsh-fish-boot";
const inject = ["webServer", "clientModules"];

function apply(ctx) {
	const logger = ctx.logger;
	logger?.info?.(`dsh-fish-boot: config at ${CONFIG_PATH}`);

	/** Whether the browser-side bundle made it into the served client graph. */
	const clientRegistered = () => {
		try {
			const graph = ctx.clientModules?.graph?.();
			return graph?.entries?.some((entry) => entry.id === name) === true;
		} catch {
			return false;
		}
	};

	ctx.inject(["webServer"], (webCtx) => webCtx.effect(() => {
		const disposeConfig = webCtx.webServer.register({
			kind: "exact",
			path: "/fish-boot/config",
			handler: async (req, res) => {
				if (!trusted(req)) {
					res.writeHead(403);
					res.end();
					return;
				}
				if (req.method === "GET" || req.method === "HEAD") {
					const config = await loadConfig(logger);
					const videoPath = resolveVideo(config.source);
					let videoBytes = null;
					try {
						videoBytes = (await stat(videoPath)).size;
					} catch {
						videoBytes = null;
					}
					sendJson(res, 200, {
						config,
						profileDir: PROFILE_DIR,
						configPath: CONFIG_PATH,
						bundledVideo: BUNDLED_VIDEO,
						videoPath,
						videoBytes,
						clientRegistered: clientRegistered()
					});
					return;
				}
				if (req.method === "POST") {
					let patch;
					try {
						patch = await readJsonBody(req);
					} catch (error) {
						sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid body" });
						return;
					}
					const current = await loadConfig(logger);
					const resetting = patch !== null && typeof patch === "object" && patch.reset === true;
					const next = resetting ? normalize(DEFAULTS) : normalize({ ...current, ...patch });
					await saveConfig(next);
					sendJson(res, 200, {
						config: next,
						configPath: CONFIG_PATH,
						bundledVideo: BUNDLED_VIDEO,
						videoPath: resolveVideo(next.source)
					});
					return;
				}
				res.writeHead(405, { allow: "GET, HEAD, POST" });
				res.end();
			}
		});

		const disposeVideo = webCtx.webServer.register({
			kind: "exact",
			path: "/fish-boot/video",
			handler: async (req, res) => {
				if (!trusted(req)) {
					res.writeHead(403);
					res.end();
					return;
				}
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405, { allow: "GET, HEAD" });
					res.end();
					return;
				}
				const config = await loadConfig(logger);
				await serveVideo(req, res, resolveVideo(config.source), logger);
			}
		});

		return () => {
			disposeConfig();
			disposeVideo();
		};
	}, "dsh-fish-boot: routes"));
}

export { apply, inject, name };
//#endregion
