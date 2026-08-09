import type { CDPSession, Page } from '@stablyai/playwright-test'

/**
 * Drives real Chromium composition through CDP.
 *
 * `Input.imeSetComposition` puts the renderer into a genuine composition session — the same one a
 * native IME would open — so these specs need no system input source, no accessibility grant and
 * no visible window. That is what lets the geometry assertions this module feeds run headless in
 * CI instead of behind a `@headful` + macOS-only gate.
 */
export type ImeKeyIdentity = {
  key: string
  code: string
  keyCode: number
}

export async function setImeComposition(session: CDPSession, text: string): Promise<void> {
  const length = Array.from(text).length
  await session.send('Input.imeSetComposition', {
    text,
    selectionStart: length,
    selectionEnd: length
  })
}

export async function commitImeText(session: CDPSession, text: string): Promise<void> {
  await session.send('Input.insertText', { text })
}

/** IME preedit keystrokes reach the renderer as VK_PROCESSKEY (229) with no text payload. */
export async function dispatchImeProcessKey(
  session: CDPSession,
  identity: Pick<ImeKeyIdentity, 'key' | 'code'>
): Promise<void> {
  for (const type of ['rawKeyDown', 'keyUp'] as const) {
    await session.send('Input.dispatchKeyEvent', {
      type,
      key: identity.key,
      code: identity.code,
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
      text: '',
      unmodifiedText: ''
    })
  }
}

/**
 * A printable keydown whose `key` the IME has already rewritten to the glyph it will commit —
 * the shape a CJK input source produces for punctuation and full-width digits, which arrive with
 * no composition session at all.
 */
export async function dispatchImeRewrittenPrintableKey(
  session: CDPSession,
  identity: ImeKeyIdentity
): Promise<void> {
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: identity.key,
    code: identity.code,
    windowsVirtualKeyCode: identity.keyCode,
    nativeVirtualKeyCode: identity.keyCode,
    text: identity.key,
    unmodifiedText: identity.key
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: identity.key,
    code: identity.code,
    windowsVirtualKeyCode: identity.keyCode,
    nativeVirtualKeyCode: identity.keyCode
  })
}

/**
 * A printable keydown that still carries the **ASCII layout key**, followed by the substituted
 * glyph arriving through the text system.
 *
 * This is the macOS shape for full-width punctuation and digits: the input source rewrites the
 * character inside `insertText:`, not on the keydown, so the keydown Chromium delivers is the
 * plain `,` from the physical layout and the `，` only ever appears in the `input` event. Anything
 * that produces terminal bytes from the keydown emits the ASCII form and destroys the real one.
 */
export async function dispatchImeSubstitutedTextKey(
  session: CDPSession,
  identity: ImeKeyIdentity,
  committedText: string
): Promise<void> {
  // rawKeyDown carries no `text`, so Chromium generates no character of its own and the only
  // committed text is the one the input source supplies below.
  await session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: identity.key,
    code: identity.code,
    windowsVirtualKeyCode: identity.keyCode,
    nativeVirtualKeyCode: identity.keyCode,
    text: '',
    unmodifiedText: ''
  })
  await session.send('Input.insertText', { text: committedText })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: identity.key,
    code: identity.code,
    windowsVirtualKeyCode: identity.keyCode,
    nativeVirtualKeyCode: identity.keyCode
  })
}

export async function dispatchPlainEnter(session: CDPSession): Promise<void> {
  for (const type of ['rawKeyDown', 'keyUp'] as const) {
    await session.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    })
  }
}

/**
 * Composes one 2-Set Hangul syllable through its recorded jamo frames.
 *
 * `pauseMs = 0` drives the frames back to back with no settle time, which is how a fast typist's
 * key repeat reaches the renderer.
 */
export async function composeHangulSyllable(
  session: CDPSession,
  page: Page,
  frames: readonly { jamoKey: ImeKeyIdentity; preedit: string }[],
  pauseMs = 60
): Promise<void> {
  for (const frame of frames) {
    await dispatchImeProcessKey(session, frame.jamoKey)
    await setImeComposition(session, frame.preedit)
    if (pauseMs > 0) {
      await page.waitForTimeout(pauseMs)
    }
  }
}

/**
 * Emits a bare `compositionupdate` with no `compositionstart` ahead of it.
 *
 * SYNTHESISED, not replayed, and the reason is worth stating: the recorded Windows/WSL Hangul
 * capture in `fixtures/windows-wsl-2set-hangul-dom-trace.json` does **not** contain this ordering
 * — every one of its 37 composition updates sits inside an open start/end pair. The shape is
 * nevertheless reachable by construction, because xterm adds `.active` to the overlay only in its
 * `compositionstart` handler and its `compositionupdate` handler writes `textContent` without
 * ever re-adding it. CDP cannot produce the ordering either: `Input.imeSetComposition` always
 * opens a session first. So this is dispatched directly.
 */
export async function dispatchResumedCompositionUpdate(page: Page, data: string): Promise<void> {
  await page.evaluate((preedit: string) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
    if (!textarea) {
      throw new Error('xterm helper textarea is not focused')
    }
    textarea.dispatchEvent(
      new CompositionEvent('compositionupdate', {
        bubbles: true,
        data: preedit
      })
    )
    textarea.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        data: preedit,
        inputType: 'insertCompositionText',
        isComposing: true
      })
    )
  }, data)
}
