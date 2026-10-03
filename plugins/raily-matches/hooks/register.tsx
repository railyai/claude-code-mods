import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { FeedItem, Snapshot } from '../types'

const TICK_MS = 120_000
const MIN_GAP_MS = 60_000
const IDLE_MS = 10 * 60_000
const MAX_BACKOFF_MS = 15 * 60_000
const FEED_SIZE = 20
const SERVERS = ['claude.ai Raily', 'claude_ai_Raily', 'Raily', 'raily']

const snapshot = atom({ plugin: 'raily-matches', key: 'snapshot' } as const, null as Snapshot | null)
const feed = atom({ plugin: 'raily-matches', key: 'feed' } as const, [] as FeedItem[])
const seen = atom({ plugin: 'raily-matches', key: 'seen' } as const, [] as string[])
const server = atom({ plugin: 'raily-matches', key: 'server' } as const, '')
const lastPoll = atom({ plugin: 'raily-matches', key: 'lastPoll' } as const, 0)
const lastActivity = atom({ plugin: 'raily-matches', key: 'lastActivity' } as const, 0)
const failures = atom({ plugin: 'raily-matches', key: 'failures' } as const, 0)
const retryAt = atom({ plugin: 'raily-matches', key: 'retryAt' } as const, 0)
const isStopped = atom({ plugin: 'raily-matches', key: 'isStopped' } as const, false)

function parse(result: any): any {
  if (!result || result.isError) return null
  if (result.structuredContent) return result.structuredContent
  const text = (result.content ?? []).find((b: any) => b.type === 'text')?.text
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function isAuthError(result: any): boolean {
  const text = (result?.content ?? []).map((b: any) => b.text ?? '').join(' ')
  return /auth|unauthori[sz]ed|401|forbidden|sign in|log ?in/i.test(text)
}

function label(d: any): string {
  const place = [d.city, d.topic].filter(Boolean).join(' · ')
  const score = typeof d.score === 'number' ? ` · ${Math.round(d.score * (d.score <= 1 ? 100 : 1))}%` : ''
  return `${d.display_name ?? 'Someone'}${place ? ' · ' + place : ''}${score}`
}

function diffDeliveries(list: any[], known: Set<string>): FeedItem[] {
  return list
    .filter(d => d.delivery_id && !known.has(`d:${d.delivery_id}`))
    .map(d => ({ id: `d:${d.delivery_id}`, icon: '◆', text: `New match: ${label(d)}`, at: 0 }))
}

function diffRequests(list: any[], known: Set<string>): FeedItem[] {
  return list
    .filter(r => r.pair_key && !known.has(`r:${r.pair_key}`))
    .map(r => ({
      id: `r:${r.pair_key}`,
      icon: '⇄',
      text: `Contact request${r.projection ? ': ' + String(r.projection).slice(0, 60) : ''}`,
      at: 0
    }))
}

function toSnapshot(s: any, connected: number): Snapshot {
  return {
    matches: s.matches_count ?? 0,
    requests: s.requests_count ?? 0,
    connected,
    unread: s.unread_conversations_count ?? 0,
    balance: typeof s.balance === 'number' ? s.balance : null,
    isAsking: Boolean(s.agent_question?.waiting)
  }
}

function changed(a: Snapshot | null, b: Snapshot): boolean {
  return !a || a.matches !== b.matches || a.requests !== b.requests || a.connected !== b.connected
}

function stateItems(prev: Snapshot | null, next: Snapshot): FeedItem[] {
  const items: FeedItem[] = []
  if (prev && next.isAsking && !prev.isAsking) {
    items.push({ id: `q:${next.matches}:${next.requests}`, icon: '?', text: 'Your agent is waiting for an answer', at: 0 })
  }
  if (prev && next.connected > prev.connected) {
    items.push({ id: `c:${next.connected}`, icon: '✓', text: `Mutual match (${next.connected} connected)`, at: 0 })
  }
  if (prev && next.unread > prev.unread) {
    items.push({ id: `u:${next.unread}`, icon: '✉', text: `${next.unread} unread conversation${next.unread === 1 ? '' : 's'}`, at: 0 })
  }
  return items
}

async function call($: any, name: string, tool: string): Promise<any> {
  try {
    return await $.mcp.call(name, tool, {})
  } catch {
    return null
  }
}

async function pickServer($: any): Promise<string> {
  const known = await read($, server)
  if (known) return known
  for (const name of SERVERS) {
    try {
      const result = await $.mcp.call(name, 'get_agent_state', {})
      if (result && !result.isError) {
        await update($, server, () => name)
        return name
      }
    } catch (err: any) {
      const text = String(err?.message ?? err)
      if (/classifier|refused/i.test(text)) {
        $.ui.status('Raily: the permission mode blocked the call; allow the read-only Raily tools (see README)')
      }
    }
  }
  return ''
}

async function fail($: any, now: number, reason: 'auth' | 'error', detail = '') {
  $.ui.status(`Raily: ${reason}${detail ? ' (' + detail + ')' : ''}`)
  if (reason === 'auth') {
    await update($, isStopped, () => true)
    $.ui.toast('Raily: not signed in. Reconnect the Raily MCP server, then restart the session.')
    return
  }
  const count = (await read($, failures)) + 1
  await update($, failures, () => count)
  await update($, retryAt, () => now + Math.min(TICK_MS * 2 ** count, MAX_BACKOFF_MS))
}

async function poll($: any, force: boolean) {
  const now = await $.clock.now()
  if (await read($, isStopped)) return
  if (!force && now < (await read($, retryAt))) return
  if (!force && now - (await read($, lastPoll)) < MIN_GAP_MS) return
  await update($, lastPoll, () => now)

  const name = await pickServer($)
  if (!name) return fail($, now, 'error', 'no MCP server found')

  const stateResult = await $.mcp.call(name, 'get_agent_state', {}).catch((err: any) => ({ isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] }))
  const state = parse(stateResult)
  if (!state) return fail($, now, isAuthError(stateResult) ? 'auth' : 'error', String(stateResult?.content?.[0]?.text ?? 'unreadable reply').slice(0, 60))

  const prev = await read($, snapshot)
  const requestsResult = await call($, name, 'list_connection_requests')
  const requests = parse(requestsResult)
  const connected = requests?.counters?.connected ?? prev?.connected ?? 0
  const next = toSnapshot(state, connected)

  const known = new Set(await read($, seen))
  let fresh: FeedItem[] = stateItems(prev, next)
  if (changed(prev, next) || force) {
    const deliveries = parse(await call($, name, 'list_match_deliveries'))?.deliveries ?? []
    fresh = [...diffDeliveries(deliveries, known), ...diffRequests(requests?.requests ?? [], known), ...fresh]
    for (const f of fresh) known.add(f.id)
    for (const d of deliveries) known.add(`d:${d.delivery_id}`)
    for (const r of requests?.requests ?? []) known.add(`r:${r.pair_key}`)
    await update($, seen, () => [...known].slice(-500))
  }

  await update($, failures, () => 0)
  await update($, snapshot, () => next)
  $.ui.status(undefined)

  // first poll of a session only records a baseline: nothing is announced
  if (!prev) return
  if (fresh.length === 0) return
  const stamped = fresh.map(f => ({ ...f, at: now }))
  await update($, feed, (old: FeedItem[]) => [...stamped, ...old].slice(0, FEED_SIZE))
  for (const f of stamped.slice(0, 3)) $.ui.toast(`${f.icon} ${f.text}`)
  if (stamped.length > 3) $.ui.toast(`Raily: +${stamped.length - 3} more events`)
}

async function safePoll($: any, force: boolean) {
  try {
    await poll($, force)
  } catch (err: any) {
    $.ui.status(`Raily: ${String(err?.message ?? err).slice(0, 80)}`)
  }
}

async function touch($: any) {
  const now = await $.clock.now()
  await update($, lastActivity, () => now)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await touch($)
    await update($, isStopped, () => false)
    await update($, failures, () => 0)
    await update($, retryAt, () => 0)
    await safePoll($, true)
    $.clock.every(TICK_MS, async () => {
      const now = await $.clock.now()
      if (now - (await read($, lastActivity)) > IDLE_MS) return
      await safePoll($, false)
    })
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    await touch($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await touch($)
      await safePoll($, false)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || !snap) return next(e)
    const below = await next(e)
    const items = await read($, feed)
    const { Box, Text } = $.ui.resolve(e)
    const latest = items[0]
    const wide = e.props.bodyColumns >= 70

    const band = (
      <Box flexDirection="row" paddingX={1}>
        <Text color="cyan" bold>{`◆ ${snap.matches}`}</Text>
        <Text dimColor>{' matches  '}</Text>
        <Text color={snap.requests > 0 ? 'yellow' : undefined} bold={snap.requests > 0}>{`⇄ ${snap.requests}`}</Text>
        <Text dimColor>{' requests'}</Text>
        {snap.unread > 0 && <Text color="green">{`  ✉ ${snap.unread}`}</Text>}
        {snap.isAsking && <Text color="magenta" bold>{'  ? agent waiting'}</Text>}
        {snap.balance !== null && <Text dimColor>{`  ¤ ${snap.balance}`}</Text>}
        {wide && latest && <Text dimColor>{`   ${latest.icon} ${latest.text}`.slice(0, 80)}</Text>}
      </Box>
    )

    // stack above whatever another mod (or the engine) draws in this band
    if (!below) return band
    return (
      <Box flexDirection="column">
        {band}
        {below}
      </Box>
    )
  })
}
