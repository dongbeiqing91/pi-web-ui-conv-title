/**
 * conv-title — pi-web-ui automatic conversation titles (server entry).
 *
 * Reuses pi-title's title algorithm (see title-core.mjs, MIT) and applies the
 * result through pi-web-ui's own sanctioned rename path:
 *
 *   host.prompt(convId, "/name <title>")
 *     → native /name slash command (intercepted before the SDK, never lands in
 *       the transcript, no user bubble)
 *     → renameSession(): in-memory title + session_info entry in the transcript
 *       + broadcast to all clients + host notice toast
 *
 * If the /name path fails (e.g. the conversation is not visible to the plugin
 * client in a multi-tab setup), the plugin falls back to appending a
 * `session_info` line straight to the session file — the same on-disk mechanism
 * pi itself uses; the history list picks it up on its next refresh, while the
 * live running-list title updates when the conversation is reloaded.
 *
 * Triggers:
 *   - host.onRunEvent "run_start" (a round actually started; `task` = prompt text)
 *   - POST /plugins-api/conv-title/generate (chat.header ✨ button, session-row
 *     right-click menu — the client bundle forwards with a target)
 *   - /title [regenerate|status] slash command
 *
 * Pin semantics (mirrors pi-title): once the user renames a conversation,
 * automatic titles stop for it. The last automatic title per session file is
 * remembered in host.storage so restarts don't clobber user titles.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import * as core from "./title-core.mjs";

// pi-title's lightweight-model candidates, in order of preference. Used only
// when the "标题模型" setting is "auto": the first one the user has configured.
const AUTOMATIC_MODEL_CANDIDATES = [
	"openai/gpt-5-nano",
	"openrouter/openai/gpt-5-nano",
	"google/gemini-2.5-flash-lite",
	"openrouter/google/gemini-2.5-flash-lite",
	"anthropic/claude-haiku-4-5",
];

const STORE_TITLE_PREFIX = "t:";
const STORE_MAX_KEYS = 500;
const LLM_TIMEOUT_MS = 60_000;
const LLM_MAX_CHARS = 200;

function normModelRef(m) {
	if (!m || typeof m !== "object") return undefined;
	const provider = typeof m.provider === "string" ? m.provider : "";
	const id = typeof m.id === "string" ? m.id : "";
	return provider && id ? `${provider}/${id}` : undefined;
}

export default {
	activate(host) {
		/** convId -> { lastAutoTitle, turnsTitled, pinned } */
		const state = new Map();
		/** convIds with a title generation in flight (one at a time per conv). */
		const inflight = new Set();

		const log = (level, msg) => {
			try {
				host.log(level, msg);
			} catch {
				console.log(`[conv-title] ${level}: ${msg}`);
			}
		};

		const num = (v, d) => {
			const n = Number(v);
			return Number.isFinite(n) ? n : d;
		};

		/** Fresh settings on every use — panel changes apply immediately. */
		const cfg = () => {
			const s = host.getSettings() ?? {};
			return {
				enabled: s.enabled !== false,
				model: String(s.model ?? "").trim(),
				refreshTurns: Math.max(0, Math.min(100, Math.floor(num(s.refreshTurns, 0)))),
				maxLength: Math.max(8, Math.min(200, Math.floor(num(s.maxLength, 60)))),
			};
		};

		// ------------------------------------------------------------ state

		const convState = (convId) => {
			let s = state.get(convId);
			if (!s) {
				s = { lastAutoTitle: undefined, turnsTitled: 0, pinned: false };
				state.set(convId, s);
			}
			return s;
		};

		const recall = (sessionFile) =>
			sessionFile ? host.storage.get(STORE_TITLE_PREFIX + sessionFile) : undefined;

		const remember = (sessionFile, title) => {
			if (!sessionFile) return;
			try {
				host.storage.set(STORE_TITLE_PREFIX + sessionFile, { title, at: Date.now() });
			} catch {
				/* storage unavailable is not fatal */
			}
			pruneStore();
		};

		const pruneStore = () => {
			try {
				const all = host.storage.all() ?? {};
				const titled = Object.entries(all)
					.filter(
						([k, v]) =>
							k.startsWith(STORE_TITLE_PREFIX) && v && typeof v === "object" && Number(v.at) > 0,
					)
					.sort((a, b) => a[1].at - b[1].at);
				for (const [k] of titled.slice(0, Math.max(0, titled.length - STORE_MAX_KEYS))) {
					host.storage.delete(k);
				}
			} catch {
				/* best effort */
			}
		};

		/** Snapshot of the conversation `convId`, or null when it is not the
		 *  host's active (most recently active non-subagent) conversation. */
		const activeSnap = (convId) => {
			try {
				const snap = host.getActiveConversation();
				if (snap && convId && String(snap.conversationId) === convId) return snap;
			} catch {
				/* best effort */
			}
			return null;
		};

		// ------------------------------------------------------------ generate

		/**
		 * Ordered model chain for one generation:
		 *  - "" / "active"  → [undefined] (host default = current conversation model)
		 *  - "auto"          → first configured lightweight candidate → conversation model
		 *  - "provider/id"   → that model → conversation model
		 * A trailing undefined means "let the host pick" (current conversation model).
		 */
		async function modelChain(c, activeModel) {
			const chain = [];
			const push = (m) => {
				if (m && !chain.includes(m)) chain.push(m);
			};
			if (c.model === "auto") {
				try {
					const models = await host.models.list();
					for (const ref of AUTOMATIC_MODEL_CANDIDATES) {
						if ((models ?? []).some((m) => normModelRef(m) === ref)) {
							push(ref);
							break;
						}
					}
				} catch {
					/* no candidate */
				}
			} else if (c.model && c.model !== "active") {
				push(c.model);
			}
			if (activeModel) push(activeModel);
			return chain.length ? chain : [undefined];
		}

		/** Run the model chain; returns a cleaned title or null (all failed). */
		async function generateTitle(c, source, activeModel) {
			const { system, prompt } = core.buildTitleRequest(source);
			const chain = await modelChain(c, activeModel);
			const failures = [];
			for (let i = 0; i < chain.length; i++) {
				const m = chain[i];
				let r;
				try {
					r = await host.llm.complete({
						prompt,
						system,
						...(m ? { model: m } : {}),
						maxChars: LLM_MAX_CHARS,
						timeoutMs: LLM_TIMEOUT_MS,
					});
				} catch (e) {
					r = { ok: false, error: String(e?.message ?? e) };
				}
				if (r?.ok && r.text) {
					const t = core.cleanTitle(r.text, c.maxLength);
					if (t) {
						if (i > 0) log("warn", `title model fallback: ${failures.join("; ")}; used ${r.model ?? m ?? "default"}`);
						return t;
					}
					failures.push(`${m ?? "default"}: no usable title`);
				} else {
					failures.push(`${m ?? "default"}: ${r?.error ?? "unknown error"}`);
				}
			}
			log("error", `title generation failed: ${failures.join("; ")}`);
			return null;
		}

		/** Write the title back. Prefers the native /name command (live in-memory
		 *  title + disk + broadcast); falls back to a direct session_info append. */
		async function applyTitle(convId, title, snap) {
			let slashError;
			try {
				const r = await host.prompt(convId, { text: `/name ${title}` });
				if (r?.ok) return { ok: true, via: "slash" };
				slashError = r?.error ?? "unknown error";
			} catch (e) {
				slashError = String(e?.message ?? e);
			}
			log("warn", `/name dispatch failed (${slashError}); trying direct session-file write`);
			const file = snap?.sessionFile;
			if (file && existsSync(file)) {
				try {
					appendFileSync(file, `${JSON.stringify({ type: "session_info", name: title })}\n`, "utf8");
					return { ok: true, via: "file" };
				} catch (e) {
					return { ok: false, error: `session file write failed: ${String(e?.message ?? e)}` };
				}
			}
			return { ok: false, error: slashError };
		}

		/** Generate + apply, with a per-conversation in-flight guard. */
		async function generateAndApply(convId, source, activeModel, opts = {}) {
			if (inflight.has(convId)) return { ok: false, error: "a title generation is already in flight" };
			inflight.add(convId);
			try {
				const c = cfg();
				const title = await generateTitle(c, source, activeModel);
				if (!title) return { ok: false, error: "model returned no usable title" };
				const snap = opts.snap ?? activeSnap(convId);
				const applied = await applyTitle(convId, title, snap);
				if (!applied.ok) return { ok: false, error: applied.error };
				const s = convState(convId);
				s.lastAutoTitle = title;
				if (opts.explicit) s.pinned = false; // an explicit action lifts the pin
				if (typeof opts.turns === "number") s.turnsTitled = opts.turns;
				remember(snap?.sessionFile, title);
				log("info", `title set (via ${applied.via}): ${title}`);
				return { ok: true, title, via: applied.via };
			} finally {
				inflight.delete(convId);
			}
		}

		// ------------------------------------------------------------ automatic

		/** run_start: a round just started streaming. `ev.task` is this round's
		 *  prompt text; `ev.conversationId` identifies the conversation. */
		async function onRunStart(ev) {
			const c = cfg();
			if (!c.enabled) return;
			const convId = String(ev?.conversationId ?? "");
			if (!convId) return;

			const snap = activeSnap(convId);
			if (snap?.isSubagent) return; // subagent chats: no automatic titles

			const s = convState(convId);

			// Cross-restart memory: rebase on the title we last wrote for this
			// session file; any other name means the user renamed it → pin.
			if (s.lastAutoTitle === undefined && snap?.sessionFile) {
				const rec = recall(snap.sessionFile);
				if (rec && typeof rec.title === "string" && snap.title) {
					if (snap.title === rec.title) s.lastAutoTitle = rec.title;
					else s.pinned = true;
				}
			}
			// In-process pin detection: title differs from our last write.
			if (s.lastAutoTitle !== undefined && snap?.title && snap.title !== s.lastAutoTitle) {
				s.pinned = true;
				return;
			}
			if (s.pinned) return;

			const entries = core.toBranchEntries(snap?.messages ?? []);

			if (s.lastAutoTitle === undefined) {
				// First automatic title: the opening exchange, or this round's
				// prompt text when the reply has not landed yet.
				const source = core.initialSource(entries, ev?.task);
				if (!source) return;
				await generateAndApply(convId, source, snap?.model, { snap, turns: 1 });
				return;
			}

			// Refresh cadence (pi-title "every N turns").
			if (c.refreshTurns === 0) return;
			if (!snap?.messages) return;
			const turns = core.countCompletedExchanges(entries);
			if (turns < s.turnsTitled + c.refreshTurns) return;
			const source = core.latestSource(entries, core.firstUserText(entries));
			if (!source) return;
			await generateAndApply(convId, source, snap?.model, { snap, turns });
		}

		// ------------------------------------------------------------ explicit

		/** History session (file on disk, not in memory): read the transcript,
		 *  generate, append a session_info line. Visible on the next list fetch. */
		async function explicitHistory(file) {
			if (!file || !existsSync(file)) return { ok: false, error: "session file not found" };
			let raw;
			try {
				raw = readFileSync(file, "utf8");
			} catch (e) {
				return { ok: false, error: `read failed: ${String(e?.message ?? e)}` };
			}
			const entries = [];
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				let o;
				try {
					o = JSON.parse(line);
				} catch {
					continue;
				}
				if (o?.type !== "message") continue;
				const m = o.message ?? o;
				if (m && (m.role === "user" || m.role === "assistant")) {
					entries.push({ type: "message", message: m });
				}
			}
			const source = core.latestSource(entries, core.firstUserText(entries));
			if (!source) return { ok: false, error: "no titleable messages in this session" };
			const c = cfg();
			const title = await generateTitle(c, source, undefined);
			if (!title) return { ok: false, error: "model returned no usable title" };
			try {
				appendFileSync(file, `${JSON.stringify({ type: "session_info", name: title })}\n`, "utf8");
			} catch (e) {
				return { ok: false, error: `session file write failed: ${String(e?.message ?? e)}` };
			}
			log("info", `history session titled (via file): ${title}`);
			return { ok: true, title, via: "file" };
		}

		/**
		 * Manual generation (button / right-click / command).
		 * target: {kind:"running", id:convId} | {kind:"history", id:sessionFile} | undefined.
		 * Without a target the host's active conversation is used.
		 */
		async function explicitGenerate(target) {
			if (target && String(target.kind) === "history") {
				return explicitHistory(String(target.id ?? ""));
			}
			let convId = target && String(target.kind) === "running" ? String(target.id ?? "") : "";
			let snap = convId ? activeSnap(convId) : null;
			if (!convId) {
				try {
					const a = host.getActiveConversation();
					if (a?.conversationId) {
						convId = String(a.conversationId);
						snap = a;
					}
				} catch {
					/* no active conversation */
				}
			}
			if (!convId || !snap?.messages) {
				return { ok: false, error: "conversation content unavailable (open it in this browser first)" };
			}
			if (snap.isSubagent) return { ok: false, error: "subagent conversations cannot be titled" };
			const entries = core.toBranchEntries(snap.messages);
			const source = core.latestSource(entries, core.firstUserText(entries));
			if (!source) return { ok: false, error: "no titleable messages yet" };
			return generateAndApply(convId, source, snap.model, {
				snap,
				explicit: true,
				turns: core.countCompletedExchanges(entries),
			});
		}

		// ------------------------------------------------------------ wiring

		host.onRunEvent((ev) => {
			if (!ev || ev.type !== "run_start") return;
			onRunStart(ev).catch((e) => log("error", `automatic title failed: ${String(e?.message ?? e)}`));
		});

		host.route("POST", "/generate", (req, res) => {
			explicitGenerate(req?.body?.target ?? undefined)
				.then((r) => res.json(r))
				.catch((e) => res.json({ ok: false, error: String(e?.message ?? e) }));
		});

		host.registerCommand({
			name: "title",
			description: "regenerate | status — 生成/查看当前对话标题",
			descriptionEn: "regenerate | status — title this conversation",
			argumentHint: "[regenerate|status]",
			argumentHintEn: "[regenerate|status]",
			run: async (args) => {
				const a = String(args ?? "").trim().toLowerCase();
				if (a === "status") {
					const c = cfg();
					let snap = null;
					try {
						snap = host.getActiveConversation();
					} catch {
						/* none */
					}
					const modelText =
						c.model === "" ? "current conversation model" : c.model === "auto" ? "auto (lightweight)" : c.model;
					return [
						`title: ${snap?.title ?? "(none)"}`,
						`automatic: ${c.enabled ? "on" : "off"}`,
						`model: ${modelText}`,
						`refresh: ${c.refreshTurns === 0 ? "off" : `every ${c.refreshTurns} turns`}`,
					].join("\n");
				}
				const r = await explicitGenerate(undefined);
				if (r.ok) host.notify("info", `对话标题：${r.title}`, `Conversation title: ${r.title}`);
				else host.notify("error", `生成标题失败：${r.error}`, `Title generation failed: ${r.error}`);
				return r.ok ? `已生成标题：${r.title}` : `生成失败：${r.error}`;
			},
		});
	},
};
