export type Snapshot = {
  matches: number
  requests: number
  connected: number
  unread: number
  balance: number | null
  isAsking: boolean
}

export type FeedItem = { id: string; icon: string; text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'raily-matches': {
      snapshot: Snapshot | null
      feed: FeedItem[]
      seen: string[]
      server: string
      lastPoll: number
      lastActivity: number
      failures: number
      retryAt: number
      isStopped: boolean
    }
  }
}
