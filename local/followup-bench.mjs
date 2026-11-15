// Follow-up check benchmark against the real local Gemma (laptop Ollama). Assistant-written (Nov 14).
// Run: node local/followup-bench.mjs [rounds]   (synthetic pairs only; prints metadata + accuracy)
import { checkFollowup } from "../router/src/classifier.ts";

const opts = { baseUrl: "http://127.0.0.1:11434", model: "gemma4-a3:e2b", timeoutMs: 5000, numCtx: 32768 };

// [cloud question (end of reply), user's next message, expected follow-up?]
const CASES = [
  ["I can add both events. Which time zone should I use, and what should I name them?", "Pacific Time and Name it to Test 1 and Test 2", true],
  ["Should I create these two events now?", "yes", true],
  ["Should I create these two events now?", "go ahead", true],
  ["Do you want the 10 AM or the 2 PM slot?", "the second one", true],
  ["Which city should I check the weather for?", "Los Angeles", true],
  ["I found 3 unread emails from Alex. Want me to summarize them?", "sure, just the first two", true],
  ["What subject line should the draft have?", "Project update for Friday", true],
  ["Is the meeting with Priya or with Sam?", "Sam", true],
  ["Here's the draft. Should I change anything?", "make it shorter and friendlier", true],
  ["Do you mean this Saturday or next Saturday?", "next one", true],
  ["Should I create these two events now?", "What is the capital of France?", false],
  ["Which time zone should I use?", "tell me a joke", false],
  ["Do you want me to summarize them?", "What is 12 times 9?", false],
  ["Which city should I check the weather for?", "hi", false],
  ["Should I send the draft for review?", "thanks!", false],
  ["What should I name the event?", "Translate 'good morning' into Spanish", false],
  ["Do you want the 10 AM or the 2 PM slot?", "who wrote Hamlet?", false],
  ["Anything else I can help with?", "what's a good name for a goldfish", false],
  ["Want me to add a reminder too?", "how many legs does a spider have", false],
  ["Should I search for more articles?", "good night", false],
];

const rounds = Number(process.argv[2] ?? 2);
const results = [];
for (let r = 0; r < rounds; r++) {
  for (const [q, m, expected] of CASES) {
    const res = await checkFollowup(q, m, opts);
    results.push({ round: r, expected, got: res.followup, ms: res.ms, error: res.error ?? null });
  }
}
const scored = results.filter((x) => x.got !== null);
const correct = scored.filter((x) => x.got === x.expected).length;
const warm = results.filter((x) => x.round > 0 || rounds === 1).map((x) => x.ms).sort((a, b) => a - b);
const perCase = CASES.map(([, , expected], i) => ({
  case: i + 1, expected, answers: results.filter((_, j) => j % CASES.length === i).map((x) => x.got),
}));
console.log(JSON.stringify({
  model: opts.model, rounds, cases: CASES.length,
  accuracy: `${correct}/${scored.length}`, errors: results.length - scored.length,
  medianMsWarm: warm[Math.floor(warm.length / 2)], maxMs: Math.max(...results.map((x) => x.ms)),
  misses: perCase.filter((c) => c.answers.some((a) => a !== c.expected)),
}, null, 2));
