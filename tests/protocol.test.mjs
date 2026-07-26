import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  applyHtmlArtifactProtocolChunk,
  createHtmlArtifactProtocolStreamState,
  finalizeHtmlArtifactProtocol,
  HtmlArtifactProtocolParser,
} from '../dist/protocol.js'

function streamInChunks(source, chunkSize = 7) {
  const state = createHtmlArtifactProtocolStreamState({ enabled: true })
  const events = []

  for (let offset = 0; offset < source.length; offset += chunkSize) {
    events.push(...applyHtmlArtifactProtocolChunk(state, source.slice(offset, offset + chunkSize)))
  }
  events.push(...finalizeHtmlArtifactProtocol(state))

  return { events, state }
}

describe('HTML artifact protocol', () => {
  test('offers an owned parser lifecycle without exposing mutable setup state', () => {
    const parser = new HtmlArtifactProtocolParser({ enabled: true })

    parser.write('<artifact version="1" id="owned" title="Owned">')
    parser.write('<patch type="append"><p>Ready</p></patch></artifact>')
    parser.finish()

    assert.match(parser.getSnapshot('owned')?.html ?? '', /Ready/)
    parser.reset()
    assert.equal(parser.getSnapshot('owned'), null)
    assert.equal(parser.state.mode, 'markdown')
  })

  test('returns an immutable parser state snapshot', () => {
    const parser = new HtmlArtifactProtocolParser({ enabled: true })
    parser.write(
      '<artifact version="1" id="one" title="One"><patch type="append">hello</patch>'
    )
    const state = parser.state

    assert.throws(() => {
      state.artifactsById.one = { id: 'two', title: 'Two', html: 'changed' }
    }, TypeError)
    assert.throws(() => {
      state.limits.maxBufferLength = 1
    }, TypeError)
    assert.equal(parser.getSnapshot('one')?.html, 'hello')
  })

  test('parses a complete artifact across arbitrary chunk boundaries', () => {
    const source = [
      '<artifact version="1" id="profile-card" title="Profile">',
      '<patch type="replace"><main id="app"></main></patch>',
      '<patch type="append" target="#app"><h1>Hello</h1></patch>',
      '<patch type="style" id="base">#app { color: rebeccapurple; }</patch>',
      '<patch type="script" id="boot">window.ready = true</patch>',
      '</artifact>',
    ].join('')

    const { events, state } = streamInChunks(source, 3)
    const patches = events.filter((event) => event.type === 'artifact-patch')

    assert.equal(events.filter((event) => event.type === 'artifact-open').length, 1)
    assert.equal(events.some((event) => event.type === 'artifact-update'), true)
    assert.deepEqual([...new Set(patches.map((event) => event.patch.type))], [
      'append',
      'style',
      'script',
    ])
    assert.equal(events.at(-1)?.type, 'artifact-close')
    assert.match(state.artifactsById['profile-card'].html, /main id="app"/)
    assert.equal(
      patches.some((event) => event.patch.type === 'append' && /Hello/.test(event.patch.html)),
      true
    )
  })

  test('keeps unsupported protocol versions as ordinary Markdown', () => {
    const source = '<artifact version="99" id="future" title="Future">hello</artifact>'
    const { events } = streamInChunks(source, 2)

    assert.equal(events.some((event) => event.type === 'artifact-open'), false)
    assert.equal(
      events
        .filter((event) => event.type === 'markdown')
        .map((event) => event.text)
        .join(''),
      source
    )
  })

  test('decodes protocol-sensitive base64 patch payloads', () => {
    const encoded = Buffer.from("window.message = '</patch>'", 'utf8').toString('base64')
    const source = `<artifact version="1" id="encoded" title="Encoded"><patch type="script" id="boot" encoding="base64">${encoded}</patch></artifact>`
    const { events } = streamInChunks(source, 5)
    const script = events.find(
      (event) => event.type === 'artifact-patch' && event.patch.type === 'script'
    )

    assert.ok(script)
    assert.equal(script.patch.code, "window.message = '</patch>'")
  })

  test('finalizes an interrupted artifact without leaving streaming state behind', () => {
    const state = createHtmlArtifactProtocolStreamState({ enabled: true })
    applyHtmlArtifactProtocolChunk(
      state,
      '<artifact version="1" id="partial" title="Partial"><patch type="append"><p>Saved'
    )

    const events = finalizeHtmlArtifactProtocol(state)

    assert.equal(events.at(-1)?.type, 'artifact-close')
    assert.equal(state.mode, 'markdown')
    assert.equal(state.activeArtifact, null)
    assert.equal(state.activeAction, null)
  })
})
