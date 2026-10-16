import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionLifecycle, selectSessionModel, resumeSession, currentSessionModel, releaseModelSelection } from '../dist/harness/adapters/sessions.js';

// ---------------------------------------------------------------------------
// #SL-1: convergence guarantees for the per-session model selection when the
// agent identity under a session id changes out-of-band.
//
// (a) A selection ref must never be REUSED across agent identities: a
//     replaced agent's stale entry is disposed/replaced and a switch lands
//     on the LIVE instance (the same-identity first-listener-wins reuse is
//     asserted too).
// (b) A switch racing a resume converges to EXACTLY ONE final selection on
//     the POST-resume agent in both interleavings — no lost update when the
//     switch completes before the resume runs, no double listener when the
//     resume reinstates before the switch lands — and closing/deleting the
//     session wipes the remembered switch so a reused id starts clean.
//
// All fakes are plain objects: no real harness, no network. installModel-
// Selection comes from dist, driven through agent-scoped context doubles.
// ---------------------------------------------------------------------------

/** Agent-scoped cordis double that records every installModelSelection
 * listener registration (2 per install) with its name, plus disposals. */
function makeSpyCtx() {
  const spy = { listeners: [], disposedCount: 0 };
  spy.ctx = {
    on: (name, fn) => {
      spy.listeners.push({ name, fn });
      return () => { spy.disposedCount += 1; };
    },
  };
  spy.installed = () => spy.listeners.length;
  spy.disposed = () => spy.disposedCount;
  return spy;
}

function agentWith(spy, options) {
  return { id: options.id, status: 'idle', options, ctx: spy.ctx };
}

/** Drive the assembly listener the way prompt assembly would: whatever the
 * LIVE ref holds shows up in the returned variables (or the inherited
 * default passes through untouched when nothing was selected). */
async function assembledVariables(spy) {
  const asm = spy.listeners.find((entry) => entry.name === 'system-prompt/assemble');
  assert.ok(asm, 'the selection ref installed an assembly listener');
  return await asm.fn(undefined, spy.ctx, async () => ({ variables: { provider: 'inherit-p', model: 'inherit-m' } }));
}

function llmIdentity() {
  return { resolveCallConfig: async (config) => config };
}

test('a selection ref is never reused across agent identities under one session id (#SL-1)', async () => {
  const id = 'conv-identity';
  try {
    const aSpy = makeSpyCtx();
    const live = new Map([[id, agentWith(aSpy, { id, provider: 'p0', model: 'm0' })]]);
    const ctx = {
      agents: { list: () => [...live.values()], get: (key) => live.get(String(key)) },
      get: (name) => (name === 'llm' ? llmIdentity() : undefined),
    };

    assert.equal((await selectSessionModel(ctx, id, 'p1', 'm1')).ok, true);
    assert.equal(aSpy.installed(), 2, 'one ref (assembly + request) pins identity A');

    // Identity swap WITHOUT any tracked destroy path (multi-agent registry
    // reuse / external dispose): same session id, brand-new agent instance.
    const bSpy = makeSpyCtx();
    live.set(id, agentWith(bSpy, { id, provider: 'p0', model: 'm0' }));

    assert.equal((await selectSessionModel(ctx, id, 'p2', 'm2')).ok, true);
    assert.equal(aSpy.disposed(), aSpy.installed(), 'the stale identity-A listeners are disposed, not reused');
    assert.equal(bSpy.installed(), 2, 'the switch installs fresh on identity B');
    assert.equal(bSpy.disposed(), 0);
    assert.equal(currentSessionModel(ctx, id).model, 'm2', 'the switch lands on the live agent');

    // Same-identity taps keep first-installed-wins: no re-install churn.
    assert.equal((await selectSessionModel(ctx, id, 'p3', 'm3')).ok, true);
    assert.equal(bSpy.installed(), 2, 'the same identity reuses the existing entry');
    assert.equal(currentSessionModel(ctx, id).model, 'm3');
  } finally {
    releaseModelSelection(id);
  }
});

test('a completed switch survives a later resume of the same session id (#SL-1 defect 2)', async () => {
  const id = 'conv-before-resume';
  try {
    const aSpy = makeSpyCtx();
    const live = new Map([[id, agentWith(aSpy, { id, provider: 'p0', model: 'm0' })]]);
    let resumed;
    const ctx = {
      agents: {
        list: () => [...live.values()],
        get: (key) => live.get(String(key)),
        // Host-style resume: NEW agent object + scoped context, SAME id,
        // inheriting the previous agent's provider/model.
        resume: async (options) => {
          const bSpy = makeSpyCtx();
          const agent = agentWith(bSpy, { id: String(options.resumeSessionId), provider: options.agentOptions?.provider, model: options.agentOptions?.model });
          live.set(agent.id, agent);
          resumed = { agent, spy: bSpy, dispose: async () => {} };
          return resumed;
        },
      },
      get: (name) => (name === 'llm' ? llmIdentity() : undefined),
    };

    assert.equal((await selectSessionModel(ctx, id, 'p1', 'm1')).ok, true, 'switch fully applies before the resume starts');

    const res = await resumeSession(ctx, id);
    assert.equal(res.ok, true, res.text);

    assert.equal(resumed.spy.installed(), 2, 'exactly one selection ref lands on the resumed agent');
    const vars = await assembledVariables(resumed.spy);
    assert.equal(vars.variables.model, 'm1', 'no lost update: the pre-resume switch is re-asserted on the post-resume agent');
    assert.equal(aSpy.disposed(), aSpy.installed(), 'nothing of the orphaned pre-resume ref survives');
    assert.equal(currentSessionModel(ctx, id).model, 'm1');

    // The usual dispatch flow adopts the resumed handle right after: that
    // must reuse the reinstated entry instead of stacking a second ref.
    new SessionLifecycle().adopt(res.handle);
    assert.equal(resumed.spy.installed(), 2, 'adopt() after resume adds no double listener');
  } finally {
    releaseModelSelection(id);
  }
});

test('a switch landing during a resume window converges onto the post-resume agent exactly once (#SL-1 defect 2)', async () => {
  const id = 'conv-during-resume';
  try {
    const aSpy = makeSpyCtx();
    const live = new Map([[id, agentWith(aSpy, { id, provider: 'p0', model: 'm0' })]]);
    let releaseResume;
    const resumeGate = new Promise((resolve) => { releaseResume = resolve; });
    let resumed;
    const ctx = {
      agents: {
        list: () => [...live.values()],
        get: (key) => live.get(String(key)),
        resume: async (options) => {
          await resumeGate; // paused between the entry release and the publish
          const bSpy = makeSpyCtx();
          const agent = agentWith(bSpy, { id: String(options.resumeSessionId), provider: options.agentOptions?.provider, model: options.agentOptions?.model });
          live.set(agent.id, agent);
          resumed = { agent, spy: bSpy, dispose: async () => {} };
          return resumed;
        },
      },
      get: (name) => (name === 'llm' ? llmIdentity() : undefined),
    };

    const resuming = resumeSession(ctx, id);
    // The tap runs to completion while the resume is suspended mid-swap: the
    // registry still exposes the pre-resume agent, so the value lands on a
    // ref that the resume is about to release.
    assert.equal((await selectSessionModel(ctx, id, 'late-p', 'late-m')).ok, true);
    releaseResume();
    assert.equal((await resuming).ok, true);

    assert.equal(resumed.spy.installed(), 2, 'exactly ONE ref ends up on the post-resume agent — no double listener');
    const vars = await assembledVariables(resumed.spy);
    assert.equal(vars.variables.model, 'late-m', 'the mid-window switch converges onto the post-resume agent');
    assert.equal(aSpy.disposed(), aSpy.installed(), 'every orphaned listener pair (initial + mid-window) is reclaimed');
    assert.equal(currentSessionModel(ctx, id).model, 'late-m');
  } finally {
    releaseModelSelection(id);
  }
});

test('close/delete forgets the remembered switch — a later resume of the id starts clean (#SL-1 trunk)', async () => {
  const id = 'conv-forget';
  try {
    const aSpy = makeSpyCtx();
    const live = new Map([[id, agentWith(aSpy, { id, provider: 'p0', model: 'm0' })]]);
    const ctx = {
      agents: {
        list: () => [...live.values()],
        get: (key) => live.get(String(key)),
        resume: async (options) => {
          const bSpy = makeSpyCtx();
          const agent = agentWith(bSpy, { id: String(options.resumeSessionId), provider: options.agentOptions?.provider, model: options.agentOptions?.model });
          live.set(agent.id, agent);
          return { agent, dispose: async () => {} };
        },
      },
      get: (name) => (name === 'llm' ? llmIdentity() : undefined),
    };
    assert.equal((await selectSessionModel(ctx, id, 'p1', 'm1')).ok, true);

    live.delete(id); // agent gone (delete/external dispose)
    // Untracked close still funnels through the destruction trunk: the
    // selection entry AND the remembered switch must both be wiped, so the
    // result text is irrelevant here.
    await new SessionLifecycle().close(id);

    // Recreate/resume under the SAME id with a DIFFERENT inherited model.
    let resumedSpy;
    const resumeWithInheritance = {
      agents: {
        list: () => [...live.values()],
        get: (key) => live.get(String(key)),
        resume: async (options) => {
          const spy = makeSpyCtx();
          const agent = agentWith(spy, { id: String(options.resumeSessionId), provider: 'inh-p', model: 'inh-m' });
          live.set(agent.id, agent);
          resumedSpy = spy;
          return { agent, dispose: async () => {} };
        },
      },
      get: ctx.get,
    };
    const res = await resumeSession(resumeWithInheritance, id);
    assert.equal(res.ok, true, res.text);

    assert.equal(resumedSpy.installed(), 2, 'our outermost ref still pins the recreated agent');
    const vars = await assembledVariables(resumedSpy);
    // 'inherit-m' is assembledVariables' passthrough sentinel: it proves
    // ref.current is undefined, i.e. nothing was re-asserted.
    assert.equal(vars.variables.model, 'inherit-m', 'the dead session\'s switch does NOT resurrect — nothing is re-asserted');
    assert.equal(currentSessionModel(resumeWithInheritance, id).model, 'inh-m', 'the inherited agent default serves instead');
  } finally {
    releaseModelSelection(id);
  }
});
