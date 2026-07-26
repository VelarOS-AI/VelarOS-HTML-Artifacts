# VelarOS HTML Artifacts

把模型的增量文本流直接变成实时、隔离的 HTML 界面。

VelarOS HTML Artifacts 是一个零运行时依赖的浏览器库。它统一负责协议解析、iframe 生命周期、补丁传输、受限高度协商、链接校验和资源清理，接入方不再需要自己拼装 `postMessage` 和流式渲染逻辑。

[English](./README.md)

完整的中文公共接口、生命周期、依赖注入与扩展约定见
[中文 API 文档](./docs/api.zh-CN.md)。

## 安装

为 GitHub Packages 的私有 `@velaros-ai` scope 配置 npm 认证后安装：

```bash
npm install @velaros-ai/html-artifacts
```

仓库会提交编译后的 `dist/`，npm、pnpm、Bun 和 Yarn 消费 Git 依赖时不需要额外执行构建脚本。

## 快速开始

```ts
import { mountHtmlArtifact } from '@velaros-ai/html-artifacts'

const container = document.querySelector<HTMLElement>('#preview')
if (!container) throw new Error('Missing #preview')

const artifact = mountHtmlArtifact(container, {
  maxHeight: 720,
  onPrompt: (prompt) => sendToModel(prompt),
  onLink: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
  onError: (error) => console.error(error.phase, error.message),
})

await artifact.consume(modelTextStream)

// 外层页面销毁时：
artifact.dispose()
```

`modelTextStream` 可以是任意模型服务返回的 `AsyncIterable<string>`。本库不依赖 React、Electron、Agent Loop 或某一家模型 API。

`mountHtmlArtifact()` 会在目标元素内创建一个 `sandbox="allow-scripts"` 的 iframe。生成代码只能在沙箱内运行；打开链接、继续提问等能力必须由宿主通过显式回调授权。

## 手动接入已有流循环

普通场景直接使用 `consume()`。如果应用已经有自己的流读取逻辑，可以改用 `write()` 和 `finish()`：

```ts
const artifact = mountHtmlArtifact(container, { maxHeight: 720 })

for await (const chunk of modelTextStream) {
  artifact.write(chunk)
}
artifact.finish()

// 下一次回答复用同一个 iframe。
artifact.reset()

// 移除 iframe 和全部宿主监听器。
artifact.dispose()
```

Chunk 可以停在半个 HTML 标签、CSS 规则、脚本或 Base64 数据中；只有完整、安全的协议边界才会进入 iframe。

## 宿主回调

```ts
const artifact = mountHtmlArtifact(container, {
  onMarkdown(text) {
    appendToTranscript(text)
  },
  onPrompt(prompt) {
    sendToModel(prompt)
  },
  onLink(url) {
    openTrustedUrl(url)
  },
  onMessage(payload) {
    handleArtifactMessage(payload)
  },
  onEvent(event) {
    recordProtocolEvent(event)
  },
  onError(error) {
    reportArtifactError(error)
  },
})
```

链接默认只允许 HTTP 和 HTTPS。无效或主动执行型 URL 会通过 `onError` 上报，不会进入 `onLink`。

## 稳定高度

```ts
const artifact = mountHtmlArtifact(container, {
  initialHeight: 360,
  minHeight: 1,
  maxHeight: 720,
})
```

iframe 运行时只上报去重后的绝对内容高度，宿主直接应用，不再累加 padding，也不会把 viewport 增长反馈回测量过程。`maxHeight` 会同时在 iframe 内部和浏览器宿主层生效；超高内容或 `100vh` 等 viewport 耦合页面会留在沙箱内滚动，不会无限撑高外层界面。

## Artifact 协议

v1 协议保持有意的小规模：

```html
<artifact version="1" id="profile-card" title="Profile card">
  <patch type="replace"><main id="app"></main></patch>
  <patch type="append" target="#app"><h1>Hello</h1></patch>
  <patch type="style" id="base">#app { padding: 24px; }</patch>
  <patch type="script" id="boot">console.log('ready')</patch>
</artifact>
```

当 Patch 内容本身包含协议闭合标签时，可以使用 `encoding="base64"`。

## 高级 API

绝大多数应用只需要从包根入口使用 `mountHtmlArtifact()` 或
`HtmlArtifactRuntime`。需要自定义宿主时，再使用下面的稳定子路径：

```ts
// 与渲染器无关的增量协议解析器。
import {
  HtmlArtifactProtocolParser,
} from '@velaros-ai/html-artifacts/protocol'

// iframe 文档、高度适配与 URL 安全原语。
import {
  buildHtmlArtifactShellDocument,
  normalizeHtmlArtifactExternalUrl,
  resolveHtmlArtifactFrameFit,
} from '@velaros-ai/html-artifacts/sandbox'
```

`@velaros-ai/html-artifacts/runtime` 会作为 `./sandbox` 的兼容别名保留。

## API

### `mountHtmlArtifact(target, options?)`

在目标元素内挂载一个受管理的 Artifact iframe，返回 `HtmlArtifactController`。

主要选项：

- `initialHeight`、`minHeight`、`maxHeight`：有界 iframe 高度。
- `sandbox`：iframe sandbox token，默认只有 `allow-scripts`。
- `designCss`、`rootId`、`title`、`className`：宿主展示接口。
- `protocolLimits`：不可信或异常超长流的资源上限。
- `onMarkdown`、`onPrompt`、`onLink`、`onMessage`、`onEvent`、`onError`：宿主回调。

Controller 方法：

- `consume(stream)`：消费文本 Chunk 迭代器并返回最近的协议快照。
- `write(chunk)`：解析并渲染一个 Chunk。
- `finish()`：结束流并刷新不完整的尾部内容。
- `getSnapshot(id?)`：读取最近的解析器快照。
- `reset()`：清空协议状态和 iframe 内容，但保留挂载实例。
- `dispose()`：移除 iframe 与全部监听器。

## 开源边界与维护方式

本仓库只维护可复用的流式协议与沙箱机制，不包含模型提示词、聊天状态、Agent 调度、Electron IPC、产品 UI、权限、Widget、Memory 或 VelarOS Kernel 内部实现。

公共仓库是唯一源码。通用修复先在这里合入；产品只消费准确发布版本，并在私有仓库保留自己的适配层。

## 开发

```bash
npm install
npm run check
npm run demo
```

`npm run check` 会执行 TypeScript 检查、Node 测试、生产 Demo 构建和 npm 包 dry run。

## 安全

生成 HTML 属于不可信输入。修改沙箱、脚本、URL 或消息桥前，请先阅读 [SECURITY.md](./SECURITY.md)。

## 许可证

MIT © 2026 Error-Zhang
