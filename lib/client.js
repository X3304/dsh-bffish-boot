window.__ModuleLoader__.load({
	id: "dsh-fish-boot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region runtime
		const reactModule = require("react");
		const React = reactModule && reactModule.useState ? reactModule : reactModule.default ?? reactModule;
		const { useEffect, useRef, useState } = React;
		const h = React.createElement;

		const name = "dsh-fish-boot-client";
		const inject = ["slots"];

		const CONFIG_URL = "/fish-boot/config";
		const VIDEO_URL = "/fish-boot/video";
		const OVERLAY_ATTR = "data-dsh-fish-boot";
		const STYLE_ID = "dsh-fish-boot-style";

		const IMAGE_PATTERN = /\.(gif|png|jpe?g|webp|avif)$/iu;
		const HARD_CAP_MS = 120000;

		/** Keeps the native "Loading plugins…" card out of sight while the clip plays. */
		function applyBootCss(hide) {
			const existing = document.getElementById(STYLE_ID);
			if (!hide) {
				existing?.remove();
				return;
			}
			const style = existing ?? document.createElement("style");
			if (existing === null) {
				style.id = STYLE_ID;
				document.head.appendChild(style);
			}
			style.textContent = "[data-dsh-boot]{display:none!important}";
		}
		//#endregion

		//#region overlay
		const number = (value, fallback) => {
			const n = Number(value);
			return Number.isFinite(n) ? n : fallback;
		};

		/**
		 * Mount a black shell the instant the client module loads, so the app never
		 * flashes before configuration arrives. `play` swaps in the media, `close`
		 * always returns the screen to the app.
		 */
		/**
		 * Resolve once the native boot screen has come and gone — the moment the
		 * shell is about to paint. Gating on this instead of on the clip length is
		 * what stops the animation from being slower than a plain launch.
		 */
		function whenAppReady(onReady, graceMs) {
			let sawBoot = document.querySelector("[data-dsh-boot]") !== null;
			let stopped = false;
			let observer = null;
			let poll = 0;
			let grace = 0;

			const stop = () => {
				stopped = true;
				if (observer !== null) observer.disconnect();
				window.clearInterval(poll);
				window.clearTimeout(grace);
			};
			const finish = () => {
				if (stopped) return;
				stop();
				onReady();
			};
			const check = () => {
				if (stopped) return;
				if (document.querySelector("[data-dsh-boot]") !== null) {
					sawBoot = true;
					return;
				}
				if (sawBoot) finish();
			};

			if (typeof MutationObserver === "function") {
				observer = new MutationObserver(check);
				observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
			}
			poll = window.setInterval(check, 150);
			// No boot screen in sight means no readiness signal at all: give up
			// waiting instead of eating the whole clip.
			grace = window.setTimeout(() => {
				if (!sawBoot) finish();
			}, graceMs);
			check();
			return stop;
		}

		function createShell() {
			const started = performance.now();
			const host = document.createElement("div");
			host.setAttribute(OVERLAY_ATTR, "");
			host.setAttribute("role", "presentation");
			host.style.cssText = [
				"position:fixed",
				"inset:0",
				"z-index:2147483600",
				"display:flex",
				"align-items:center",
				"justify-content:center",
				"overflow:hidden",
				"background:#000",
				"opacity:1"
			].join(";");
			(document.body ?? document.documentElement).appendChild(host);

			let media = null;
			let closed = false;
			let fadeMs = 0;
			let minMs = 0;
			let cancelReady = null;
			const timers = new Set();
			const later = (fn, ms) => {
				const id = window.setTimeout(() => {
					timers.delete(id);
					fn();
				}, ms);
				timers.add(id);
			};

			const detachInput = () => {
				document.removeEventListener("keydown", onKey, true);
				host.removeEventListener("click", onClick, true);
			};

			function close(reason) {
				if (closed) return;
				closed = true;
				if (cancelReady !== null) {
					cancelReady();
					cancelReady = null;
				}
				for (const id of timers) window.clearTimeout(id);
				timers.clear();
				detachInput();
				host.style.transition = `opacity ${String(fadeMs)}ms ease`;
				host.style.opacity = "0";
				later(() => {
					try {
						if (media !== null && media.tagName === "VIDEO") {
							media.pause();
							media.removeAttribute("src");
							media.load();
						}
					} catch {
						/* the element is being torn down either way */
					}
					host.remove();
					applyBootCss(false);
				}, fadeMs);
				if (reason === "error" || reason === "blocked") {
					// Nothing to fade from: drop it now so the app is reachable.
					for (const id of timers) window.clearTimeout(id);
					timers.clear();
					host.remove();
					applyBootCss(false);
				}
			}

			const elapsed = () => performance.now() - started;
			const canSkip = () => elapsed() >= minMs;

			/** Honour `minSeconds`, then leave. */
			const requestClose = (reason) => {
				const remaining = minMs - elapsed();
				if (remaining > 0) {
					later(() => {
						close(reason);
					}, remaining);
					return;
				}
				close(reason);
			};

			function onKey(event) {
				if (event.key !== "Escape" && event.key !== "Enter" && event.key !== " ") return;
				if (!canSkip()) return;
				event.preventDefault();
				event.stopPropagation();
				close("skip");
			}

			function onClick(event) {
				if (!canSkip()) return;
				event.preventDefault();
				event.stopPropagation();
				close("skip");
			}

			function play(config, videoPath) {
				const cfg = config ?? {};
				fadeMs = Math.max(0, number(cfg.fadeMs, 0));
				minMs = Math.max(0, number(cfg.minSeconds, 0)) * 1000;
				applyBootCss(cfg.hideBootScreen !== false);
				host.style.background = typeof cfg.backgroundColor === "string" ? cfg.backgroundColor : "#000";
				host.style.transition = `opacity ${String(fadeMs)}ms ease`;

				const isImage = IMAGE_PATTERN.test(String(videoPath ?? ""));
				const src = `${VIDEO_URL}?t=${String(Date.now())}`;

				if (isImage) {
					media = document.createElement("img");
					media.alt = "";
					media.decoding = "async";
					media.onload = () => {
						const hold = number(cfg.maxSeconds, 0);
						later(() => {
							close("ended");
						}, Math.max(800, hold > 0 ? hold * 1000 : 3000));
					};
					media.onerror = () => {
						close("error");
					};
					media.src = src;
				} else {
					media = document.createElement("video");
					media.autoplay = true;
					media.playsInline = true;
					media.preload = "auto";
					media.muted = cfg.muted !== false;
					media.loop = cfg.loop === true;
					media.addEventListener("ended", () => {
						if (cfg.loop !== true) close("ended");
					});
					media.addEventListener("error", () => {
						close("error");
					});
					media.src = src;
					const attempt = media.play();
					if (attempt && typeof attempt.catch === "function") {
						attempt.catch(() => {
							if (media.muted === true) {
								close("blocked");
								return;
							}
							// Chromium refuses to start unmuted media without a gesture;
							// fall back to silence rather than losing the whole animation.
							media.muted = true;
							const retry = media.play();
							if (retry && typeof retry.catch === "function") retry.catch(() => { close("blocked"); });
						});
					}
				}

				media.style.cssText = [
					"width:100%",
					"height:100%",
					`object-fit:${cfg.scale === "cover" ? "cover" : "contain"}`,
					"background:#000",
					"display:block"
				].join(";");
				host.appendChild(media);

				if (cfg.skippable !== false) {
					const hint = document.createElement("div");
					hint.textContent = "点击或按 Esc 跳过";
					hint.style.cssText = [
						"position:absolute",
						"right:18px",
						"bottom:16px",
						"padding:6px 10px",
						"border-radius:999px",
						"font:12px/1.4 system-ui,sans-serif",
						"color:rgba(255,255,255,.82)",
						"background:rgba(0,0,0,.45)",
						"pointer-events:none",
						"opacity:0",
						"transition:opacity .3s ease"
					].join(";");
					host.appendChild(hint);
					later(() => {
						hint.style.opacity = "1";
					}, 600);
					document.addEventListener("keydown", onKey, true);
					host.addEventListener("click", onClick, true);
				}

				const max = number(cfg.maxSeconds, 0);
				if (max > 0) later(() => { close("timeout"); }, max * 1000);
				else later(() => { close("timeout"); }, HARD_CAP_MS);

				// Optional fast path: leave the moment the shell is ready, so a long
				// clip never costs extra startup time. `minSeconds` still sets a floor.
				if (cfg.waitForApp === true) {
					cancelReady = whenAppReady(() => {
						requestClose("ready");
					}, 4000);
				}
			}

			return { play, close };
		}

		async function fetchConfig() {
			const response = await fetch(CONFIG_URL, {
				signal: AbortSignal.timeout(15000),
				headers: { accept: "application/json" }
			});
			if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
			return response.json();
		}

		async function startBootAnimation() {
			const shell = createShell();
			let payload;
			try {
				payload = await fetchConfig();
			} catch {
				shell.close("error");
				return;
			}
			const config = payload?.config ?? null;
			if (config === null || config.enabled === false) {
				shell.close("error");
				return;
			}
			shell.play(config, payload?.videoPath ?? "");
		}
		//#endregion

		//#region settings UI
		const COLORS = {
			text: "var(--dsw-alias-label-primary, #f4f4f5)",
			dim: "var(--dsw-alias-label-secondary, #bdbdbd)",
			line: "var(--dsw-alias-border-l2, #4a4a4a)",
			field: "var(--dsw-alias-bg-layer-1, #252525)",
			accent: "var(--dsw-alias-brand-primary, #4d6bfe)"
		};

		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 16,
			padding: "10px 0",
			borderTop: `1px solid ${COLORS.line}`
		};
		const labelStyle = { color: COLORS.text, fontSize: 13, lineHeight: "20px" };
		const hintStyle = { color: COLORS.dim, fontSize: 12, lineHeight: "18px", marginTop: 2 };
		const inputStyle = {
			boxSizing: "border-box",
			minWidth: 120,
			padding: "5px 8px",
			borderRadius: 6,
			border: `1px solid ${COLORS.line}`,
			background: COLORS.field,
			color: COLORS.text,
			fontSize: 13,
			outline: "none"
		};
		const buttonStyle = {
			padding: "6px 12px",
			borderRadius: 6,
			border: `1px solid ${COLORS.line}`,
			background: "transparent",
			color: COLORS.text,
			fontSize: 13,
			cursor: "pointer"
		};

		function Toggle({ checked, onChange }) {
			return h("input", {
				type: "checkbox",
				checked: checked === true,
				onChange: (event) => { onChange(event.target.checked); },
				style: { width: 16, height: 16, cursor: "pointer", accentColor: COLORS.accent }
			});
		}

		function Row({ title, hint, children }) {
			return h("div", { style: rowStyle },
				h("div", { style: { minWidth: 0 } },
					h("div", { style: labelStyle }, title),
					hint ? h("div", { style: hintStyle }, hint) : null),
				h("div", { style: { flex: "0 0 auto" } }, children));
		}

		function FishBootSection() {
			const [payload, setPayload] = useState(null);
			const [draft, setDraft] = useState(null);
			const [busy, setBusy] = useState(false);
			const [note, setNote] = useState("");
			const alive = useRef(true);

			useEffect(() => {
				alive.current = true;
				return () => { alive.current = false; };
			}, []);

			const load = async () => {
				setBusy(true);
				try {
					const data = await fetchConfig();
					if (!alive.current) return;
					setPayload(data);
					setDraft(data.config);
					setNote("");
				} catch (error) {
					if (!alive.current) return;
					setNote(`读取配置失败：${error instanceof Error ? error.message : String(error)}`);
				} finally {
					if (alive.current) setBusy(false);
				}
			};

			useEffect(() => { void load(); }, []);

			const patch = (key, value) => {
				setDraft((current) => ({ ...(current ?? {}), [key]: value }));
			};

			const save = async (silent) => {
				if (silent !== true) setBusy(true);
				try {
					const response = await fetch(CONFIG_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(draft ?? {}),
						signal: AbortSignal.timeout(15000)
					});
					if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
					const data = await response.json();
					if (!alive.current) return null;
					setPayload(data);
					setDraft(data.config);
					setNote("已保存");
					return data;
				} catch (error) {
					if (!alive.current) return null;
					setNote(`保存失败：${error instanceof Error ? error.message : String(error)}`);
					return null;
				} finally {
					if (alive.current && silent !== true) setBusy(false);
				}
			};

			const reset = async () => {
				setBusy(true);
				try {
					const response = await fetch(CONFIG_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ reset: true }),
						signal: AbortSignal.timeout(15000)
					});
					const data = await response.json();
					if (!alive.current) return;
					setPayload(data);
					setDraft(data.config);
					setNote("已恢复默认");
				} catch (error) {
					if (!alive.current) return;
					setNote(`恢复默认失败：${error instanceof Error ? error.message : String(error)}`);
				} finally {
					if (alive.current) setBusy(false);
				}
			};

			const preview = async () => {
				if (draft === null) return;
				// The clip URL always serves whatever is on disk, so persist first —
				// otherwise "预览" would play the previous video and look broken.
				const saved = await save(true);
				const config = saved?.config ?? draft;
				const path = saved?.videoPath ?? (String(config.source ?? "").trim() === "" ? ".mp4" : config.source);
				createShell().play(config, path);
			};

			const header = h("div", { style: { paddingTop: 4, paddingBottom: 8 } },
				h("div", { style: { color: COLORS.text, fontSize: 16, fontWeight: 600 } }, "开机动画"),
				h("div", { style: hintStyle },
					"应用启动时全屏播放一段视频。所有选项都可以直接改 ",
					h("code", { style: { color: COLORS.text } }, "fish-boot.json"),
					"，重启后生效。"));

			if (draft === null) {
				return h("div", { style: { maxWidth: 620 } },
					header,
					h("div", { style: { ...hintStyle, marginTop: 12 } }, busy ? "正在读取…" : note !== "" ? note : "无法读取配置"));
			}

			const numeric = (key, extra) => h("input", {
				type: "number",
				value: String(draft[key] ?? 0),
				min: extra?.min ?? 0,
				max: extra?.max ?? 600,
				step: extra?.step ?? 1,
				onChange: (event) => { patch(key, Number(event.target.value)); },
				style: { ...inputStyle, width: 90 }
			});

			return h("div", { style: { maxWidth: 620, paddingBottom: 24 } },
				header,

				h(Row, { title: "启用", hint: "关掉后启动时不再播放，等同于停用本插件。" },
					h(Toggle, { checked: draft.enabled !== false, onChange: (value) => { patch("enabled", value); } })),

				h(Row, { title: "视频文件", hint: "留空 = 内置大肥鱼。可填绝对路径，或相对 profile 目录的路径；支持 mp4/webm/gif/png。" },
					h("input", {
						type: "text",
						value: draft.source ?? "",
						placeholder: "留空 = 内置",
						onChange: (event) => { patch("source", event.target.value); },
						style: { ...inputStyle, width: 260 }
					})),

				h(Row, { title: "画面填充", hint: "视频比例和窗口不一致时的处理方式。" },
					h("select", {
						value: draft.scale ?? "contain",
						onChange: (event) => { patch("scale", event.target.value); },
						style: { ...inputStyle, width: 110 }
					},
						h("option", { value: "contain" }, "完整显示"),
						h("option", { value: "cover" }, "铺满裁切"))),

				h(Row, { title: "跟随启动完成", hint: "打开后应用一准备好就淡出，启动和不装插件一样快，代价是视频只放一部分。默认关闭：播完整段。" },
					h(Toggle, { checked: draft.waitForApp === true, onChange: (value) => { patch("waitForApp", value); } })),

				h(Row, { title: "最短停留（秒）", hint: "这段时间内点击和 Esc 都无效，用来保证动画至少能被看到。" },
					numeric("minSeconds", { max: 60 })),

				h(Row, { title: "最长播放（秒）", hint: "0 = 一直播到结尾。设成 2 就只在启动时闪两秒。" },
					numeric("maxSeconds", { max: 600 })),

				h(Row, { title: "淡出时长（毫秒）", hint: "视频结束后淡出到应用界面的时间。" },
					numeric("fadeMs", { max: 5000, step: 50 })),

				h(Row, { title: "循环", hint: "只在“最长播放”设了值的时候才有意义。" },
					h(Toggle, { checked: draft.loop === true, onChange: (value) => { patch("loop", value); } })),

				h(Row, { title: "静音", hint: "关掉静音会被浏览器拦截自动播放，通常建议保持开启。" },
					h(Toggle, { checked: draft.muted !== false, onChange: (value) => { patch("muted", value); } })),

				h(Row, { title: "允许跳过", hint: "播放时右下角提示“点击或按 Esc 跳过”。" },
					h(Toggle, { checked: draft.skippable !== false, onChange: (value) => { patch("skippable", value); } })),

				h(Row, { title: "隐藏原生启动屏", hint: "从第一帧就盖住 HARNESS + 转圈那一屏，不等脚本加载；关掉则能看到原生启动屏。" },
					h(Toggle, { checked: draft.hideBootScreen !== false, onChange: (value) => { patch("hideBootScreen", value); } })),

				h(Row, { title: "背景色", hint: "视频黑边区域的颜色。" },
					h("input", {
						type: "text",
						value: draft.backgroundColor ?? "#000000",
						onChange: (event) => { patch("backgroundColor", event.target.value); },
						style: { ...inputStyle, width: 110 }
					})),

				h("div", { style: { display: "flex", gap: 8, marginTop: 16, alignItems: "center", flexWrap: "wrap" } },
					h("button", { type: "button", onClick: () => void save(), disabled: busy, style: { ...buttonStyle, borderColor: COLORS.accent } }, busy ? "处理中…" : "保存"),
					h("button", { type: "button", onClick: preview, disabled: busy, style: buttonStyle }, "预览"),
					h("button", { type: "button", onClick: () => void load(), disabled: busy, style: buttonStyle }, "重新读取"),
					h("button", { type: "button", onClick: () => void reset(), disabled: busy, style: buttonStyle }, "恢复默认"),
					note !== "" ? h("span", { style: { ...hintStyle, marginTop: 0 } }, note) : null),

				h("div", { style: { ...hintStyle, marginTop: 14, wordBreak: "break-all" } },
					"配置文件：", payload?.configPath ?? "(未知)",
					h("br"),
					"当前视频：", payload?.videoPath ?? "(未知)"));
		}
		//#endregion

		//#region plugin entry
		function apply(ctx) {
			if (typeof document === "undefined") return;

			void startBootAnimation().catch(() => {
				/* never let the animation break the shell */
			});

			try {
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "fish-boot",
					order: 90,
					label: () => "开机动画"
				}, FishBootSection));
			} catch {
				/* settings are optional: the animation still runs without them */
			}
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
