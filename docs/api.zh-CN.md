# `@velaros-ai/html-artifacts` 中文 API

## 定位与非目标

本包提供框架无关的流式 HTML Artifact 协议、受控 iframe 运行时和安全原语。它可以接入任意
`Iterable<string>` 或 `AsyncIterable<string>` 模型输出，不依赖 React、Electron、VelarOS
Kernel、特定模型 SDK 或产品状态。

本包不负责模型调用、聊天记录、权限决策、用户身份、业务组件和宿主导航。Artifact 请求继续生成、
打开链接或发送自定义消息时，宿主必须通过显式回调决定是否执行。

## 安装

```bash
npm install @velaros-ai/html-artifacts
```

运行环境需要 Node.js 20 以上用于构建；浏览器运行时需要标准 DOM、iframe 和
`postMessage` 能力。包本身没有运行时依赖。

## 公共入口

| 入口 | 用途 |
| --- | --- |
| `@velaros-ai/html-artifacts` | 浏览器运行时、协议和沙箱公共 API |
| `@velaros-ai/html-artifacts/browser` | 只引入浏览器 Runtime 与宿主接口 |
| `@velaros-ai/html-artifacts/protocol` | 不依赖 DOM 的增量协议解析 |
| `@velaros-ai/html-artifacts/sandbox` | iframe Shell、尺寸和 URL 安全原语 |
| `@velaros-ai/html-artifacts/runtime` | `sandbox` 的兼容别名，新代码不建议使用 |

## 核心类与接口

### `HtmlArtifactRuntime`

`HtmlArtifactRuntime` 实现 `HtmlArtifactController`，独占一个解析器、iframe、消息队列和监听器：

```ts
const runtime = new HtmlArtifactRuntime(container, {
  maxHeight: 720,
  onPrompt: (prompt) => model.continue(prompt),
  onLink: (url) => navigation.open(url),
})

await runtime.consume(model.stream())
runtime.dispose()
```

`mountHtmlArtifact(target, options)` 是保留给函数式接入方式的兼容工厂，等价于创建
`HtmlArtifactRuntime`。

### `HtmlArtifactProtocolParser`

该类拥有一次增量解析会话的全部可变状态：

```ts
const parser = new HtmlArtifactProtocolParser({ enabled: true })
const events = parser.write(chunk)
const tailEvents = parser.finish()
const snapshot = parser.getSnapshot('artifact-id')
parser.reset()
```

需要自己持久化或迁移状态的高级宿主仍可使用
`createHtmlArtifactProtocolStreamState()`、`applyHtmlArtifactProtocolChunk()` 和
`finalizeHtmlArtifactProtocol()`。

### `HtmlArtifactBrowserEnvironment`

该接口隔离 iframe 创建、消息订阅、滚动和桥接 ID 生成。默认实现
`DomHtmlArtifactEnvironment` 使用当前 `window` 与 `document`。WebView、测试 DOM 或多窗口应用
可以注入自己的实现，无需修改全局对象。

## 生命周期/并发

一个 Runtime 同一时刻只允许一个 `consume()`。已有流未结束时再次调用会抛出错误。手动
`write()`/`finish()` 的调用顺序由宿主负责。

- `ready`：首次 iframe Shell 加载并冲刷消息队列后完成。
- `reset()`：保留 iframe 节点，重建解析状态、消息命名空间和 Shell 文档。
- `dispose()`：幂等；移除 iframe、窗口消息监听器和待发送消息。
- `dispose()` 后调用写入、结束或重置方法会抛出错误。

## 依赖注入

浏览器边界通过 `MountHtmlArtifactOptions.environment` 注入：

```ts
const runtime = new HtmlArtifactRuntime(container, {
  environment: {
    createBridgeId: () => crypto.randomUUID(),
    createIframe: () => webviewDocument.createElement('iframe'),
    addMessageListener: (listener) => hostMessages.subscribe(listener),
    removeMessageListener: (listener) => hostMessages.unsubscribe(listener),
    scrollBy: (x, y) => viewport.scrollBy(x, y),
  },
})
```

模型、导航、日志和业务行为通过回调注入。本包不会读取应用单例或 VelarOS 私有状态。

## 错误模型

`onError` 接收 `HtmlArtifactHostError`，`phase` 明确错误边界：

- `host`：宿主回调或 iframe 可用性错误。
- `protocol`：协议诊断。
- `runtime`：iframe 内执行错误。
- `security`：URL 等不可信输入被拒绝。

宿主回调抛出的异常会转成 `host` 错误，不会中断解析器。未提供 `onError` 时错误不会跨越宿主边界
抛出；非法生命周期调用仍会直接抛出。

## 最小第三方示例

```ts
import { HtmlArtifactRuntime } from '@velaros-ai/html-artifacts/browser'

const target = document.querySelector<HTMLElement>('#artifact')
if (!target) throw new Error('Missing artifact target')

const runtime = new HtmlArtifactRuntime(target, {
  title: 'AI generated preview',
  allowedLinkProtocols: ['https:'],
  onLink: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
})

try {
  await runtime.consume(fetchModelChunks())
} finally {
  runtime.dispose()
}
```

## 扩展点

- 用 `HtmlArtifactBrowserEnvironment` 适配不同浏览器或 WebView 宿主。
- 用 `onEvent` 把协议事件接入日志、调试器或遥测系统。
- 用 `designCss` 提供产品中立的基础设计令牌。
- 用 `protocolLimits` 限制缓冲、HTML、协议文本和 Patch 载荷。
- 直接组合 `protocol` 与 `sandbox` 子路径可实现非默认渲染器。

纯尺寸、URL 校验和协议解析算法保留为函数；只有拥有状态和生命周期的解析会话与浏览器运行时使用
类，避免无意义的对象包装。

## 兼容策略

- 已发布的 `mountHtmlArtifact()` 和底层协议函数继续保留。
- 新的类 API 与函数 API 使用相同事件、快照和限制类型，不做重复 DTO 转换。
- `runtime` 子路径暂时作为 `sandbox` 的兼容别名；新接入应使用语义明确的 `browser` 或
  `sandbox`。
- 公共 API 的破坏性变更只在主版本升级时进行。
