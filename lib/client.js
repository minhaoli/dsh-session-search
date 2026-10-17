/**
 * dsh-session-search — a find bar for the conversation transcript.
 *
 * A search button sits in the conversation session header. Clicking it opens a
 * floating find bar; typing scans the loaded conversation, lists matches, and
 * jumping to one scrolls that message into view with the hit highlighted.
 *
 * Scope is the whole transcript — user messages, assistant replies, tool calls
 * and their results, system prompts, commands and injected context — because a
 * model's tool output and the injected prompt are routinely what you want to
 * find again. The one exclusion is the model's reasoning: it is a long private
 * scratchpad, usually folded away, and hits inside it would bury the real ones.
 * Reasoning shares the `assistant-step` kind with the answer and is told apart
 * by `data-chat-group-part`, so the kind filter alone is not enough.
 *
 * Highlights use the CSS Custom Highlight API rather than wrapping the hit in a
 * <mark>. The transcript is React-owned and keeps re-rendering (streaming text,
 * fold state); mutating its DOM from outside would be reconciled away or worse,
 * throw during a React commit. A Range registered in the highlight registry is
 * invisible to React and needs no cleanup beyond deleting the entry.
 *
 * Two limits are inherent to how the view is built, and the bar states them
 * rather than pretending otherwise:
 *
 * - Only loaded history is searchable. The transcript is paged (the "load
 *   earlier" control at the top), so older turns that were never loaded have no
 *   DOM to scan. A miss means "not in the loaded part", not "never said".
 * - A collapsed turn hides its text. Such a match still appears and scrolls to
 *   the collapsed container; expanding that turn reveals the hit.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-search",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const { createElement, useCallback, useEffect, useMemo, useRef, useState } = react;
		const { createPortal } = require("react-dom");

		/** Cordis plugin name. */
		const name = "session-search";

		/** Required service: the slot registry the button registers into. */
		const inject = ["slots"];

		/** Cap on rendered result rows; the header still reports the full count. */
		const MAX_LISTED = 200;

		/** Characters of context shown around a hit in the result list. */
		const CONTEXT_CHARS = 48;

		/** Highlight registry group names. */
		const HIGHLIGHT_ALL = "dsh-session-search-all";
		const HIGHLIGHT_ACTIVE = "dsh-session-search-active";

		/**
		 * Chat node kinds excluded from search.
		 *
		 * Search covers the whole transcript by default — user messages, assistant
		 * replies, tool calls and results, system prompts, commands, context
		 * injections — because a model's tool output and the injected system prompt
		 * are frequently exactly what you want to find again.
		 *
		 * Reasoning is the exception: it is the model's private scratchpad, it is
		 * long, repetitive and usually folded away, so matches inside it would
		 * drown the real hits without ever being the thing you were looking for.
		 *
		 * `turn-process` is excluded as a container rather than as content: it is a
		 * disclosure wrapper whose body repeats rows that already appear on their
		 * own, so searching it would count the same text twice.
		 */
		const EXCLUDED_KINDS = new Set(["turn-process"]);

		/**
		 * Group part that marks a reasoning row. An `assistant-step` splits into a
		 * `reasoning` row and a `response` row, so the kind alone cannot tell
		 * thinking apart from the answer; the part attribute can.
		 */
		const REASONING_PART = "reasoning";

		/** Transcript rows carrying the kind attribute. */
		const ROW_SELECTOR = "[data-chat-flow-kind]";

		/** Highlight style tag id; injected once per page. */
		const STYLE_ID = "dsh-session-search-style";

		/** Whether the CSS Custom Highlight API is usable in this renderer. */
		const hasHighlightApi =
			typeof CSS !== "undefined" && CSS.highlights !== undefined && typeof Highlight !== "undefined" && typeof Range !== "undefined";

		/** Install the highlight rules once. */
		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = [
				"::highlight(" + HIGHLIGHT_ALL + "){background-color:rgba(255,196,0,.4);color:inherit}",
				"::highlight(" + HIGHLIGHT_ACTIVE + "){background-color:rgba(255,140,0,.66);color:inherit}",
			].join("");
			document.head.appendChild(style);
		}

		/** Inline magnifier glyph, so the button needs no icon dependency. */
		function SearchGlyph({ size = 16 }) {
			return createElement(
				"svg",
				{ width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
				createElement("circle", { cx: 7, cy: 7, r: 4.5, stroke: "currentColor", strokeWidth: 1.5 }),
				createElement("path", { d: "M10.5 10.5 14 14", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" }),
			);
		}

		/**
		 * Index one row: its collapsed visible text plus, for every character of
		 * that text, the text node and raw offset the character came from.
		 *
		 * Searching happens on the collapsed string (so a phrase split across
		 * markdown emphasis, or wrapped over a newline, still matches as one run),
		 * while a Range needs raw node offsets. Carrying the mapping alongside the
		 * text — instead of re-deriving it from whitespace rules — is what keeps
		 * those two coordinate systems exactly in step; an earlier arithmetic
		 * version mis-placed a hit by one character whenever a text node ended in
		 * whitespace.
		 *
		 * A collapsed separator space maps to `null`: no node owns it, and matches
		 * only ever read their first and last character.
		 *
		 * @param element - a row element.
		 * @returns the collapsed text and its per-character source map.
		 */
		function indexRow(element) {
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
				acceptNode(node) {
					return (node.nodeValue ?? "").trim() === "" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
				},
			});
			let text = "";
			const map = [];
			let pendingSpace = false;
			let node = walker.nextNode();
			while (node !== null) {
				const value = node.nodeValue ?? "";
				for (let i = 0; i < value.length; i += 1) {
					const ch = value[i];
					if (/\s/.test(ch)) {
						pendingSpace = text.length > 0;
						continue;
					}
					if (pendingSpace) {
						text += " ";
						map.push(null);
						pendingSpace = false;
					}
					text += ch;
					map.push({ node, offset: i });
				}
				node = walker.nextNode();
			}
			return { text, map };
		}

		/**
		 * Collect the searchable transcript rows, in document order.
		 *
		 * Every row counts except the excluded kinds and reasoning rows; see
		 * {@link EXCLUDED_KINDS} for why those two are dropped.
		 *
		 * Rows the browser reports as not rendered are skipped: a row inside a
		 * collapsed turn is not visible, and scrolling to it would look like the
		 * jump silently failed.
		 *
		 * @returns one indexed entry per searchable row.
		 */
		function bodyRows() {
			if (typeof document === "undefined") return [];
			const rows = [];
			for (const element of document.querySelectorAll(ROW_SELECTOR)) {
				if (!(element instanceof HTMLElement)) continue;
				const kind = element.dataset.chatFlowKind;
				if (kind === undefined || EXCLUDED_KINDS.has(kind)) continue;
				// Thinking and the answer share the `assistant-step` kind and are told
				// apart by which half of the step the row renders.
				if (element.dataset.chatGroupPart === REASONING_PART) continue;
				if (element.offsetParent === null) continue;
				const indexed = indexRow(element);
				if (indexed.text === "") continue;
				rows.push({ element, kind, text: indexed.text, map: indexed.map });
			}
			return rows;
		}

		/**
		 * Every occurrence of the query in the loaded body, in document order.
		 *
		 * @param query - raw query text; matched case-insensitively as a substring.
		 * @returns the hits, each with surrounding context for the result list.
		 */
		function findMatches(query) {
			const needle = query.trim().toLowerCase();
			if (needle === "") return [];
			const matches = [];
			for (const row of bodyRows()) {
				const haystack = row.text.toLowerCase();
				let from = 0;
				for (;;) {
					const at = haystack.indexOf(needle, from);
					if (at === -1) break;
					const start = Math.max(0, at - CONTEXT_CHARS);
					const end = Math.min(row.text.length, at + needle.length + CONTEXT_CHARS);
					matches.push({
						row: row.element,
						kind: row.kind,
						map: row.map,
						index: at,
						length: needle.length,
						before: (start > 0 ? "…" : "") + row.text.slice(start, at),
						hit: row.text.slice(at, at + needle.length),
						after: row.text.slice(at + needle.length, end) + (end < row.text.length ? "…" : ""),
					});
					from = at + needle.length;
				}
			}
			return matches;
		}

		/**
		 * Build a Range covering one match inside its row.
		 *
		 * Both endpoints are read straight from the match's own source map, so a
		 * match that begins in one text node and ends in another (emphasis, links,
		 * inline code) still yields a single Range. A range whose endpoints sit in
		 * different nodes is returned as-is: the highlight registry paints the
		 * whole span correctly, which `<mark>`-style wrapping could not do.
		 *
		 * @param match - the match to cover.
		 * @returns the range, or null when an endpoint has no owning node.
		 */
		function rangeForMatch(match) {
			const start = match.map[match.index];
			const end = match.map[match.index + match.length - 1];
			if (start === undefined || end === undefined || start === null || end === null) return null;
			try {
				const range = document.createRange();
				range.setStart(start.node, start.offset);
				// The end is exclusive, so it points one past the last matched character.
				range.setEnd(end.node, end.offset + 1);
				return range;
			} catch {
				return null;
			}
		}

		/** Remove every highlight this feature registered. */
		function clearHighlights() {
			if (!hasHighlightApi) return;
			CSS.highlights.delete(HIGHLIGHT_ALL);
			CSS.highlights.delete(HIGHLIGHT_ACTIVE);
		}

		/**
		 * Register every hit as a highlight, then scroll one into view.
		 *
		 * Painting all hits (not just the active one) is what makes the result list
		 * legible against the transcript: the reader sees where every match is.
		 *
		 * @param matches - all hits for the current query.
		 * @param index - which hit to scroll to and mark active.
		 * @returns whether the target row was still in the document.
		 */
		function paint(matches, index) {
			if (!hasHighlightApi) return true;
			const all = new Highlight();
			let activeRange = null;
			let activeRow = null;
			matches.forEach((match, i) => {
				if (!document.body.contains(match.row)) return;
				const range = rangeForMatch(match);
				if (range === null) return;
				all.add(range);
				if (i === index) {
					activeRange = range;
					activeRow = match.row;
				}
			});
			CSS.highlights.set(HIGHLIGHT_ALL, all);
			if (activeRange !== null && activeRow !== null) {
				CSS.highlights.set(HIGHLIGHT_ACTIVE, new Highlight(activeRange));
				// Scrolling the row rather than the range keeps the message's own
				// context on screen.
				activeRow.scrollIntoView({ block: "center", behavior: "smooth" });
				return true;
			}
			CSS.highlights.delete(HIGHLIGHT_ACTIVE);
			return false;
		}

		/** Author label for a row kind, used in the result list. */
		function kindLabel(kind) {
			switch (kind) {
				case "user":
					return "你";
				case "assistant-step":
					return "助手";
				case "steering":
					return "引导";
				case "input-message":
					return "输入";
				case "developer-message":
					return "开发者";
				case "system-prompt":
					return "系统提示";
				case "context":
					return "上下文";
				case "tool-call":
					return "工具调用";
				case "tool-result":
					return "工具结果";
				case "command":
					return "命令";
				case "command-input":
					return "命令";
				case "compaction":
				case "manual-compaction":
					return "压缩";
				case "model-retry":
					return "重试";
				case "turn-error":
					return "错误";
				case "turn-max-tokens":
					return "超限";
				case "turn-trigger":
					return "触发";
				case "turn-tail":
					return "页脚";
				default:
					return kind;
			}
		}

		/** Field chrome shared by the bar's text input. */
		const fieldStyle = {
			border: "1px solid rgba(128,128,128,.4)",
			borderRadius: "6px",
			padding: "5px 8px",
			fontSize: "13px",
			background: "transparent",
			color: "inherit",
			outline: "none",
		};

		/** Icon-button chrome shared by the bar's controls. */
		function iconButton(extra) {
			return {
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: "26px",
				height: "26px",
				padding: 0,
				border: "none",
				borderRadius: "6px",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				...extra,
			};
		}

		/**
		 * The floating find bar.
		 *
		 * @param props - `service`, the shared open/query state.
		 */
		function SearchPanel({ service }) {
			const [open, setOpen] = useState(service.isOpen());
			const [query, setQuery] = useState(service.getQuery());
			const [active, setActive] = useState(0);
			const [status, setStatus] = useState("");
			const [scanVersion, setScanVersion] = useState(0);
			const [focusToken, setFocusToken] = useState(service.getFocusToken());
			const inputRef = useRef(null);

			useEffect(
				() =>
					service.subscribe(() => {
						setOpen(service.isOpen());
						setQuery(service.getQuery());
						setFocusToken(service.getFocusToken());
						// A rescan keeps the count honest after the transcript grows or
						// turns are folded while the bar is open.
						setScanVersion(version => version + 1);
					}),
				[service],
			);

			useEffect(() => {
				if (!open) clearHighlights();
			}, [open]);

			// Focus follows the summon token, not just the open flag: re-pressing the
			// shortcut on an already-open bar must return focus to the field (and
			// select what is there, as find bars do), not be a no-op.
			useEffect(() => {
				if (!open) return;
				const field = inputRef.current;
				if (field === null) return;
				field.focus();
				field.select?.();
			}, [open, focusToken]);

			const matches = useMemo(() => (open ? findMatches(query) : []), [open, query, scanVersion]);
			const total = matches.length;

			// Repaint whenever the hit set or the selected hit changes, so the
			// transcript always reflects the current query.
			useEffect(() => {
				if (!open || total === 0) {
					clearHighlights();
					return;
				}
				paint(matches, Math.min(active, total - 1));
			}, [open, matches, active, total]);

			const jump = useCallback(
				index => {
					if (total === 0) return;
					const wrapped = ((index % total) + total) % total;
					setActive(wrapped);
					const row = matches[wrapped].row;
					const ok = document.body.contains(row);
					row.scrollIntoView({ block: "center", behavior: "smooth" });
					setStatus(ok ? `第 ${wrapped + 1} / ${total} 条` : `第 ${wrapped + 1} / ${total} 条（该轮已折叠）`);
				},
				[matches, total],
			);

			if (!open) return null;

			return createElement(
				"div",
				{
					role: "dialog",
					"aria-label": "搜索本会话内容",
					style: {
						position: "fixed",
						top: "72px",
						right: "24px",
						zIndex: 60,
						width: "min(560px, calc(100vw - 48px))",
						maxHeight: "min(70vh, 620px)",
						overflowY: "auto",
						padding: "10px 12px",
						border: "1px solid rgba(128,128,128,.35)",
						borderRadius: "12px",
						background: "var(--dsh-surface, rgba(32,32,32,.96))",
						boxShadow: "0 12px 32px rgba(0,0,0,.32)",
						display: "flex",
						flexDirection: "column",
						gap: "8px",
						fontSize: "13px",
					},
				},
				createElement(
					"form",
					{
						onSubmit: event => {
							event.preventDefault();
							if (total === 0) {
								setStatus(query.trim() === "" ? "" : "未找到");
								return;
							}
							jump(0);
						},
						style: { display: "flex", alignItems: "center", gap: "6px" },
					},
					createElement(SearchGlyph, { size: 14 }),
					createElement("input", {
						ref: inputRef,
						type: "search",
						value: query,
						placeholder: "搜索本会话正文…（Enter 跳转）",
						"aria-label": "搜索本会话正文",
						onChange: event => {
							service.setQuery(event.target.value);
							setActive(0);
							setStatus("");
						},
						onKeyDown: event => {
							if (event.key === "Escape") {
								event.preventDefault();
								service.close();
								return;
							}
							if (event.key === "Enter") {
								event.preventDefault();
								jump(status === "" ? 0 : active + (event.shiftKey ? -1 : 1));
							}
						},
						style: { ...fieldStyle, flex: "1 1 auto", minWidth: 0 },
					}),
					createElement(
						"span",
						{ style: { flex: "0 0 auto", opacity: 0.75, whiteSpace: "nowrap" } },
						query.trim() === "" ? "" : total === 0 ? "0 条" : `${total} 条`,
					),
					createElement(
						"button",
						{ type: "button", style: iconButton(), title: "上一条", "aria-label": "上一条", disabled: total === 0, onClick: () => jump(active - 1) },
						"↑",
					),
					createElement(
						"button",
						{ type: "button", style: iconButton(), title: "下一条", "aria-label": "下一条", disabled: total === 0, onClick: () => jump(active + 1) },
						"↓",
					),
					createElement("button", { type: "button", style: iconButton(), title: "关闭", "aria-label": "关闭搜索", onClick: () => service.close() }, "✕"),
				),
				createElement(
					"div",
					{ style: { fontSize: "12px", opacity: 0.7, lineHeight: 1.6 } },
					"搜索整段对话（含工具调用与系统提示，不含思考过程）。只覆盖已加载的内容，更早的需先在会话顶部点“加载更早”。",
				),
				status === "" ? null : createElement("div", { role: "status", style: { fontSize: "12px", opacity: 0.85 } }, status),
				total === 0
					? null
					: createElement(
							"ul",
							{ style: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "2px" } },
							matches.slice(0, MAX_LISTED).map((match, index) =>
								createElement(
									"li",
									{ key: `${match.index}-${index}` },
									createElement(
										"button",
										{
											type: "button",
											onClick: () => jump(index),
											style: {
												display: "block",
												width: "100%",
												textAlign: "left",
												border: "none",
												borderRadius: "6px",
												padding: "4px 6px",
												background: index === active ? "rgba(128,128,128,.22)" : "transparent",
												color: "inherit",
												cursor: "pointer",
												fontSize: "12px",
												lineHeight: 1.55,
												overflowWrap: "anywhere",
											},
										},
										createElement("span", { style: { opacity: 0.6, marginRight: "6px" } }, kindLabel(match.kind)),
										createElement("span", null, match.before),
										createElement("mark", { style: { background: "rgba(255,196,0,.5)", borderRadius: "2px", color: "inherit" } }, match.hit),
										createElement("span", null, match.after),
									),
								),
							),
							total > MAX_LISTED
								? createElement("li", { style: { fontSize: "12px", opacity: 0.6, padding: "4px 6px" } }, `仅列出前 ${MAX_LISTED} 条，共 ${total} 条`)
								: null,
						),
			);
		}

		/**
		 * Build the search service: the open/query state the button toggles, shared
		 * with the panel through a subscription.
		 */
		function createSearchService() {
			let open = false;
			let query = "";
			// Bumped on every explicit summon. The panel watches it rather than
			// `open`, so pressing the shortcut while the bar is already open still
			// pulls focus back into the field instead of doing nothing.
			let focusToken = 0;
			const listeners = new Set();
			const notify = () => {
				for (const listener of [...listeners]) listener();
			};
			const service = {
				isOpen: () => open,
				getQuery: () => query,
				getFocusToken: () => focusToken,
				setQuery(value) {
					query = value;
					notify();
				},
				close() {
					open = false;
					clearHighlights();
					notify();
				},
				toggle() {
					open = !open;
					if (open) focusToken += 1;
					else clearHighlights();
					notify();
				},
				/** Open if closed, and always send focus to the field. */
				summon() {
					open = true;
					focusToken += 1;
					notify();
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			};
			return service;
		}

		/**
		 * Mounts the panel into a div appended to the document body, so the bar
		 * floats above the transcript regardless of where the button sits.
		 *
		 * @param props - `service` supplying the shared state.
		 */
		function SearchPortal({ service }) {
			const [host] = useState(() => {
				if (typeof document === "undefined") return null;
				const div = document.createElement("div");
				div.dataset.dshSessionSearchHost = "";
				return div;
			});

			useEffect(() => {
				if (host === null) return undefined;
				document.body.appendChild(host);
				return () => {
					if (host.parentNode !== null) host.parentNode.removeChild(host);
				};
			}, [host]);

			if (host === null) return null;
			return createPortal(createElement(SearchPanel, { service }), host);
		}

		/**
		 * Header button toggling the find bar, with the panel mounted alongside it.
		 *
		 * @param props - slot-injected props carrying the search service.
		 */
		function SessionSearchButton({ service }) {
			const [open, setOpen] = useState(service.isOpen());

			useEffect(() => {
				ensureStyle();
			}, []);

			useEffect(() => service.subscribe(() => setOpen(service.isOpen())), [service]);

			// Ctrl/Cmd+F summons the find bar, the way every editor and browser
			// binds find; Escape closes. The listener runs in the capture phase and
			// swallows the event so Chromium's own find bar cannot open on top.
			useEffect(() => {
				const onKeyDown = event => {
					if (event.key === "Escape" && service.isOpen()) {
						service.close();
						return;
					}
					if (event.key.toLowerCase() === "f" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
						event.preventDefault();
						event.stopPropagation();
						service.summon();
					}
				};
				window.addEventListener("keydown", onKeyDown, true);
				return () => window.removeEventListener("keydown", onKeyDown, true);
			}, [service]);

			return createElement(
				react.Fragment,
				null,
				createElement(
					"button",
					{
						type: "button",
						"data-dsh-session-search": "",
						"aria-label": "搜索本会话内容",
						"aria-pressed": open,
						title: open ? "关闭搜索" : "搜索本会话内容（只搜正文，Ctrl+F）",
						onClick: event => {
							event.stopPropagation();
							service.toggle();
						},
						style: iconButton({
							width: "28px",
							height: "28px",
							background: open ? "rgba(128,128,128,.2)" : "transparent",
						}),
					},
					createElement(SearchGlyph, { size: 16 }),
				),
				createElement(SearchPortal, { service }),
			);
		}

		/**
		 * Client plugin body.
		 *
		 * @param ctx - the client cordis context (slots).
		 */
		function apply(ctx) {
			const service = createSearchService();

			// One registration only: the button renders the portal alongside itself,
			// so no second slot id is claimed on a parent-owned region.
			ctx.slots.inject("conversation.session.header.utilities", () => {
				const dispose = ctx.slots.register(
					{
						name: "conversation.session.header.utilities",
						id: "session-search",
						// The reload button orders at -20; -30 keeps search to its left.
						order: -30,
						inject: () => ({ service }),
					},
					SessionSearchButton,
				);
				return () => {
					dispose();
					clearHighlights();
				};
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	},
});
