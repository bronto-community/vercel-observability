import { registerOTel } from "@vercel/otel";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";

// Spans leave only through Vercel's collector (a trace drain), so no exporter is configured here.
export async function register() {
  // Next.js creates its own `fetch <METHOD> <url>` span (AppRender.fetch) for every
  // globalThis.fetch call unless this is set. @vercel/otel's fetch instrumentation
  // sets it too; without that instrumentation, Next.js's span and the undici span
  // would describe the same request twice.
  process.env.NEXT_OTEL_FETCH_DISABLED = "1";
  registerOTel({
    serviceName: "vercel-observability-lab",
    // The undici instrumentation replaces @vercel/otel's default fetch
    // instrumentation. It covers globalThis.fetch (Node's fetch is undici) and
    // libraries that bring their own undici copy (e.g. @vercel/blob). Keeping
    // both ("auto" plus undici) gave every globalThis.fetch call two spans.
    // Node.js >= 22.15 is required by @opentelemetry/instrumentation-undici 0.34.
    instrumentations: [new UndiciInstrumentation()],
  });

  // The Flags SDK and the Global Config SDK ship their own spans but need to be
  // handed a tracer provider. These are the libraries' hooks, not hand-rolled spans.
  const { trace } = await import("@opentelemetry/api");
  const { setTracerProvider: setFlagsTracerProvider } = await import("flags");
  setFlagsTracerProvider(trace.getTracerProvider());
  // The Global Config README passes the `trace` API object itself.
  const { setTracerProvider: setGlobalConfigTracerProvider } = await import("@vercel/global-config");
  setGlobalConfigTracerProvider(trace);
}
