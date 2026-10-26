"use client";

import { useState } from "react";

export function BotIdForm() {
  const [result, setResult] = useState<string>("");
  async function send() {
    const res = await fetch("/api/botid", { method: "POST" });
    setResult(`${res.status} ${await res.text()}`);
  }
  return (
    <div>
      <button onClick={send}>Send POST</button>
      <pre>{result}</pre>
    </div>
  );
}
