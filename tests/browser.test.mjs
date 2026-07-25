import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { mountHtmlArtifact } from '../dist/index.js'

class FakeEventTarget {
  listeners = new Map()

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

class FakeWindow extends FakeEventTarget {
  scrollCalls = []

  scrollBy(options) {
    this.scrollCalls.push(options)
  }
}

class FakeIframe extends FakeEventTarget {
  attributes = new Map()
  className = ''
  referrerPolicy = ''
  removed = false
  srcdoc = ''
  style = {}
  title = ''
  contentWindow = {
    messages: [],
    postMessage: (payload, targetOrigin) => {
      this.contentWindow.messages.push({ payload, targetOrigin })
    },
  }

  setAttribute(name, value) {
    this.attributes.set(name, value)
  }

  getBoundingClientRect() {
    return { height: Number.parseFloat(this.style.height) || 0 }
  }

  remove() {
    this.removed = true
  }
}

class FakeDocument {
  iframe = new FakeIframe()

  createElement(name) {
    assert.equal(name, 'iframe')
    return this.iframe
  }
}

class FakeTarget {
  children = []

  replaceChildren(...children) {
    this.children = children
  }
}

function bridgeType(source, suffix) {
  return source.match(new RegExp(`velaros:html-artifact:[^"']+:${suffix}`))?.[0]
}

async function withFakeDom(run) {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const window = new FakeWindow()
  const document = new FakeDocument()
  globalThis.window = window
  globalThis.document = document

  try {
    await run({ document, window })
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
}

describe('browser host', () => {
  test('owns streaming, sandbox transport, bounded sizing, callbacks, reset, and cleanup', async () => {
    await withFakeDom(async ({ document, window }) => {
      const prompts = []
      const links = []
      const errors = []
      const target = new FakeTarget()
      const controller = mountHtmlArtifact(target, {
        initialHeight: 100,
        minHeight: 60,
        maxHeight: 200,
        onError: (error) => errors.push(error),
        onLink: (url) => links.push(url),
        onPrompt: (prompt) => prompts.push(prompt),
      })
      const iframe = document.iframe
      const source =
        '<artifact version="1" id="card" title="Card">' +
        '<patch type="replace"><main id="app"></main></patch>' +
        '<patch type="append" target="#app"><h1>Hello</h1></patch>' +
        '</artifact>'

      assert.equal(target.children[0], iframe)
      assert.equal(iframe.attributes.get('sandbox'), 'allow-scripts')
      assert.equal(iframe.style.height, '100px')

      controller.write(source)
      assert.equal(iframe.contentWindow.messages.length, 0)
      iframe.dispatch('load')
      assert.equal(await controller.ready, iframe)
      assert.equal(
        iframe.contentWindow.messages.some(({ payload }) => payload.html?.includes('<main')),
        true
      )
      assert.match(controller.getSnapshot('card')?.html ?? '', /<main id="app"><\/main>/)
      assert.equal(
        iframe.contentWindow.messages.some(({ payload }) =>
          payload.patches?.some((patch) => patch.html?.includes('Hello'))
        ),
        true
      )

      const resize = bridgeType(iframe.srcdoc, 'resize')
      const prompt = bridgeType(iframe.srcdoc, 'prompt')
      const link = bridgeType(iframe.srcdoc, 'link')
      assert.ok(resize)
      assert.ok(prompt)
      assert.ok(link)

      window.dispatch('message', {
        data: { type: resize, naturalHeight: 999 },
        origin: 'null',
        source: iframe.contentWindow,
      })
      assert.equal(iframe.style.height, '200px')

      window.dispatch('message', {
        data: { type: prompt, prompt: 'Continue' },
        origin: 'null',
        source: iframe.contentWindow,
      })
      window.dispatch('message', {
        data: { type: link, url: 'javascript:alert(1)' },
        origin: 'null',
        source: iframe.contentWindow,
      })
      window.dispatch('message', {
        data: { type: link, url: 'https://example.com/docs' },
        origin: 'null',
        source: iframe.contentWindow,
      })
      assert.deepEqual(prompts, ['Continue'])
      assert.deepEqual(links, ['https://example.com/docs'])
      assert.equal(errors.at(-1)?.phase, 'security')

      window.dispatch('message', {
        data: { type: 'velaros:html-artifact-wheel', deltaX: 2, deltaY: 12 },
        origin: 'null',
        source: iframe.contentWindow,
      })
      assert.deepEqual(window.scrollCalls, [{ left: 2, top: 12 }])

      controller.reset()
      assert.equal(iframe.style.height, '100px')
      assert.equal(controller.getSnapshot(), null)
      const messageCountBeforeReload = iframe.contentWindow.messages.length
      controller.write(source)
      assert.equal(iframe.contentWindow.messages.length, messageCountBeforeReload)
      iframe.dispatch('load')
      assert.equal(iframe.contentWindow.messages.length > messageCountBeforeReload, true)

      controller.dispose()
      assert.equal(iframe.removed, true)
      assert.equal(window.listeners.get('message')?.size ?? 0, 0)
      assert.throws(() => controller.write('later'), /disposed/)
    })
  })

  test('consumes async iterables and returns the final snapshot', async () => {
    await withFakeDom(async ({ document }) => {
      const controller = mountHtmlArtifact(new FakeTarget())
      document.iframe.dispatch('load')

      async function* chunks() {
        yield '<artifact version="1" id="async" title="Async">'
        yield '<patch type="append"><p>Done</p></patch></artifact>'
      }

      const snapshot = await controller.consume(chunks())
      assert.equal(snapshot?.id, 'async')
      assert.match(snapshot?.html ?? '', /Done/)
      controller.dispose()
    })
  })

  test('accepts opaque-origin messages only from the mounted iframe contentWindow', async () => {
    await withFakeDom(async ({ document, window }) => {
      const prompts = []
      const target = new FakeTarget()
      const controller = mountHtmlArtifact(target, {
        onPrompt: (prompt) => prompts.push(prompt),
      })
      const iframe = document.iframe
      const prompt = bridgeType(iframe.srcdoc, 'prompt')
      assert.ok(prompt)

      iframe.dispatch('load')

      window.dispatch('message', {
        data: { type: prompt, prompt: 'trusted opaque frame' },
        origin: 'null',
        source: iframe.contentWindow,
      })
      assert.deepEqual(prompts, ['trusted opaque frame'])

      window.dispatch('message', {
        data: { type: prompt, prompt: 'missing source' },
        origin: 'null',
        source: null,
      })
      window.dispatch('message', {
        data: { type: prompt, prompt: 'forged source' },
        origin: 'null',
        source: {},
      })
      window.dispatch('message', {
        data: { type: prompt, prompt: 'different frame' },
        origin: 'null',
        source: new FakeIframe().contentWindow,
      })
      assert.deepEqual(prompts, ['trusted opaque frame'])

      window.dispatch('message', {
        data: { type: prompt, prompt: 'trusted non-opaque frame' },
        origin: 'https://example.com',
        source: iframe.contentWindow,
      })
      assert.deepEqual(prompts, ['trusted opaque frame', 'trusted non-opaque frame'])

      controller.dispose()
    })
  })
})
