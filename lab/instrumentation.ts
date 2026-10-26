import { registerOTel } from "@vercel/otel";

// Spans leave only through Vercel's collector (a trace drain), so no exporter is configured here.
export async function register() {
  registerOTel({ serviceName: "vercel-observability-lab" });

  // The Flags SDK ships its own spans but needs to be handed a tracer provider.
  // This is the library's hook, not a hand-rolled span.
  const { trace } = await import("@opentelemetry/api");
  const { setTracerProvider } = await import("flags");
  setTracerProvider(trace.getTracerProvider());
}
