# dsh-session-search

A find bar for the conversation transcript in DSH: a search button in the conversation session header opens a floating panel that scans the loaded conversation, lists matches, and jumps to a hit with it highlighted. <kbd>Ctrl</kbd>+<kbd>F</kbd> / <kbd>Cmd</kbd>+<kbd>F</kbd> does the same.

Scope is the whole transcript — user messages, assistant replies, tool calls and their results, system prompts, commands and injected context — because a model's tool output and the injected prompt are routinely what you want to find again. The one exclusion is the model's reasoning: it is a long private scratchpad, usually folded away, and hits inside it would bury the real ones. Reasoning shares the `assistant-step` kind with the answer and is told apart by `data-chat-group-part`, so a kind filter alone is not enough.

## Requirements

| | |
|---|---|
| DSH | `0.2.1-rc.2` (developed and tested against it) |
| `@deepseek-ai/cordis` | `~4.0.5` |
| Mode | Web UI (`web` or `desktop` profile) — there is no CLI surface |

Earlier DSH releases are untested. The plugin mounts into the slot `conversation.session.header.utilities`; a release that renames or removes that slot leaves the button unrendered.

## Install

```bash
dsh plugin --profile <your-profile> add github:minhaoli/dsh-session-search
```

The package declares `dsh.bundle.patch`, so the row is appended to `dsh.profile.bundles` and the loader mounts it on the next start. Reload the page once after installing — the client half is served as a separate module.

Manual install:

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: session-search
      name: 'dsh-session-search'
```

## How it works

The package has two halves and the bundle patch mounts both:

- `lib/index.js` — the host half. It exports an empty `apply()` and registers no route, service or watcher, because search runs entirely in the browser. It exists only so the bundle row has something to mount; dropping it would stop the package from being composed at all, taking the client find bar with it.
- `lib/client.js` — the browser half, injected through `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots"]`. It registers a React component into `conversation.session.header.utilities` and owns the find bar.

**Highlights use the CSS Custom Highlight API**, not a wrapped `<mark>`. The transcript is React-owned and keeps re-rendering (streaming text, fold state); mutating its DOM from outside would be reconciled away or throw during a React commit. A `Range` registered in the highlight registry is invisible to React and needs no cleanup beyond deleting the entry.

## Two limits it does not hide

The find bar states both of these rather than pretending otherwise:

- **Only loaded history is searchable.** The transcript is paged (the "load earlier" control at the top), so older turns that were never loaded have no DOM to scan. A miss means "not in the loaded part", not "never said".
- **A collapsed turn hides its text.** Such a match still appears and scrolls to the collapsed container; expanding that turn reveals the hit.

## Keyboard

| Key | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>F</kbd> / <kbd>Cmd</kbd>+<kbd>F</kbd> | Open the find bar (captured on `keydown` in the capture phase) |
| <kbd>Enter</kbd> | Next match |
| <kbd>Shift</kbd>+<kbd>Enter</kbd> | Previous match |
| <kbd>Esc</kbd> | Close |

## Companion plugins

- [`dsh-session-tree`](https://github.com/minhaoli/dsh-session-tree) — sidebar with tags, grouping and drag-to-move.
- [`dsh-session-manager`](https://github.com/minhaoli/dsh-session-manager) — agent tools and REST API for session housekeeping.
- [`dsh-session-query-vector`](https://github.com/minhaoli/dsh-session-query-vector) — semantic session search backend.
- [`dsh-ui-reload`](https://github.com/minhaoli/dsh-ui-reload) — one-click frontend reload button.

## License

MIT — see [LICENSE](./LICENSE).
