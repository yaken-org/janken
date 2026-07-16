import { trace, context } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { Resource } from '@opentelemetry/resources'
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions'

declare global {
  // eslint-disable-next-line no-var
  var _otelInitialized: boolean
}

if (!globalThis._otelInitialized) {
  globalThis._otelInitialized = true

  // Mackerel OTLP endpoint
  const otelEndpoint = process.env['MACKEREL_OTLP_ENDPOINT']
  // Mackerel API key for auth
  const mackerelApiKey = process.env['MACKEREL_API_KEY']

  if (otelEndpoint && mackerelApiKey) {
    const exporter = new OTLPTraceExporter({
      url: `${otelEndpoint}/api/v2/traces`,
      headers: {
        'X-Api-Key': mackerelApiKey,
      },
    })

    const sdk = new SimpleSpanProcessor({
      export: exporter,
    })

    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'janken',
      [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
    })

    trace.setGlobalTracerProvider({
      spanContext: () => undefined,
    } as any)

    const provider = trace.getTracerProvider()
    if (provider) {
      provider.register({
        contextManager: new (class {
          active() {
            return context.active()
          }
          with<A extends unknown[], F>(
            ctx: unknown,
            fn: (...args: A) => F,
            thisArg?: F,
            ...args: A
          ): F {
            return context.with(ctx as any, fn, thisArg, ...args)
          }
          enterWith() {
            /* no-op */
          }
        })(),
      })
      provider.addSpanProcessor(sdk)
      console.log('[OTel] Initialized → Mackerel', otelEndpoint)
    }
  } else {
    console.log('[OTel] SKIPPED — MACKEREL_OTLP_ENDPOINT or MACKEREL_API_KEY missing')
  }
}

export const tracer = trace.getTracer('janken', '1.0.0')
