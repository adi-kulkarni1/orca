/**
 * Headless end-to-end coverage for Japanese and Chinese terminal input.
 *
 * Two shapes are covered, and the second is the one the whole suite used to be blind to:
 *
 *  1. Phrase-level composition — a Japanese preedit that grows to several characters and converts
 *     to kanji, asserted on the overlay's real geometry rather than on the bytes it later emits.
 *  2. Committed text that arrives with **no composition session at all**. Full-width punctuation
 *     (`，` `。` `、`) and full-width digits are typed as a single keystroke that the input source
 *     rewrites; there is no compositionstart/update/end around them. Every IME test in the repo
 *     was composition-session-shaped, so this shape was invisible to the suite by construction —
 *     which is how `，` reaching the shell as an ASCII `,` shipped to users.
 *
 * The assertion for shape 2 is deliberately "the ASCII byte never appears" rather than "the
 * substitution was applied": the correct design never manufactures the ASCII byte in the first
 * place, so pinning its absence stays true under a forwarder rewrite as well as under a
 * structural one.
 */
import type { CDPSession, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  attachTerminalImeBoundaryEvidence,
  disposeTerminalImeBoundaryProbe,
  installTerminalImeBoundaryProbe,
  readTerminalImeBoundaryTrace
} from './terminal-ime-boundary-probe'
import {
  commitImeText,
  dispatchImeProcessKey,
  dispatchImeRewrittenPrintableKey,
  dispatchImeSubstitutedTextKey,
  dispatchPlainEnter,
  setImeComposition,
  type ImeKeyIdentity
} from './terminal-ime-cdp-composition'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'
import { expectPreeditHidden, expectPreeditRendered } from './terminal-ime-preedit-overlay-probe'

const MAC_IME_POLICY_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/146 Safari/537.36'

/** Frames a Japanese IME shows while typing にほんご and converting it to 日本語. */
const JAPANESE_FRAMES = ['に', 'にほ', 'にほん', 'にほんご', '日本語'] as const

/**
 * Substitutions an East Asian input source commits from one keystroke, with no composition session
 * around them. `ascii` is the character the physical key carries in the Latin layout — the byte the
 * user must never see — and `glyph` is what the input source actually committed.
 */
type SubstitutedKeystroke = ImeKeyIdentity & { glyph: string; ascii: string }

const FULL_WIDTH_PUNCTUATION: readonly SubstitutedKeystroke[] = [
  { key: ',', code: 'Comma', keyCode: 188, glyph: '，', ascii: ',' },
  { key: '.', code: 'Period', keyCode: 190, glyph: '。', ascii: '.' },
  { key: ',', code: 'Comma', keyCode: 188, glyph: '、', ascii: ',' }
]

const FULL_WIDTH_DIGITS: readonly SubstitutedKeystroke[] = [
  { key: '1', code: 'Digit1', keyCode: 49, glyph: '１', ascii: '1' },
  { key: '2', code: 'Digit2', keyCode: 50, glyph: '２', ascii: '2' },
  { key: '3', code: 'Digit3', keyCode: 51, glyph: '３', ascii: '3' }
]

const SUBSTITUTION_GROUPS = [
  { label: 'punctuation', keystrokes: FULL_WIDTH_PUNCTUATION },
  { label: 'digits', keystrokes: FULL_WIDTH_DIGITS }
] as const

/**
 * The two ways a substituted keystroke can reach the renderer. Both are real; only the second one
 * regressed, and only the second one can regress, which is why running both is the point.
 */
const SUBSTITUTION_SHAPES: readonly {
  name: string
  slug: string
  knownBroken: boolean
  knownBrokenReason: string
  dispatch: (session: CDPSession, keystroke: SubstitutedKeystroke) => Promise<void>
}[] = [
  {
    // Green, and honest about its limits: xterm's own key handler emits `event.key`, so this shape
    // survives with or without a forwarder and would have passed throughout the regression. It
    // guards the frameworks that do rewrite `key`; it is not the regression guard.
    name: 'the keydown already carries the substituted glyph',
    slug: 'rewritten-keydown',
    knownBroken: false,
    knownBrokenReason: '',
    dispatch: (session, keystroke) =>
      dispatchImeRewrittenPrintableKey(session, {
        key: keystroke.glyph,
        code: keystroke.code,
        keyCode: keystroke.keyCode
      })
  },
  {
    // Red on `main`, by design — this is the acceptance criterion, not a flake.
    //
    // The keydown carries the plain Latin `,` and the `，` exists only in the following `input`
    // event, so anything that produces bytes from the keydown emits the ASCII form and destroys
    // the real one. Today the bypass that would prevent that is gated on the OS reporting an
    // input source whose id matches a 23-term allowlist. That read returns null on every
    // non-macOS host and `com.apple.keylayout.*` on a macOS runner with no CJK source selected,
    // and the preload API surface is frozen so no spec can stub it — meaning correctness here is
    // not expressible as a test until the gate goes away.
    //
    // Closed by the structural rule in the re-land design: bytes for printable characters come
    // only from the `input` event, decided on the event's own shape with no input-source read.
    // When that lands, this test starts passing and Playwright fails the run until the
    // `test.fail()` marker below is deleted.
    name: 'the keydown still carries the ASCII layout key',
    slug: 'substituted-insert-text',
    knownBroken: true,
    knownBrokenReason:
      'the keydown-side bypass is gated on a macOS input-source allowlist, so the ASCII form wins on every host that cannot satisfy it',
    dispatch: (session, keystroke) =>
      dispatchImeSubstitutedTextKey(session, keystroke, keystroke.glyph)
  }
]

/**
 * The keydown bypass that owns single-keystroke IME commits only installs when the renderer reports
 * macOS, and the ASCII downgrade is a macOS-only failure mode: Windows and Linux frameworks claim
 * the same keystroke as VK_PROCESSKEY, so their version of the defect is a drop rather than a
 * downgrade. Overriding the UA is how the repo already exercises Windows- and Linux-gated IME
 * policy from any runner, and it is what lets this run on the Linux CI shards.
 */
async function reloadWithMacImePolicy(page: Page): Promise<void> {
  await page.addInitScript((userAgent) => {
    Object.defineProperty(navigator, 'userAgent', {
      get: () => userAgent,
      configurable: true
    })
  }, MAC_IME_POLICY_USER_AGENT)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__store), null, {
    timeout: 30_000
  })
}

type CjkTerminalArena = {
  page: Page
  session: CDPSession
  ptyId: string
}

async function openTerminalArena(page: Page): Promise<{ ptyId: string; session: CDPSession }> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await waitForActivePanePtyId(page)
  const session = await page.context().newCDPSession(page)
  return { ptyId, session }
}

async function teardownTerminalArena(
  arena: CjkTerminalArena,
  testInfo: TestInfo,
  evidenceName: string,
  interrupt: boolean
): Promise<void> {
  await attachTerminalImeBoundaryEvidence(arena.page, testInfo, evidenceName).catch(() => undefined)
  await disposeTerminalImeBoundaryProbe(arena.page).catch(() => undefined)
  await arena.session.detach().catch(() => undefined)
  if (interrupt) {
    await sendToTerminal(arena.page, arena.ptyId, '\x03').catch(() => undefined)
  }
}

test.describe('Terminal CJK IME committed text', () => {
  test('shows a growing Japanese phrase preedit and commits the converted kanji', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    const { ptyId, session } = await openTerminalArena(orcaPage)
    const arena: CjkTerminalArena = { page: orcaPage, session, ptyId }
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, ptyId, reader)
      await focusActiveTerminalInput(orcaPage)
      await installTerminalImeBoundaryProbe(orcaPage)

      await expectPreeditHidden(orcaPage, 'before composing')
      await dispatchImeProcessKey(session, { key: 'Process', code: 'KeyN' })

      const widthByFrame = new Map<string, number>()
      for (const frame of JAPANESE_FRAMES) {
        await setImeComposition(session, frame)
        const sample = await expectPreeditRendered(orcaPage, frame, `composing ${frame}`)
        widthByFrame.set(frame, sample.rect.width)
      }
      // A phrase-level preedit must widen as it grows. An overlay pinned to one cell renders only
      // the first character, which is a shape every non-geometric assertion reports as correct.
      expect(widthByFrame.get('にほんご')!).toBeGreaterThan(widthByFrame.get('に')!)
      expect(widthByFrame.get('日本語')!).toBeGreaterThan(widthByFrame.get('に')!)

      await commitImeText(session, '日本語')
      await expectPreeditHidden(orcaPage, 'after committing 日本語')
      await dispatchPlainEnter(session)

      const received = await waitForTerminalImeBytes(orcaPage, reader)
      expect(received).toEqual([Buffer.from('日本語\n').toString('hex')])
      completed = true
    } finally {
      await teardownTerminalArena(arena, testInfo, 'japanese-phrase-preedit', !completed)
      removeTerminalImeByteReader(reader)
    }
  })

  for (const shape of SUBSTITUTION_SHAPES) {
    for (const group of SUBSTITUTION_GROUPS) {
      test(`sends full-width ${group.label} and never their ASCII form when ${shape.name}${shape.knownBroken ? ' @ime-known-broken' : ''}`, async ({
        orcaPage,
        testRepoPath
      }, testInfo) => {
        test.fail(shape.knownBroken, shape.knownBrokenReason)
        await reloadWithMacImePolicy(orcaPage)
        const { ptyId, session } = await openTerminalArena(orcaPage)
        const arena: CjkTerminalArena = { page: orcaPage, session, ptyId }
        const reader = createTerminalImeByteReader(testRepoPath, 1)
        const expected = group.keystrokes.map((keystroke) => keystroke.glyph).join('')
        let completed = false
        try {
          await startTerminalImeByteReader(orcaPage, ptyId, reader)
          await focusActiveTerminalInput(orcaPage)
          await installTerminalImeBoundaryProbe(orcaPage)

          for (const keystroke of group.keystrokes) {
            await shape.dispatch(session, keystroke)
            await orcaPage.waitForTimeout(60)
          }
          await dispatchPlainEnter(session)

          const sent = (await readTerminalImeBoundaryTrace(orcaPage)).onData.join('')
          for (const keystroke of group.keystrokes) {
            expect(
              sent,
              `${keystroke.glyph} reached the PTY as ASCII ${keystroke.ascii}`
            ).not.toContain(keystroke.ascii)
          }
          expect(sent).toBe(`${expected}\r`)

          const received = await waitForTerminalImeBytes(orcaPage, reader)
          expect(received).toEqual([Buffer.from(`${expected}\n`).toString('hex')])
          completed = true
        } finally {
          await teardownTerminalArena(
            arena,
            testInfo,
            `full-width-${group.label}-${shape.slug}`,
            !completed
          )
          removeTerminalImeByteReader(reader)
        }
      })
    }
  }

  test('forwards Chinese pinyin conversions and their trailing full-width stop together', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await reloadWithMacImePolicy(orcaPage)
    const { ptyId, session } = await openTerminalArena(orcaPage)
    const arena: CjkTerminalArena = { page: orcaPage, session, ptyId }
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, ptyId, reader)
      await focusActiveTerminalInput(orcaPage)
      await installTerminalImeBoundaryProbe(orcaPage)

      await dispatchImeProcessKey(session, { key: 'Process', code: 'KeyN' })
      for (const frame of ['n', 'ni', 'niha', 'nihao', '你好']) {
        await setImeComposition(session, frame)
        await expectPreeditRendered(orcaPage, frame, `composing ${frame}`)
      }
      await commitImeText(session, '你好')
      await expectPreeditHidden(orcaPage, 'after committing 你好')

      // The distinct risk here is the adjacency, not the substitution: the stop arrives with no
      // composition session immediately after one closed, so a tracker that still believes a
      // composition is open swallows it. Dispatched in the glyph-carrying shape so this stays a
      // test of the transition rather than a second copy of the known-broken case above.
      await dispatchImeRewrittenPrintableKey(session, {
        key: '。',
        code: 'Period',
        keyCode: 190
      })
      await orcaPage.waitForTimeout(60)
      await dispatchPlainEnter(session)

      const trace = await readTerminalImeBoundaryTrace(orcaPage)
      expect(trace.onData.join('')).toBe('你好。\r')

      const received = await waitForTerminalImeBytes(orcaPage, reader)
      expect(received).toEqual([Buffer.from('你好。\n').toString('hex')])
      completed = true
    } finally {
      await teardownTerminalArena(arena, testInfo, 'pinyin-with-full-width-stop', !completed)
      removeTerminalImeByteReader(reader)
    }
  })
})
