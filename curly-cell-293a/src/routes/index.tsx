import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import OpenAI from 'openai'
import { useEffect, useState } from 'react'

type Hand = 'グー' | 'チョキ' | 'パー'
type GameResult = {
  aiHand: Hand
  result: '勝ち' | '負け' | 'あいこ'
  reasoning: string
}

const HANDS: Array<{ hand: Hand; emoji: string }> = [
  { hand: 'グー', emoji: '✊' },
  { hand: 'チョキ', emoji: '✌️' },
  { hand: 'パー', emoji: '🖐️' },
]

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

type PlayInput = { hand: Hand; history: Hand[] }

const playJanken = createServerFn({ method: 'POST' })
  .validator((input: PlayInput) => input)
  .handler(async ({ data: { hand: playerHand, history } }): Promise<GameResult> => {
    const { CF_ACCOUNT_ID, CF_GATEWAY_ID } = env as Env & { OPENAI_API_KEY: string }
    const apiKey = (env as Env & { OPENAI_API_KEY: string }).OPENAI_API_KEY

    const client = new OpenAI({
      apiKey,
      baseURL: `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_ID}/custom-spark-cccd`,
      defaultHeaders: { 'cf-aig-skip-cache': 'true' },
    })

    // 直近の履歴を新しい順に最大20件渡す
    const recent = history.slice(-20)
    const historyText =
      recent.length > 0
        ? `これまでに相手（人間）が出した手の履歴（古い順）: ${recent.join('、')}。この傾向を読んで、相手が次に出しそうな手に勝てる手を選んでください。`
        : 'まだ対戦履歴はありません。'

    const completion = await client.chat.completions.create({
      model: 'nvidia/Qwen3.6-35B-A3B-NVFP4',
      messages: [
        {
          role: 'system',
          content:
            'あなたはじゃんけんの対戦相手です。相手の過去の手の傾向を分析し、勝てる手を選びます。まず簡潔に考えたうえで、最後の行に「グー」「チョキ」「パー」のいずれか1語だけを出力してください。',
        },
        { role: 'user', content: `${historyText}\nあなたの手を1つ選んでください。` },
      ],
      max_tokens: 4096,
    })

    const choice = completion.choices[0]
    const msg = choice?.message
    const reasoning = (msg as { reasoning?: string } | undefined)?.reasoning ?? ''
    const content = msg?.content ?? ''
    // reasoningモデルなので content が空でも reasoning の中に答えが出ることがある
    const text = `${content} ${reasoning}`.trim()

    // 最後に出現した手を採用する（推論の途中に別の手が混ざるため）
    const lastIndex = (hand: Hand) => text.lastIndexOf(hand)
    const candidates = HANDS.map((h) => h.hand).filter((h) => lastIndex(h) >= 0)
    if (candidates.length === 0) {
      throw new Error(
        `AIの返答が不正です: finish_reason=${choice?.finish_reason} usage=${JSON.stringify(completion.usage)} msg=${JSON.stringify(msg)}`,
      )
    }
    const aiHand = candidates.sort((a, b) => lastIndex(b) - lastIndex(a))[0]

    return { aiHand, result: judge(playerHand, aiHand), reasoning: reasoning || content }
  })

export const Route = createFileRoute('/')({ component: App })

const HISTORY_KEY = 'janken-history'

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

function App() {
  const [playerHand, setPlayerHand] = useState<Hand | null>(null)
  const [gameResult, setGameResult] = useState<GameResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<Hand[]>([])

  useEffect(() => {
    setHistory(loadHistory())
  }, [])

  const handlePlay = async (hand: Hand) => {
    setPlayerHand(hand)
    setGameResult(null)
    setError(null)
    setIsLoading(true)

    // 出した手を履歴に記録
    const nextHistory = [...history, hand]
    setHistory(nextHistory)
    saveHistory(nextHistory)

    try {
      // AIには今回の手を含める前の履歴（=これまでの傾向）を渡す
      const result = await playJanken({ data: { hand, history } })
      setGameResult(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPlayerHand(null)
    } finally {
      setIsLoading(false)
    }
  }

  const handleReset = () => {
    setPlayerHand(null)
    setGameResult(null)
    setError(null)
  }

  const clearHistory = () => {
    setHistory([])
    saveHistory([])
    handleReset()
  }

  const resultEmoji =
    gameResult?.result === '勝ち'
      ? '🎉'
      : gameResult?.result === '負け'
        ? '😞'
        : '🤝'

  return (
    <main className="page-wrap flex min-h-[calc(100vh-8rem)] items-center justify-center px-4 py-8">
      <div className="island-shell rise-in w-full max-w-sm rounded-[2rem] px-6 py-10 text-center">
        <p className="island-kicker mb-3">AI対戦</p>
        <h1 className="display-title mb-8 text-4xl font-bold text-[var(--sea-ink)]">
          じゃんけん
        </h1>

        {!playerHand && !isLoading && (
          <>
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
                  あなたの手の履歴（{history.length}回）— AIが分析に使います
                </p>
                <p className="mb-3 text-lg tracking-wide">
                  {history
                    .slice(-15)
                    .map((h) => HANDS.find((x) => x.hand === h)?.emoji)
                    .join(' ')}
                </p>
                <button
                  onClick={clearHistory}
                  className="demo-button demo-button-secondary text-xs"
                >
                  履歴をクリア
                </button>
              </div>
            )}
          </>
        )}

        {isLoading && (
          <div className="py-6">
            <p className="mb-3 text-4xl">🤔</p>
            <p className="text-[var(--sea-ink-soft)]">AIが考えています…</p>
          </div>
        )}

        {error && (
          <div className="demo-alert demo-alert-danger py-4">
            <p className="mb-3 text-sm font-semibold">エラーが発生しました</p>
            <p className="mb-4 break-all font-mono text-xs opacity-80">{error}</p>
            <button onClick={handleReset} className="demo-button demo-button-secondary text-sm">
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

            <button
              onClick={handleReset}
              className="demo-button demo-button-secondary"
            >
              もう一度
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
