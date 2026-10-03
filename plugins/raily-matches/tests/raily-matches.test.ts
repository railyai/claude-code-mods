import { describe, expect, test } from 'claude-code/testing'

const ok = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false })

describe('raily-matches', () => {
  test('baseline is silent, a new match is shown', async ($, on) => {
    let matches = 1
    let deliveries = [{ delivery_id: 'a', display_name: 'Anna', city: 'Berlin', topic: 'AI', score: 0.8 }]
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('turn.complete', () => ({ text: '' }))
    on('mcp.call', (_$, e: any) => {
      if (e.tool === 'get_agent_state') return ok({ matches_count: matches, requests_count: 0, unread_conversations_count: 0, balance: 10 })
      if (e.tool === 'list_match_deliveries') return ok({ deliveries })
      if (e.tool === 'list_connection_requests') return ok({ requests: [], counters: { connected: 0 } })
      return ok({})
    })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    const ui = await $.ui.mount({
      plugin: 'raily-matches',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 }
    } as any)
    expect(await ui.find({ type: 'Text', text: /1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /New match/ })).toBeUndefined()

    matches = 2
    deliveries = [...deliveries, { delivery_id: 'b', display_name: 'Boris', city: 'Riga', topic: 'VC', score: 0.7 }]
    await $.clock.advance?.(120_000)
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
    expect(await ui.find({ type: 'Text', text: /Boris/ })).toBeDefined()
    await ui.unmount()
  })
})
