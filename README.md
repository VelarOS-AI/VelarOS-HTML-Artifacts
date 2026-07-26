# VelarOS HTML Artifacts

[![CI](https://github.com/VelarOS-AI/VelarOS-HTML-Artifacts/actions/workflows/ci.yml/badge.svg)](https://github.com/VelarOS-AI/VelarOS-HTML-Artifacts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-111111.svg)](./LICENSE)

Turn an incremental model text stream into a live, sandboxed HTML interface.

VelarOS HTML Artifacts is a dependency-free browser runtime with a small TypeScript API. It owns the protocol parser, iframe lifecycle, patch transport, bounded height negotiation, link validation, and cleanup so an application does not have to assemble those pieces itself.

[中文文档](./README.zh-CN.md)

## Install

`@velaros-ai/html-artifacts` is a public package hosted on GitHub Packages. GitHub's
npm registry currently still requires authentication to install public packages:
use a personal access token (classic) with at least `read:packages` locally, or the
repository-authorized `GITHUB_TOKEN` in GitHub Actions. Map the `@velaros-ai` scope
to `https://npm.pkg.github.com`, provide the token, then install:

```bash
npm install @velaros-ai/html-artifacts
```

The repository versions `dist/`, so npm, pnpm, Bun, and Yarn can consume the Git dependency without running a build script.

## Quick start

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

// When the surrounding view is destroyed:
artifact.dispose()
```

`modelTextStream` may be an `AsyncIterable<string>` from any model provider. The library does not depend on React, Electron, an agent loop, or a particular API client.

The mount call creates one `sandbox="allow-scripts"` iframe inside the target element. Generated code stays inside that iframe. Capabilities such as opening a link or sending a new prompt are explicit callbacks owned by the host.

## Manual streaming

Use `consume()` for the common case. Use `write()` and `finish()` when your transport already has its own stream loop:

```ts
const artifact = mountHtmlArtifact(container, { maxHeight: 720 })

for await (const chunk of modelTextStream) {
  artifact.write(chunk)
}
artifact.finish()

// Reuse the same iframe for a later response.
artifact.reset()

// Remove the iframe and every host listener.
artifact.dispose()
```

Chunks may end in the middle of a tag, CSS rule, script, or Base64 payload. Only safe protocol boundaries are emitted to the iframe runtime.

## Host callbacks

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

HTTP and HTTPS are the only link protocols allowed by default. Invalid or active URLs are reported through `onError` and never reach `onLink`.

## Stable sizing

```ts
const artifact = mountHtmlArtifact(container, {
  initialHeight: 360,
  minHeight: 1,
  maxHeight: 720,
})
```

The iframe runtime publishes a deduplicated absolute content height. The host applies that exact value without adding padding or feeding viewport growth back into the measurement. `maxHeight` is enforced in both the iframe runtime and the browser host; taller or viewport-coupled documents scroll inside the sandbox instead of growing the outer page forever.

## Artifact protocol

The v1 wire format is deliberately small:

```html
<artifact version="1" id="profile-card" title="Profile card">
  <patch type="replace"><main id="app"></main></patch>
  <patch type="append" target="#app"><h1>Hello</h1></patch>
  <patch type="style" id="base">#app { padding: 24px; }</patch>
  <patch type="script" id="boot">console.log('ready')</patch>
</artifact>
```

Use `encoding="base64"` when a patch payload itself contains protocol closing tags.

## Advanced APIs

Most applications should only use `mountHtmlArtifact()` from the package root. Two lower-level entry points are available for custom hosts:

```ts
// Renderer-neutral incremental parser.
import {
  applyHtmlArtifactProtocolChunk,
  createHtmlArtifactProtocolStreamState,
  finalizeHtmlArtifactProtocol,
} from '@velaros-ai/html-artifacts/protocol'

// iframe document, sizing, and URL primitives.
import {
  buildHtmlArtifactShellDocument,
  normalizeHtmlArtifactExternalUrl,
  resolveHtmlArtifactFrameFit,
} from '@velaros-ai/html-artifacts/sandbox'
```

`@velaros-ai/html-artifacts/runtime` remains as a compatibility alias for `./sandbox`.

## API

### `mountHtmlArtifact(target, options?)`

Mounts a managed artifact iframe and returns an `HtmlArtifactController`.

Important options:

- `initialHeight`, `minHeight`, `maxHeight`: bounded iframe sizing.
- `sandbox`: iframe sandbox tokens; defaults to `allow-scripts`.
- `designCss`, `rootId`, `title`, `className`: host presentation hooks.
- `protocolLimits`: resource limits for untrusted or unexpectedly large streams.
- `onMarkdown`, `onPrompt`, `onLink`, `onMessage`, `onEvent`, `onError`: host callbacks.

Controller methods:

- `consume(stream)`: consume an iterable of text chunks and return the latest protocol snapshot.
- `write(chunk)`: parse and render one chunk.
- `finish()`: flush an interrupted final chunk.
- `getSnapshot(id?)`: read the latest parser snapshot.
- `reset()`: clear parser and iframe content while keeping the mount alive.
- `dispose()`: remove the iframe and all listeners.

## Design boundary

This repository owns reusable streaming and sandbox mechanics. It intentionally does not include model prompts, chat state, agent orchestration, Electron IPC, product UI, permissions, Widget, memory, or VelarOS Kernel internals.

The public repository is the source of truth. Generic fixes land here first; products consume an exact released version and keep only their product-specific adapter.

## Development

```bash
npm install
npm run check
npm run demo
```

`npm run check` runs TypeScript validation, Node tests, a production demo build, and a package dry run.

## Security

Generated HTML is untrusted input. Read [SECURITY.md](./SECURITY.md) before changing sandbox, script, URL, or bridge behavior.

## License

MIT © 2026 Error-Zhang
