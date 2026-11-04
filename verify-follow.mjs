/**
 * Isolated verification for 会话跟随第二阶段（v0.5.0，纯 client 半）:
 * - dual data sources: betterSidebar (documented contract, primary) +
 *   ctx.sessions.list (first-party fallback) — reachability probing,
 *   switch-event capture, legacy current and retained mainView snapshots,
 *   merge rule (betterSidebar non-empty wins),
 * - three-state reads (string / explicit-null / read-error keeps last),
 * - defensive shapes (absent / bad-shape sources degrade to no-follow),
 * - timer-driven re-probe for not-yet-ready services,
 * - fiber cleanup via ctx.effect disposers.
 *
 * lib/follow.js is dependency-free, so this script exercises the exact
 * artifact the browser bundle ships — nothing touches the filesystem.
 */

let failures = 0
function assert(cond, label) {
  if (cond) console.log(`  ✓ ${label}`)
  else { failures++; console.log(`  ✗ ${label}`) }
}

function makeSessions(initial) {
  const state = { snapshot: { current: initial }, subscribed: false, unsubscribed: false, readError: false }
  let listener = () => {}
  return {
    state,
    publish() { listener() },
    service: {
      list: {
        getSnapshot() {
          if (state.readError) throw new Error('snapshot unavailable')
          return state.snapshot
        },
        subscribe(fn) { listener = fn; state.subscribed = true; return () => { state.unsubscribed = true } },
      },
    },
  }
}

function makeBetterSidebar(initial) {
  const state = { snapshot: { sessionId: initial }, subscribed: false, unsubscribed: false }
  let listener = () => {}
  return {
    state,
    publish() { listener() },
    service: {
      getSnapshot() { return state.snapshot },
      subscribeState(fn) { listener = fn; state.subscribed = true; return () => { state.unsubscribed = true } },
    },
  }
}

function makeCtx({ betterSidebar, sessions, timer } = {}) {
  const cleanups = []
  let timerTick = null
  return {
    cleanups,
    ctx: {
      get(name) {
        if (name === 'betterSidebar') return betterSidebar === undefined ? undefined : betterSidebar.service ?? betterSidebar
        if (name === 'sessions') return sessions === undefined ? undefined : sessions.service ?? sessions
        if (name === 'timer') {
          if (timer === undefined) return undefined
          return { interval(cb) { timerTick = cb; return () => { timerTick = null } } }
        }
        return undefined
      },
      effect(cb) {
        const d = cb()
        if (typeof d === 'function') cleanups.push(d)
        return d
      },
    },
    fireTimerTick() { if (timerTick !== null) timerTick() },
  }
}

async function main() {
  const {
    startFollowing, getFollowedSessionId, subscribeFollowed, resetFollowedForTest,
  } = await import('./lib/follow.js')

  // ── 1. sessions only（betterSidebar 缺席）──
  console.log('sessions.list as the only source...')
  {
    resetFollowedForTest()
    const se = makeSessions('session-aaaa1111')
    const { ctx } = makeCtx({ sessions: se })
    const notified = []
    subscribeFollowed(() => notified.push(getFollowedSessionId()))
    startFollowing(ctx)
    assert(getFollowedSessionId() === 'session-aaaa1111', `attach reads the current selection (got ${getFollowedSessionId()})`)
    se.state.snapshot = { current: 'session-bbbb2222' }
    se.publish()
    assert(getFollowedSessionId() === 'session-bbbb2222', 'switch event updates the follow id')
    assert(notified[notified.length - 1] === 'session-bbbb2222', 'listeners notified')
    // read error keeps the last known value (never mistakes a fault for "no session")
    se.state.readError = true
    se.publish()
    assert(getFollowedSessionId() === 'session-bbbb2222', 'store error keeps the last known value, no crash')
    se.state.readError = false
    // explicit no-current clears the follow (host falls back)
    se.state.snapshot = { current: undefined }
    se.publish()
    assert(getFollowedSessionId() === null, 'explicit no-current clears the follow')
  }

  // Current DSH sessions.list has byId and retainedBy.mainView, without current.
  console.log('sessions.list retained mainView selection...')
  {
    resetFollowedForTest()
    const se = makeSessions()
    const row = (id, mainView, updatedAt = 0) => ({ id, retainedBy: { mainView }, updatedAt })
    const retained = id => ({ byId: {
      newest: row('session-newest', 0, 999),
      background: { id: 'session-background', retainedBy: { background: 1 } },
      selected: row(id, 1, 1),
    } })
    se.state.snapshot = retained('session-view-a')
    const { ctx } = makeCtx({ sessions: se })
    const notified = []
    subscribeFollowed(() => notified.push(getFollowedSessionId()))
    startFollowing(ctx)
    assert(getFollowedSessionId() === 'session-view-a', 'mainView selects the viewed session, not the first or most recent row')
    se.state.snapshot = retained('session-view-b')
    se.publish()
    assert(getFollowedSessionId() === 'session-view-b' && notified.at(-1) === 'session-view-b', 'mainView switch updates selection and notifies listeners')
    se.state.readError = true
    se.publish()
    assert(getFollowedSessionId() === 'session-view-b', 'retained snapshot read error preserves the last known selection')
    se.state.readError = false
    se.state.snapshot = { byId: { newest: row('session-newest', 0, 999) } }
    se.publish()
    assert(getFollowedSessionId() === null, 'no mainView retention clears selection without following a recent session')
    se.state.snapshot = { byId: { a: row('session-view-a', 1), b: row('session-view-b', 1) } }
    se.publish()
    assert(getFollowedSessionId() === null, 'ambiguous retained views do not select an arbitrary session')
    se.state.snapshot = { current: 'session-legacy', ...retained('session-view-b') }
    se.publish()
    assert(getFollowedSessionId() === 'session-legacy', 'legacy current remains authoritative when both formats exist')
    for (const current of [undefined, null, '']) {
      se.state.snapshot = { current, ...retained('session-view-b') }
      se.publish()
      assert(getFollowedSessionId() === null, `explicit legacy clear (${String(current)}) does not revive retained rows`)
    }
    for (const byId of [null, [], 'invalid', { invalid: null }, {
      negative: row('negative', -1), text: row('text', '1'), infinite: row('infinite', Infinity),
      nan: row('nan', NaN), missing: { id: 'missing' },
    }]) {
      se.state.snapshot = { byId }
      se.publish()
      assert(getFollowedSessionId() === null, 'malformed or non-positive retention does not imply selection')
    }
    se.state.snapshot = { byId: { invalid: row('', 1) } }
    se.publish()
    assert(getFollowedSessionId() === null, 'a retained row without a usable id does not become a selection')
    se.state.snapshot = retained('session-view-c')
    se.publish()
    assert(getFollowedSessionId() === 'session-view-c', 'valid retained selection recovers after empty or malformed snapshots')
  }

  // ── 2. betterSidebar only（sessions 缺席）──
  console.log('betterSidebar as the only source...')
  {
    resetFollowedForTest()
    const bs = makeBetterSidebar('session-cccc3333')
    const { ctx } = makeCtx({ betterSidebar: bs })
    startFollowing(ctx)
    assert(getFollowedSessionId() === 'session-cccc3333', `attach reads the active sessionId (got ${getFollowedSessionId()})`)
    bs.state.snapshot = { sessionId: 'session-dddd4444' }
    bs.publish()
    assert(getFollowedSessionId() === 'session-dddd4444', 'subscribeState switch updates the follow id')
  }

  // ── 3. both present: betterSidebar 非空值优先；空值回落 sessions ──
  console.log('merge rule (betterSidebar primary, sessions fallback)...')
  {
    resetFollowedForTest()
    const bs = makeBetterSidebar('session-eeee5555')
    const se = makeSessions('session-ffff6666')
    const { ctx } = makeCtx({ betterSidebar: bs, sessions: se })
    startFollowing(ctx)
    assert(getFollowedSessionId() === 'session-eeee5555', `betterSidebar non-empty wins (got ${getFollowedSessionId()})`)
    se.state.snapshot = { current: 'session-gggg7777' }
    se.publish()
    assert(getFollowedSessionId() === 'session-eeee5555', 'betterSidebar stays authoritative while non-empty')
    bs.state.snapshot = { sessionId: undefined } // bs 明确无激活
    bs.publish()
    assert(getFollowedSessionId() === 'session-gggg7777', 'betterSidebar null falls back to sessions.current')
    se.state.snapshot = { byId: { viewed: { id: 'session-retained', retainedBy: { mainView: 1 } } } }
    se.publish()
    assert(getFollowedSessionId() === 'session-retained', 'betterSidebar null falls back to the retained mainView')
    bs.state.snapshot = { sessionId: 'session-sidebar' }
    bs.publish()
    assert(getFollowedSessionId() === 'session-sidebar', 'betterSidebar non-empty selection still overrides retained mainView')
  }

  // ── 4. defensive shapes ──
  console.log('defensive shapes degrade to no-follow...')
  {
    resetFollowedForTest()
    const badSessions = { service: { list: { getSnapshot: 'not-a-function' } } }
    const bs = makeBetterSidebar('session-hhhh8888')
    const { ctx } = makeCtx({ betterSidebar: bs, sessions: badSessions })
    startFollowing(ctx)
    assert(getFollowedSessionId() === 'session-hhhh8888', 'bad-shape sessions.list treated as absent, betterSidebar used')

    resetFollowedForTest()
    const badBs = { service: { getSnapshot: () => ({}), subscribeState: 'nope' } }
    const { ctx: ctx2 } = makeCtx({ betterSidebar: badBs })
    startFollowing(ctx2)
    assert(getFollowedSessionId() === null, 'bad-shape betterSidebar treated as absent, no crash')

    resetFollowedForTest()
    const { ctx: ctx3 } = makeCtx({})
    startFollowing(ctx3)
    assert(getFollowedSessionId() === null, 'both sources absent → silent no-follow')
  }

  // ── 5. timer re-probe：服务晚到也能订上 ──
  console.log('timer re-probe for late services...')
  {
    resetFollowedForTest()
    const lateSe = makeSessions('session-jjjj0000')
    let present = false
    const timerTickHolder = { cb: null }
    const retryCtx = {
      get(name) {
        if (name === 'sessions') return present ? lateSe.service : undefined
        if (name === 'timer') return { interval(cb) { timerTickHolder.cb = cb; return () => { timerTickHolder.cb = null } } }
        return undefined
      },
      effect() {},
    }
    startFollowing(retryCtx)
    assert(getFollowedSessionId() === null, 'absent at attach → no follow yet')
    present = true
    if (timerTickHolder.cb !== null) timerTickHolder.cb()
    assert(getFollowedSessionId() === 'session-jjjj0000', `timer tick re-probes and subscribes the late source (got ${getFollowedSessionId()})`)
  }

  // ── 6. fiber cleanup：ctx.effect 的 disposer 退订两源 ──
  console.log('fiber cleanup via ctx.effect...')
  {
    resetFollowedForTest()
    const bs = makeBetterSidebar('session-kkkk1111')
    const se = makeSessions('session-llll2222')
    const { ctx, cleanups } = makeCtx({ betterSidebar: bs, sessions: se })
    startFollowing(ctx)
    assert(bs.state.subscribed && se.state.subscribed, 'both sources subscribed')
    assert(cleanups.length >= 1, 'cleanup registered through ctx.effect')
    for (const dispose of cleanups) dispose()
    assert(bs.state.unsubscribed && se.state.unsubscribed, 'disposer unsubscribes both sources')
  }

  // ── 7. subscribeFollowed 退订 ──
  console.log('listener unsubscribe...')
  {
    resetFollowedForTest()
    const se = makeSessions('session-mmmm3333')
    const { ctx } = makeCtx({ sessions: se })
    const seen = []
    startFollowing(ctx)
    const un = subscribeFollowed(() => seen.push(getFollowedSessionId()))
    un()
    se.state.snapshot = { current: 'session-nnnn4444' }
    se.publish()
    assert(seen.length === 0, 'unsubscribed listener no longer fires')
    assert(getFollowedSessionId() === 'session-nnnn4444', 'follow state itself still updates')
  }

  resetFollowedForTest()
  console.log(failures === 0 ? '\nALL FOLLOW CHECKS PASSED' : `\n${failures} CHECKS FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
