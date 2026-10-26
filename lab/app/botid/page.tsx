import { BotIdForm } from "./form";

export default function BotIdPage() {
  return (
    <main>
      <h1>BotID</h1>
      <p>The button sends a POST to <code>/api/botid</code>, which calls <code>checkBotId()</code>.</p>
      <BotIdForm />
    </main>
  );
}
