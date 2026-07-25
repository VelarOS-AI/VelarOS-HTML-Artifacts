import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import vm from 'node:vm'

import {
  buildHtmlArtifactShellDocument,
  HTML_ARTIFACT_WHEEL_MESSAGE_TYPE,
} from '../dist/sandbox.js'

function readBridgeHeadScript() {
  const html = buildHtmlArtifactShellDocument()
  const match = html.match(/<script>([\s\S]*?)<\/script><\/head>/u)
  assert.ok(match?.[1], 'expected HTML artifact bridge script in the document head')
  return match[1]
}

function createWheelBridgeHarness({ embedded, rootScrollable = false }) {
  const registrations = new Map()
  const messages = []
  const parentWindow = {
    postMessage(message) {
      messages.push(structuredClone(message))
    },
  }
  const iframeWindow = {
    addEventListener(type, listener, options) {
      registrations.set(type, { listener, options })
    },
  }
  iframeWindow.parent = embedded ? parentWindow : iframeWindow

  vm.runInNewContext(readBridgeHeadScript(), {
    document: {
      documentElement: {
        clientHeight: 240,
        clientWidth: 320,
        scrollHeight: rootScrollable ? 480 : 240,
        scrollWidth: 320,
      },
    },
    window: iframeWindow,
  })

  const registration = registrations.get('wheel')
  assert.ok(registration, 'expected wheel bridge listener to be installed')
  return { messages, registration }
}

describe('HTML artifact wheel bridge', () => {
  test('gives an embedded host exclusive ownership of a forwarded wheel gesture', () => {
    const { messages, registration } = createWheelBridgeHarness({ embedded: true })
    let prevented = false

    registration.listener({
      cancelable: true,
      deltaX: 4,
      deltaY: 36,
      preventDefault: () => {
        prevented = true
      },
    })

    assert.equal(prevented, true)
    assert.equal(registration.options?.capture, true)
    assert.equal(registration.options?.passive, false)
    assert.deepEqual(messages, [
      {
        type: HTML_ARTIFACT_WHEEL_MESSAGE_TYPE,
        deltaX: 4,
        deltaY: 36,
      },
    ])
  })

  test('does not intercept wheel gestures in a standalone downloaded artifact', () => {
    const { messages, registration } = createWheelBridgeHarness({ embedded: false })
    let prevented = false

    registration.listener({
      cancelable: true,
      deltaX: 0,
      deltaY: 24,
      preventDefault: () => {
        prevented = true
      },
    })

    assert.equal(prevented, false)
    assert.deepEqual(messages, [])
  })

  test('keeps the iframe in control while its root document is scrollable', () => {
    const { messages, registration } = createWheelBridgeHarness({
      embedded: true,
      rootScrollable: true,
    })
    let prevented = false

    registration.listener({
      cancelable: true,
      deltaX: 0,
      deltaY: 24,
      preventDefault: () => {
        prevented = true
      },
    })

    assert.equal(prevented, false)
    assert.deepEqual(messages, [])
  })
})
