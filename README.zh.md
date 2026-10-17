# dsh-session-search

给 DSH 对话正文用的查找栏：会话头部一个搜索按钮，点开浮层扫已加载的对话、列出命中、跳过去并高亮。<kbd>Ctrl</kbd>+<kbd>F</kbd> / <kbd>Cmd</kbd>+<kbd>F</kbd> 同样能开。

搜索范围是整个正文 —— 用户消息、助手回复、工具调用及其结果、系统提示、命令、注入的上下文 —— 因为模型跑出来的工具输出和注入的 prompt 恰恰是最常想再翻一遍的东西。唯一排除的是模型推理：那是一段很长、通常被折叠起来的私有草稿，命中落在里面会把真正的结果埋掉。推理和回答共用 `assistant-step` 这个 kind，靠 `data-chat-group-part` 区分，所以光按 kind 过滤不够。

## 适用版本

| | |
|---|---|
| DSH | `0.2.1-rc.2`（开发与验证所用版本） |
| `@deepseek-ai/cordis` | `~4.0.5` |
| 形态 | Web UI（`web` 或 `desktop` profile），没有 CLI 侧 |

更早的 DSH 版本未验证。插件挂在 `conversation.session.header.utilities` 这个插槽上；某个版本改名或删掉这个插槽，按钮就不会渲染。

## 安装

```bash
dsh plugin --profile <你的 profile> add github:minhaoli/dsh-session-search
```

包里声明了 `dsh.bundle.patch`，所以这一行会被写进 `dsh.profile.bundles`，下次启动即挂载。装完刷新一次页面 —— 浏览器端是单独一个模块。

手工安装：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: session-search
      name: 'dsh-session-search'
```

## 实现说明

包里有前后两半，bundle patch 一次挂两边：

- `lib/index.js` —— host 侧。导出空的 `apply()`，不注册任何路由、服务或 watcher，因为搜索完全跑在浏览器里。它存在的唯一理由是让 bundle 那一行有东西可挂；删掉它整个包就不会被组合，浏览器端的查找栏也跟着消失。
- `lib/client.js` —— 浏览器侧，经 `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-slots"]` 注入。它把 React 组件注册进 `conversation.session.header.utilities`，并持有整个查找栏。

**高亮用 CSS Custom Highlight API**，不是把命中包进 `<mark>`。正文是 React 持有的，且一直在重渲染（流式文本、折叠状态）；从外部改它的 DOM 会被 reconcile 掉，或者在 React commit 阶段直接抛错。注册进 highlight registry 的 `Range` 对 React 不可见，清理时删掉条目即可。

## 两个如实写出来的限制

查找栏会直接告诉你这两点，而不是假装没有：

- **只能搜已加载的历史。** 正文是分页的（顶部有「加载更早」），从没加载过的旧对话没有 DOM 可扫。搜不到的意思是「已加载的部分里没有」，不是「从没说过」。
- **折叠的轮次看不到正文。** 这类命中照样会列出来并滚到那个折叠容器；展开就能看到高亮。

## 快捷键

| 按键 | 作用 |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>F</kbd> / <kbd>Cmd</kbd>+<kbd>F</kbd> | 打开查找栏（在捕获阶段的 `keydown` 上拦截） |
| <kbd>Enter</kbd> | 下一个命中 |
| <kbd>Shift</kbd>+<kbd>Enter</kbd> | 上一个命中 |
| <kbd>Esc</kbd> | 关闭 |

## 配套插件

- [`dsh-session-tree`](https://github.com/minhaoli/dsh-session-tree) —— 带标签、分组、拖拽移动的侧栏。
- [`dsh-session-manager`](https://github.com/minhaoli/dsh-session-manager) —— 会话维护的 agent 工具与 REST API。
- [`dsh-session-query-vector`](https://github.com/minhaoli/dsh-session-query-vector) —— 会话语义搜索后端。
- [`dsh-ui-reload`](https://github.com/minhaoli/dsh-ui-reload) —— 一键重载前端按钮。

## 许可

MIT —— 见 [LICENSE](./LICENSE)。
