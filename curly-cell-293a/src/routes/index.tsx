import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { env } from 'cloudflare:workers'
import OpenAI from 'openai'
import { useState } from 'react'

type Hand = 'グー' | 'チョキ' | 'パー'
type GameResult = { aiHand: Hand; result: '勝ち' | '負け' | 'あいこ' }

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

const playJanken = createServerFn({ method: 'POST' })
  .validator((hand: Hand) => hand)
  .handler(async ({ data: playerHand }): Promise<GameResult> => {
    const { CF_ACCOUNT_ID, CF_GATEWAY_ID } = env as Env & { OPENAI_API_KEY: string }
    const apiKey = (env as Env & { OPENAI_API_KEY: string }).OPENAI_API_KEY

    const client = new OpenAI({
      apiKey,
      baseURL: `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_ID}/custom-spark-cccd`,
    })

    const completion = await client.chat.completions.create({
      model: 'nvidia/Qwen3.6-35B-A3B-NVFP4',
      messages: [
        {
          role: 'system',
          content:
            'あなたはじゃんけんの対戦相手です。最後に「グー」「チョキ」「パー」のいずれか1語だけを出力してください。',
        },
        { role: 'user', content: 'じゃんけんの手を1つ選んでください。' },
      ],
      max_tokens: 2048,
    })

    const choice = completion.choices[0]
    const msg = choice?.message
    const reasoning = (msg as { reasoning?: string } | undefined)?.reasoning ?? ''
    // reasoningモデルなので content が空でも reasoning の中に答えが出ることがある
    const text = `${msg?.content ?? ''} ${reasoning}`.trim()
    let aiHand: Hand
    if (text.includes('グー')) aiHand = 'グー'
    else if (text.includes('チョキ')) aiHand = 'チョキ'
    else if (text.includes('パー')) aiHand = 'パー'
    else
      throw new Error(
        `AIの返答が不正です: finish_reason=${choice?.finish_reason} usage=${JSON.stringify(completion.usage)} msg=${JSON.stringify(msg)}`,
      )

    return { aiHand, result: judge(playerHand, aiHand) }
  })

export const Route = createFileRoute('/')({ component: App })

function App() {
  const [playerHand, setPlayerHand] = useState<Hand | null>(null)
  const [gameResult, setGameResult] = useState<GameResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handlePlay = async (hand: Hand) => {
    setPlayerHand(hand)
    setGameResult(null)
    setError(null)
    setIsLoading(true)
    try {
      const result = await playJanken({ data: hand })
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
