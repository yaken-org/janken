import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import OpenAI from 'openai'
import { useEffect, useRef, useState } from 'react'

type Hand = 'グー' | 'チョキ' | 'パー'
type GameResult = {
  aiHand: Hand
  result: '勝ち' | '負け' | 'あいこ'
  reasoning: string
  comment: string
}

const HANDS: Array<{ hand: Hand; emoji: string }> = [
  { hand: 'グー', emoji: '✊' },
  { hand: 'チョキ', emoji: '✌️' },
  { hand: 'パー', emoji: '🖐️' },
]

// AIの思考量（reasoningの予算＋考え方の指示）
type ThinkLevel = 'low' | 'middle' | 'think' | 'superthink' | 'ultrathink'
const THINK_LEVELS: Array<{
  level: ThinkLevel
  label: string
  emoji: string
  maxTokens: number
  instruction: string
}> = [
  {
    level: 'low',
    label: 'low',
    emoji: '💤',
    maxTokens: 512,
    instruction: '深く考えず、直感でさっと1手決めてください。',
  },
  {
    level: 'middle',
    label: 'middle',
    emoji: '🙂',
    maxTokens: 1024,
    instruction: '軽く考えて1手決めてください。',
  },
  {
    level: 'think',
    label: 'think',
    emoji: '🤔',
    maxTokens: 2048,
    instruction: '相手の傾向をふまえて考えてから決めてください。',
  },
  {
    level: 'superthink',
    label: 'superthink',
    emoji: '🧠',
    maxTokens: 4096,
    instruction: '相手の傾向を深く分析し、慎重に選んでください。',
  },
  {
    level: 'ultrathink',
    label: 'ultrathink',
    emoji: '🔮',
    maxTokens: 8192,
    instruction:
      'あらゆる可能性と相手の傾向を徹底的に分析し尽くしてから、最善の1手を選んでください。',
  },
]

const THINK_MAP = Object.fromEntries(
  THINK_LEVELS.map((t) => [t.level, t]),
) as Record<ThinkLevel, (typeof THINK_LEVELS)[number]>

function judge(player: Hand, ai: Hand): '勝ち' | '負け' | 'あいこ' {
  if (player === ai) return 'あいこ'
  if (
    (player === 'グー' && ai === 'チョキ') ||
    (player === 'チョキ' && ai === 'パー') ||
    (player === 'パー' && ai === 'グー')
  )
    return '勝ち'
  return '負け'
}

type PlayInput = {
  hand: Hand
  history: Hand[]
  memory: string
  think: ThinkLevel
}

// クライアントに1行ずつ流すストリームイベント（NDJSON）
type StreamEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string }
  // 結果はコメントより先に確定・送信する（切断されても結果は残る）
  | {
      type: 'done'
      aiHand: Hand
      result: GameResult['result']
      reasoning: string
    }
  // コメントは結果のあとに後追いで届く
  | { type: 'comment'; text: string }
  | { type: 'error'; message: string }
  // 無音区間でモバイル回線に切断されないための接続維持用
  | { type: 'ping' }

// テキストから最後に出現した手を採用する（推論の途中に別の手が混ざるため）
function pickHand(text: string): Hand | null {
  const lastIndex = (hand: Hand) => text.lastIndexOf(hand)
  const candidates = HANDS.map((h) => h.hand).filter((h) => lastIndex(h) >= 0)
  if (candidates.length === 0) return null
  return candidates.sort((a, b) => lastIndex(b) - lastIndex(a))[0]
}

// 対戦結果を受けて、AIキャラクターの短いひとことコメントを生成する
async function generateComment(
  client: OpenAI,
  playerHand: Hand,
  aiHand: Hand,
  result: GameResult['result'],
): Promise<string> {
  const outcome =
    result === '勝ち'
      ? 'あなた（AI）の負け'
      : result === '負け'
        ? 'あなた（AI）の勝ち'
        : 'あいこ（引き分け）'
  const res = await client.chat.completions.create({
    model: 'nvidia/Qwen3.6-35B-A3B-NVFP4',
    messages: [
      {
        role: 'system',
        content:
          'あなたはじゃんけんAIのキャラクターです。対戦結果を受けて、相手プレイヤーに向けた短いひとことコメント（30文字以内・日本語・絵文字は1つまで）だけを返してください。説明や思考は書かないこと。',
      },
      {
        role: 'user',
        content: `あなたの手「${aiHand}」、相手の手「${playerHand}」、結果は${outcome}。ひとことどうぞ。`,
      },
    ],
    max_tokens: 2048,
  })
  const msg = res.choices[0]?.message as
    | { content?: string; reasoning?: string }
    | undefined
  const raw = (msg?.content ?? '').trim()
  // content優先。無ければreasoningの最終行から一文を拾う
  const text =
    raw || (msg?.reasoning ?? '').trim().split('\n').filter(Boolean).pop() || ''
  const comment = text.replace(/^["「『]|["」』]$/g, '').slice(0, 60)
  if (!comment) {
    throw new Error(`AIのコメントを取得できませんでした: ${JSON.stringify(msg)}`)
  }
  return comment
}

const playJanken = createServerFn({ method: 'POST' })
  .validator((input: PlayInput) => input)
  .handler(async ({ data: { hand: playerHand, history, memory, think } }): Promise<Response> => {
    const { CF_ACCOUNT_ID, CF_GATEWAY_ID } = env as Env & { OPENAI_API_KEY: string }
    const apiKey = (env as Env & { OPENAI_API_KEY: string }).OPENAI_API_KEY
    // 選ばれた思考量（未知の値でも think にフォールバック）
    const thinkConf = THINK_MAP[think] ?? THINK_MAP.think

    const client = new OpenAI({
      apiKey,
      baseURL: `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_ID}/custom-spark-cccd`,
      defaultHeaders: { 'cf-aig-skip-cache': 'true' },
    })

    // 直近の履歴を最大20件渡す（history が無い/不正でも落ちないようガード）
    const recent = Array.isArray(history) ? history.slice(-20) : []
    const historyText =
      recent.length > 0
        ? `これまでに相手（人間）が出した手の履歴（古い順）: ${recent.join('、')}。`
        : 'まだ対戦履歴はありません。'
    // これまでに蓄積した相手の傾向メモ（localStorage由来）
    const memoryText =
      memory && memory.trim()
        ? `過去の対戦から分かっている相手の傾向メモ: ${memory}`
        : ''

    const stream = await client.chat.completions.create({
      model: 'nvidia/Qwen3.6-35B-A3B-NVFP4',
      messages: [
        {
          role: 'system',
          content:
            'あなたはじゃんけんの対戦相手です。相手の過去の手の傾向やメモを分析し、相手が次に出しそうな手に勝てる手を選びます。最後の行に「グー」「チョキ」「パー」のいずれか1語だけを出力してください。',
        },
        {
          role: 'user',
          content: `${historyText}\n${memoryText}\n${thinkConf.instruction}\nあなたの手を1つ選んでください。`,
        },
      ],
      max_tokens: thinkConf.maxTokens,
      stream: true,
    })

    const encoder = new TextEncoder()
    const send = (
      controller: ReadableStreamDefaultController,
      event: StreamEvent,
    ) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))

    const body = new ReadableStream({
      async start(controller) {
        const ping = () => {
          try {
            send(controller, { type: 'ping' })
          } catch {
            /* controllerが閉じていたら無視 */
          }
        }
        // 最初のバイトを即送ってストリームを確立する
        ping()

        let reasoning = ''
        let content = ''
        try {
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta as
              | { content?: string; reasoning?: string; reasoning_content?: string }
              | undefined
            const r = delta?.reasoning ?? delta?.reasoning_content
            if (r) {
              reasoning += r
              send(controller, { type: 'reasoning', delta: r })
            }
            if (delta?.content) {
              content += delta.content
              send(controller, { type: 'content', delta: delta.content })
            }
          }

          const aiHand = pickHand(`${content} ${reasoning}`.trim())
          if (!aiHand) {
            send(controller, {
              type: 'error',
              message: `AIの返答から手を判定できませんでした: ${(content || reasoning).slice(-120)}`,
            })
          } else {
            const result = judge(playerHand, aiHand)
            // 先に結果を確定・送信する（このあと切断されても結果は残る）
            send(controller, {
              type: 'done',
              aiHand,
              result,
              reasoning: reasoning || content,
            })
            // 結果送信後にコメントを生成して後追いで送る。
            // 生成中は無音になるので定期pingで接続を維持する
            const heartbeat = setInterval(ping, 4000)
            try {
              const comment = await generateComment(
                client,
                playerHand,
                aiHand,
                result,
              )
              send(controller, { type: 'comment', text: comment })
            } catch {
              /* コメントは任意。取得失敗時は送らない（結果は保持） */
            } finally {
              clearInterval(heartbeat)
            }
          }
        } catch (e) {
          send(controller, {
            type: 'error',
            message: e instanceof Error ? e.message : String(e),
          })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(body, {
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
    })
  })

// ===== 連勝ランキング（KV, 匿名・最大100件） =====
type RankRecord = { id: string; name: string; streak: number; at: number }
const RANKING_KEY = 'leaderboard'
const RANKING_MAX = 100

async function readRanking(kv: KVNamespace): Promise<RankRecord[]> {
  const raw = await kv.get(RANKING_KEY)
  if (!raw) return []
  try {
    const list = JSON.parse(raw)
    return Array.isArray(list) ? (list as RankRecord[]) : []
  } catch {
    return []
  }
}

const getRanking = createServerFn({ method: 'GET' }).handler(
  async (): Promise<RankRecord[]> => {
    return readRanking((env as Env).RANKING)
  },
)

const submitStreak = createServerFn({ method: 'POST' })
  .validator((input: { id: string; name: string; streak: number }) => input)
  .handler(async ({ data }): Promise<RankRecord[]> => {
    const kv = (env as Env).RANKING
    // 入力を軽くサニタイズ（匿名なので厳密な認証はしない）
    const id = String(data.id).slice(0, 64)
    const name = (String(data.name).trim() || '匿名').slice(0, 20)
    const streak = Math.max(0, Math.min(9999, Math.floor(Number(data.streak) || 0)))
    if (!id || streak <= 0) return readRanking(kv)

    let list = await readRanking(kv)
    const existing = list.find((r) => r.id === id)
    if (existing) {
      // 自己ベストを更新するときだけ書き換える
      if (streak > existing.streak) {
        existing.streak = streak
        existing.name = name
        existing.at = Date.now()
      }
    } else {
      list.push({ id, name, streak, at: Date.now() })
    }
    // 連勝数の降順、同数なら達成が早い順
    list.sort((a, b) => b.streak - a.streak || a.at - b.at)
    list = list.slice(0, RANKING_MAX)
    await kv.put(RANKING_KEY, JSON.stringify(list))
    return list
  })

export const Route = createFileRoute('/')({ component: App })

const HISTORY_KEY = 'janken-history'
const STREAK_KEY = 'janken-streak'
const MEMORY_KEY = 'janken-memory'

function loadHistory(): Hand[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((h): h is Hand =>
      HANDS.some((x) => x.hand === h),
    )
  } catch {
    return []
  }
}

function saveHistory(history: Hand[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  } catch {
    /* ignore */
  }
}

// 連続記録: 正の数=連勝, 負の数=連敗, 0=記録なし
function loadStreak(): number {
  if (typeof window === 'undefined') return 0
  const n = Number(window.localStorage.getItem(STREAK_KEY))
  return Number.isFinite(n) ? n : 0
}

function saveStreak(streak: number) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STREAK_KEY, String(streak))
  } catch {
    /* ignore */
  }
}

// 結果を受けて連勝/連敗を更新する（あいこは維持）
function nextStreak(prev: number, result: GameResult['result']): number {
  if (result === '勝ち') return prev > 0 ? prev + 1 : 1
  if (result === '負け') return prev < 0 ? prev - 1 : -1
  return prev
}

// 連続記録を人間向けの文言にする
function streakLabel(streak: number): string {
  if (streak > 0) return `${streak}連勝中`
  if (streak < 0) return `${-streak}連敗中`
  return '記録なし'
}

// ランキング上位のメダル
function medal(index: number): string {
  return ['🥇', '🥈', '🥉'][index] ?? ''
}

// 履歴から相手の傾向を分析して、AIに渡す/localStorageに残す「メモリ」を作る
function analyzeTendencies(history: Hand[]): string {
  if (history.length < 3) return ''
  const hands = HANDS.map((h) => h.hand)
  const count = (arr: Hand[]) => {
    const c: Record<Hand, number> = { グー: 0, チョキ: 0, パー: 0 }
    for (const h of arr) c[h]++
    return c
  }

  const total = history.length
  const counts = count(history)
  const pct = (n: number) => Math.round((n / total) * 100)
  const freqText = [...hands]
    .sort((a, b) => counts[b] - counts[a])
    .map((h) => `${h}${pct(counts[h])}%`)
    .join('・')

  // 直近5手の偏り
  const recentCounts = count(history.slice(-5))
  const recentTop = [...hands].sort((a, b) => recentCounts[b] - recentCounts[a])[0]

  // 直前の手の「次に出しがちな手」（簡易マルコフ）
  const last = history[history.length - 1]
  const nextCounts: Record<Hand, number> = { グー: 0, チョキ: 0, パー: 0 }
  for (let i = 0; i < history.length - 1; i++) {
    if (history[i] === last) nextCounts[history[i + 1]]++
  }
  const nextTotal = nextCounts.グー + nextCounts.チョキ + nextCounts.パー
  const transText =
    nextTotal > 0
      ? `「${last}」の次は「${[...hands].sort((a, b) => nextCounts[b] - nextCounts[a])[0]}」を出しやすい。`
      : ''

  // 同じ手の連続
  let repeat = 1
  for (let i = history.length - 1; i > 0 && history[i] === history[i - 1]; i--)
    repeat++
  const repeatText = repeat >= 3 ? `直近は「${last}」を${repeat}連続。` : ''

  return `全体傾向 ${freqText}。直近は「${recentTop}」寄り。${transText}${repeatText}`.trim()
}

function loadMemory(): string {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(MEMORY_KEY) ?? ''
}

function saveMemory(memory: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(MEMORY_KEY, memory)
  } catch {
    /* ignore */
  }
}

// 匿名の識別子と表示名（localStorage、端末ごとに1つ）
const UID_KEY = 'janken-uid'
const NAME_KEY = 'janken-name'

function getAnonId(): string {
  if (typeof window === 'undefined') return ''
  let id = window.localStorage.getItem(UID_KEY)
  if (!id) {
    id = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)
    window.localStorage.setItem(UID_KEY, id)
  }
  return id
}

function getAnonName(): string {
  if (typeof window === 'undefined') return '匿名'
  let name = window.localStorage.getItem(NAME_KEY)
  if (!name) {
    name = `匿名${Math.random().toString(36).slice(2, 6)}`
    window.localStorage.setItem(NAME_KEY, name)
  }
  return name
}

// 選んだ思考量（localStorage）
const THINK_KEY = 'janken-think'

function loadThink(): ThinkLevel {
  if (typeof window === 'undefined') return 'think'
  const v = window.localStorage.getItem(THINK_KEY)
  return THINK_LEVELS.some((t) => t.level === v) ? (v as ThinkLevel) : 'think'
}

function saveThink(level: ThinkLevel) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THINK_KEY, level)
  } catch {
    /* ignore */
  }
}

function App() {
  const [playerHand, setPlayerHand] = useState<Hand | null>(null)
  const [gameResult, setGameResult] = useState<GameResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<Hand[]>([])
  const [streak, setStreak] = useState(0)
  const [memory, setMemory] = useState('')
  const [liveReasoning, setLiveReasoning] = useState('')
  const [ranking, setRanking] = useState<RankRecord[]>([])
  const [myId, setMyId] = useState('')
  const [think, setThink] = useState<ThinkLevel>('think')
  const reasoningBoxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setHistory(loadHistory())
    setStreak(loadStreak())
    setMemory(loadMemory())
    setMyId(getAnonId())
    setThink(loadThink())
    getRanking()
      .then(setRanking)
      .catch(() => {})
  }, [])

  const changeThink = (level: ThinkLevel) => {
    setThink(level)
    saveThink(level)
  }

  // 思考過程が更新されるたびに一番下へ自動追尾
  useEffect(() => {
    const box = reasoningBoxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [liveReasoning])

  const handlePlay = async (hand: Hand) => {
    setPlayerHand(hand)
    setGameResult(null)
    setError(null)
    setLiveReasoning('')
    setIsLoading(true)

    // 出した手を履歴に記録
    const nextHistory = [...history, hand]
    setHistory(nextHistory)
    saveHistory(nextHistory)

    try {
      // AIには今回の手を含める前の履歴・傾向メモ・思考量を渡す
      const res = await playJanken({ data: { hand, history, memory, think } })
      const bodyStream = (res as Response).body
      if (!bodyStream) throw new Error('ストリームを取得できませんでした')

      const reader = bodyStream.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let reasoning = ''
      let gotDone = false
      let streamError: string | null = null

      // イベントが届くたびに即反映（結果は来た時点で確定させる）
      const handleEvent = (evt: StreamEvent) => {
        if (evt.type === 'reasoning') {
          reasoning += evt.delta
          setLiveReasoning(reasoning)
        } else if (evt.type === 'done') {
          gotDone = true
          // 結果を先に表示する（このあとコメントが後追いで届く）
          setGameResult({
            aiHand: evt.aiHand,
            result: evt.result,
            reasoning: evt.reasoning,
            comment: '',
          })
          setIsLoading(false)
          const updated = nextStreak(streak, evt.result)
          setStreak(updated)
          saveStreak(updated)
          const newMemory = analyzeTendencies(nextHistory)
          setMemory(newMemory)
          saveMemory(newMemory)
          // 連勝中ならランキングに自己ベストを登録（匿名）
          if (updated > 0) {
            submitStreak({
              data: { id: getAnonId(), name: getAnonName(), streak: updated },
            })
              .then(setRanking)
              .catch(() => {})
          }
        } else if (evt.type === 'comment') {
          setGameResult((prev) => (prev ? { ...prev, comment: evt.text } : prev))
        } else if (evt.type === 'error') {
          streamError = evt.message
        }
      }

      // NDJSON を1行ずつパースしながらリアルタイムに反映
      for (;;) {
        const { done: readerDone, value } = await reader.read()
        if (readerDone) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          handleEvent(JSON.parse(line) as StreamEvent)
        }
      }

      if (streamError) throw new Error(streamError)
      if (!gotDone) throw new Error('結果を受信できませんでした')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPlayerHand(null)
    } finally {
      setIsLoading(false)
    }
  }

  const shareToX = () => {
    const headline =
      streak > 0
        ? `AIとのじゃんけんで${streak}連勝中！🎉`
        : streak < 0
          ? `AIとのじゃんけんで${-streak}連敗中…😞`
          : 'AIとじゃんけんで対戦したよ🤝'
    const text = `${headline}\n#じゃんけん #AI対戦`
    const url = new URL('https://twitter.com/intent/tweet')
    url.searchParams.set('text', text)
    // 独自ドメイン等に対応するため、現在アクセス中のURLを使う
    url.searchParams.set('url', window.location.origin)
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
  }

  const handleReset = () => {
    setPlayerHand(null)
    setGameResult(null)
    setError(null)
  }

  const clearHistory = () => {
    setHistory([])
    saveHistory([])
    setMemory('')
    saveMemory('')
    handleReset()
  }

  const myRankIndex = ranking.findIndex((r) => r.id === myId)
  const myRank = myRankIndex >= 0 ? myRankIndex + 1 : null
  const myBest = myRankIndex >= 0 ? ranking[myRankIndex].streak : 0

  const resultEmoji =
    gameResult?.result === '勝ち'
      ? '🎉'
      : gameResult?.result === '負け'
        ? '😞'
        : '🤝'

  return (
    <main className="page-wrap flex min-h-screen items-center justify-center px-4 py-10">
      <div className="island-shell rise-in w-full max-w-sm rounded-[2rem] px-6 py-10 text-center">
        <p className="island-kicker mb-3">AI対戦</p>
        <h1 className="display-title mb-8 text-4xl font-bold text-[var(--sea-ink)]">
          じゃんけん
        </h1>

        {!playerHand && !isLoading && (
          <>
            {streak !== 0 && (
              <p
                className={`mb-4 text-base font-bold ${
                  streak > 0 ? 'text-[var(--palm)]' : 'text-[#9f3030]'
                }`}
              >
                {streak > 0 ? '🔥' : '💧'} {streakLabel(streak)}
              </p>
            )}
            <div className="mb-6">
              <p className="mb-2 text-xs font-semibold text-[var(--sea-ink-soft)]">
                AIの思考量
              </p>
              <div className="flex flex-wrap justify-center gap-1.5">
                {THINK_LEVELS.map((t) => (
                  <button
                    key={t.level}
                    onClick={() => changeThink(t.level)}
                    aria-pressed={think === t.level}
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                      think === t.level
                        ? 'border-[var(--lagoon-deep)] bg-[rgba(79,184,178,0.22)] text-[var(--sea-ink)]'
                        : 'border-[var(--line)] bg-[var(--chip-bg)] text-[var(--sea-ink-soft)]'
                    }`}
                  >
                    {t.emoji} {t.label}
                  </button>
                ))}
              </div>
            </div>

            <p className="mb-6 text-[var(--sea-ink-soft)]">手を選んでください</p>
            <div className="flex justify-center gap-3">
              {HANDS.map(({ hand, emoji }) => (
                <button
                  key={hand}
                  onClick={() => handlePlay(hand)}
                  className="demo-button flex-col gap-1 px-5 py-4"
                >
                  <span className="text-3xl">{emoji}</span>
                  <span className="text-xs">{hand}</span>
                </button>
              ))}
            </div>

            {history.length > 0 && (
              <div className="mt-8">
                <p className="mb-2 text-xs text-[var(--sea-ink-soft)]">
                  あなたの手の履歴（{history.length}回）— ローカルに保存されています
                </p>
                <p className="mb-3 text-lg tracking-wide">
                  {history
                    .slice(-15)
                    .map((h) => HANDS.find((x) => x.hand === h)?.emoji)
                    .join(' ')}
                </p>
                {memory && (
                  <div className="demo-code-block mb-3 text-left">
                    <p className="mb-1 text-xs font-semibold text-[var(--sea-ink-soft)]">
                      🧠 AIが覚えているあなたの傾向
                    </p>
                    <p className="text-xs leading-relaxed text-[var(--sea-ink-soft)]">
                      {memory}
                    </p>
                  </div>
                )}
                <button
                  onClick={clearHistory}
                  className="demo-button demo-button-secondary text-xs"
                >
                  履歴をクリア
                </button>
              </div>
            )}

            {ranking.length > 0 && (
              <div className="mt-8 text-left">
                <p className="mb-2 text-center text-xs font-semibold text-[var(--sea-ink-soft)]">
                  🏆 連勝ランキング（匿名・上位{Math.min(ranking.length, 10)}位）
                </p>
                <ol className="space-y-1">
                  {ranking.slice(0, 10).map((r, i) => (
                    <li
                      key={r.id}
                      className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm ${
                        r.id === myId
                          ? 'bg-[rgba(79,184,178,0.18)] font-semibold'
                          : 'bg-[var(--chip-bg)]'
                      }`}
                    >
                      <span className="flex items-center gap-2 truncate">
                        <span className="w-5 shrink-0 text-right text-[var(--sea-ink-soft)]">
                          {i + 1}
                        </span>
                        <span className="truncate">
                          {medal(i)} {r.name}
                          {r.id === myId ? '（あなた）' : ''}
                        </span>
                      </span>
                      <span className="shrink-0 font-bold text-[var(--palm)]">
                        {r.streak}連勝
                      </span>
                    </li>
                  ))}
                </ol>
                {myRank && myRank > 10 && (
                  <p className="mt-2 text-center text-xs text-[var(--sea-ink-soft)]">
                    あなたの順位: {myRank}位（{myBest}連勝）
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {isLoading && (
          <div className="py-4">
            <p className="mb-3 text-4xl">🤔</p>
            <p className="mb-4 text-[var(--sea-ink-soft)]">AIが考えています…</p>
            {liveReasoning && (
              <div
                ref={reasoningBoxRef}
                className="demo-code-block max-h-56 overflow-y-auto text-left"
              >
                <p className="mb-2 text-xs font-semibold text-[var(--sea-ink-soft)]">
                  🧠 思考中…
                </p>
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--sea-ink-soft)]">
                  {liveReasoning}
                  <span className="ml-0.5 inline-block animate-pulse">▋</span>
                </p>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="demo-alert demo-alert-danger py-6 text-center">
            <p className="mb-2 text-5xl">🏃💨</p>
            <p className="mb-1 text-lg font-bold">AIが逃亡しました</p>
            <p className="mb-4 text-xs text-[var(--sea-ink-soft)]">
              うまく手を決められなかったようです
            </p>
            <details className="mb-4 text-left">
              <summary className="cursor-pointer text-xs text-[var(--sea-ink-soft)]">
                詳細
              </summary>
              <p className="mt-2 break-all font-mono text-xs opacity-70">
                {error}
              </p>
            </details>
            <button
              onClick={handleReset}
              className="demo-button demo-button-secondary text-sm"
            >
              もう一度
            </button>
          </div>
        )}

        {!isLoading && gameResult && playerHand && (
          <div>
            <div className="mb-6 flex items-center justify-center gap-6">
              <div className="text-center">
                <p className="mb-1 text-xs text-[var(--sea-ink-soft)]">あなた</p>
                <p className="text-5xl">
                  {HANDS.find((h) => h.hand === playerHand)?.emoji}
                </p>
                <p className="mt-1 text-sm font-semibold">{playerHand}</p>
              </div>
              <span className="text-xl text-[var(--sea-ink-soft)]">vs</span>
              <div className="text-center">
                <p className="mb-1 text-xs text-[var(--sea-ink-soft)]">AI</p>
                <p className="text-5xl">
                  {HANDS.find((h) => h.hand === gameResult.aiHand)?.emoji}
                </p>
                <p className="mt-1 text-sm font-semibold">{gameResult.aiHand}</p>
              </div>
            </div>

            <div
              className={`mb-6 rounded-xl px-6 py-3 text-xl font-bold ${
                gameResult.result === '勝ち'
                  ? 'bg-[rgba(47,106,74,0.12)] text-[var(--palm)]'
                  : gameResult.result === '負け'
                    ? 'bg-[rgba(196,71,71,0.1)] text-[#9f3030]'
                    : 'bg-[rgba(23,58,64,0.08)] text-[var(--sea-ink-soft)]'
              }`}
            >
              {resultEmoji} {gameResult.result}
            </div>

            {gameResult.comment && (
              <div className="demo-list-item mb-6 flex items-start gap-2 text-left">
                <span className="text-xl leading-none">🤖</span>
                <p className="text-sm leading-relaxed text-[var(--sea-ink)]">
                  {gameResult.comment}
                </p>
              </div>
            )}

            {streak !== 0 && (
              <p
                className={`mb-6 text-lg font-bold ${
                  streak > 0 ? 'text-[var(--palm)]' : 'text-[#9f3030]'
                }`}
              >
                {streak > 0 ? '🔥' : '💧'} {streakLabel(streak)}
              </p>
            )}

            {gameResult.reasoning && (
              <details className="demo-code-block mb-6 text-left">
                <summary className="cursor-pointer text-sm font-semibold">
                  🧠 AIの思考過程
                </summary>
                <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-[var(--sea-ink-soft)]">
                  {gameResult.reasoning}
                </p>
              </details>
            )}

            <div className="flex justify-center gap-3">
              <button
                onClick={handleReset}
                className="demo-button demo-button-secondary"
              >
                もう一度
              </button>
              <button onClick={shareToX} className="demo-button">
                <svg viewBox="0 0 16 16" aria-hidden="true" width="16" height="16">
                  <path
                    fill="currentColor"
                    d="M12.6 1h2.2L10 6.48 15.64 15h-4.41L7.78 9.82 3.23 15H1l5.14-5.84L.72 1h4.52l3.12 4.73L12.6 1zm-.77 12.67h1.22L4.57 2.26H3.26l8.57 11.41z"
                  />
                </svg>
                Xでシェア
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
