import { WebClient } from "@slack/web-api";
import { readFileSync } from "fs";

const env = readFileSync(".env", "utf-8");
const token = env.match(/SLACK_BOT_TOKEN=(.+)/)?.[1]?.trim();
const channel = env.match(/SLACK_DEFAULT_CHANNEL=(.+)/)?.[1]?.trim();

const slack = new WebClient(token);
const auth = await slack.auth.test();
console.log("Bot:", auth.user, auth.user_id);

const hist = await slack.conversations.history({ channel: channel!, limit: 5 });
for (const m of [...(hist.messages || [])].reverse()) {
  const who = m.user === auth.user_id ? "[BOT]" : "[USER]";
  console.log(who, m.ts, (m.text || "").slice(0, 100));
}
