/**
 * conv-title client entry — wires the ✨ buttons (chat header + session-row
 * right-click menu) to the plugin server via HTTP.
 *
 * Manifest: view:false + preload:true, so this module's top level runs on page
 * load — the same contract as the official notes plugin. It must stay
 * re-entrant: plugins_reload re-imports the bundle and the previous instance
 * (action registration, retry timer) must be torn down first.
 */

const RUNTIME_KEY = "__piConvTitleRuntime";
const previous = globalThis[RUNTIME_KEY];
if (previous?.destroy) {
	try {
		previous.destroy();
	} catch {
		/* previous instance already broken */
	}
}

/** Derive the plugin API base from our own bundle URL:
 *  <base>/plugins/conv-title/client/entry.mjs → <base>/plugins-api/conv-title
 *  (works under nginx sub-path proxies without extra config). */
function resolveApiBase() {
	const base = String(import.meta.url);
	const idx = base.indexOf("/plugins/");
	const root = idx >= 0 ? base.slice(0, idx) : base.replace(/\/[^/]*$/, "");
	return `${root}/plugins-api/conv-title`;
}

/** Non-blocking feedback; the host already toasts the /name rename itself. */
function toast(text) {
	try {
		const bridge = globalThis.window?.__piWebUiHost;
		if (typeof bridge?.notifyAction === "function") void bridge.notifyAction({ text });
	} catch {
		/* bridge not ready — ignore */
	}
}

async function requestGenerate(target) {
	const res = await fetch(`${resolveApiBase()}/generate`, {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(target ? { target } : {}),
	});
	let data = null;
	try {
		data = await res.json();
	} catch {
		/* non-JSON body */
	}
	if (!res.ok || !data) throw new Error(`HTTP ${res.status}`);
	return data;
}

/** onUiAction handler: (itemId, value, target) — target = {id, kind} from the
 *  session-row context menu (running: conv id / history: session file path);
 *  the chat-header button passes no target → server uses the active chat. */
function onAction(_itemId, _value, target) {
	requestGenerate(target && typeof target === "object" ? target : undefined)
		.then((r) => {
			if (r?.ok && r.title) toast(`对话标题：${r.title}`);
			else toast(`生成标题失败：${r?.error ?? "未知错误"}`);
		})
		.catch((e) => toast(`生成标题失败：${String(e?.message ?? e)}`));
}

let offAction = null;
let retryTimer = null;
let destroyed = false;

function register() {
	const bridge = globalThis.window?.__piWebUiHost;
	if (destroyed) return true;
	if (typeof bridge?.onUiAction === "function") {
		try {
			offAction = bridge.onUiAction("conv-title:generate", onAction);
			return true;
		} catch {
			/* try again on next tick */
		}
	}
	return false;
}

if (!register()) {
	// The host bridge is installed after the app boots; poll briefly.
	const startedAt = Date.now();
	retryTimer = setInterval(() => {
		if (register()) clearInterval(retryTimer);
		else if (Date.now() - startedAt > 15_000) {
			clearInterval(retryTimer);
			console.warn("[conv-title] host bridge (onUiAction) never became available");
		}
	}, 300);
}

globalThis[RUNTIME_KEY] = {
	destroy() {
		destroyed = true;
		if (retryTimer) {
			clearInterval(retryTimer);
			retryTimer = null;
		}
		if (offAction) {
			try {
				offAction();
			} catch {
				/* already unregistered */
			}
			offAction = null;
		}
		if (globalThis[RUNTIME_KEY] === this) delete globalThis[RUNTIME_KEY];
	},
};
