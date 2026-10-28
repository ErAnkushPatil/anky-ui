/**
 * Offline stand-ins for an LLM backend: rule-based rewrites streamed as Server-Sent Events, and
 * phrase-based email completions. Both honour AbortSignal like a real `fetch` would.
 */

export const PROMPTS = {
  professional: "Rewrite the following text in a clear, professional tone.",
  shorten: "Make the following text shorter while preserving its meaning.",
  grammar: "Fix the grammar and spelling of the following text without changing its meaning.",
} as const;

type Rule = [RegExp, string];

const GRAMMAR: Rule[] = [
  [/\balot\b/gi, "a lot"],
  [/\bshould of\b/gi, "should have"],
  [/\bcould of\b/gi, "could have"],
  [/\bwould of\b/gi, "would have"],
  [/\bless meetings\b/gi, "fewer meetings"],
  [/\bMe and the team\b/g, "The team and I"],
  [/\bme and the team\b/g, "the team and I"],
  [/\bIrregardless\b/g, "Regardless"],
  [/\birregardless\b/g, "regardless"],
  [/\bwhat your working\b/gi, "what you're working"],
  [/\bIf your thinking\b/g, "If you're thinking"],
  [/\bthey're replies\b/gi, "their replies"],
  [/\bits easy\b/g, "it's easy"],
  [/\btwo week experiment\b/gi, "two-week experiment"],
];

const FILLERS: Rule[] = [
  [/\b(?:Honestly|Basically|Actually),\s*/g, ""],
  [/\b(?:honestly|basically|actually|really|just|pretty|super|way)\s+(?=\w)/gi, ""],
  [/\bkinda\s+/gi, ""],
  [/,?\s*for sure\b/gi, ""],
];

const PROFESSIONAL: Rule[] = [
  ...GRAMMAR,
  [/\b(?:Honestly|Basically),\s*/g, ""],
  [/\bhonestly\s+/gi, ""],
  [/\bkinda\b/gi, "somewhat"],
  [/\bgonna\b/gi, "going to"],
  [/\bwanna\b/gi, "want to"],
  [/\ba ton of\b/gi, "many"],
  [/\ba bunch of\b/gi, "several"],
  [/\ba lot\b/gi, "considerably"],
  [/\bFolks\b/g, "Colleagues"],
  [/\bfolks\b/g, "colleagues"],
  [/\bpeople\b/g, "team members"],
  [/\bstuff\b/gi, "work"],
  [/\bsuper\b/gi, "highly"],
  [/\bpretty\b/gi, "fairly"],
  [/\bway too\b/gi, "excessively"],
  [/\bhuge\b/gi, "significant"],
  [/\bfigured out\b/gi, "determined"],
  [/\bwasn't\b/g, "was not"],
  [/\bdon't\b/g, "do not"],
  [/\bcan't\b/g, "cannot"],
  [/\bit's\b/g, "it is"],
  [/\bIt's\b/g, "It is"],
  [/\bThat's\b/g, "That is"],
  [/\bthat's\b/g, "that is"],
  [/\bfor sure\b/gi, "certainly"],
  [/\bsilly\b/gi, "informal"],
  [/\bat the crack of dawn\b/gi, "unusually early"],
  [/\bgo off on a tangent\b/gi, "digress"],
  [/\bstuck in traffic\b/gi, "commuting"],
  [/\bfalls apart\b/gi, "breaks down"],
  [/\bmessy\b/gi, "disorganized"],
  [/\bstatus theater\b/gi, "performative reporting"],
  [/!/g, "."],
];

function applyRules(text: string, rules: Rule[]): string {
  return rules.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([,.;:])/g, "$1")
    .replace(/(^|[.!?]\s+|\n\s*)([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
}

function shorten(text: string): string {
  const trimmed = tidy(applyRules(applyRules(text, GRAMMAR), FILLERS));
  const sentences = trimmed.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [trimmed];
  if (sentences.length < 3) return trimmed;
  // Keep roughly the first 60% of the sentences.
  return sentences.slice(0, Math.ceil(sentences.length * 0.6)).join("").trimEnd();
}

/** Deterministic, rule-based stand-in for the model's answer. */
export function mockRewrite(text: string, prompt: string): string {
  // Keep the selection's surrounding whitespace so the diff only highlights real edits.
  const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  let out: string;
  if (prompt === PROMPTS.grammar) out = applyRules(body, GRAMMAR);
  else if (prompt === PROMPTS.shorten) out = shorten(body);
  else out = tidy(applyRules(body, PROFESSIONAL));
  if (out === body && prompt !== PROMPTS.grammar) out = `In practice, ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
  return lead + out + trail;
}

function sseEvent(data: string): string {
  return data.split("\n").map((line) => `data: ${line}`).join("\n") + "\n\n";
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

export interface MockStreamTiming {
  /** Delay before the first token. Default 450ms (time-to-first-byte). */
  firstTokenMs?: number;
  /** Fixed delay between tokens, e.g. `20` for 50 tokens/s. Default: random 25-70ms. */
  tokenIntervalMs?: number;
}

/** Streams `text` word by word as an SSE body, like an LLM endpoint would. */
export function mockSSEStream(text: string, signal: AbortSignal, timing: MockStreamTiming = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const tokens = text.match(/\s*\S+|\s+$/g) ?? [];
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          try {
            controller.error(abortError(signal));
          } catch {
            // Already closed.
          }
        },
        { once: true },
      );
    },
    pull(controller) {
      const delay =
        index === 0 ? (timing.firstTokenMs ?? 450) : (timing.tokenIntervalMs ?? 25 + Math.random() * 45);
      return new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (signal.aborted) return resolve();
          if (index < tokens.length) {
            controller.enqueue(encoder.encode(sseEvent(tokens[index++])));
          } else {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
          resolve();
        }, delay);
      });
    },
    cancel() {
      clearTimeout(timer);
    },
  });
}

const EMAIL_PHRASES = [
  "Hi team,",
  "Hi Sarah,",
  "I hope you're doing well.",
  "I hope you had a great weekend.",
  "I wanted to follow up on our conversation from yesterday.",
  "I wanted to share a quick update on the async standup experiment.",
  "Thanks for the quick turnaround on the draft.",
  "Thanks for sending this over.",
  "Could you take a look at the latest version when you have a moment?",
  "Could we find time this week to review the results together?",
  "Please find the updated proposal attached.",
  "As discussed, the pilot will run for two weeks starting Monday.",
  "Let me know if you have any questions.",
  "Let me know what you think.",
  "Looking forward to hearing from you.",
  "Happy to help with anything else you need.",
  "Best regards,\nAnky",
  "Thanks again,\nAnky",
];

/** Completes the sentence being typed from a small phrase book, after a simulated network delay. */
export function mockSuggest(text: string, { signal }: { signal: AbortSignal }): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const fragment = /(?:^|[.!?\n])\s*([^.!?\n]*)$/.exec(text)?.[1] ?? "";
      if (fragment.trim().length < 2) return resolve("");
      const lower = fragment.toLowerCase();
      const match = EMAIL_PHRASES.find((phrase) => phrase.length > fragment.length && phrase.toLowerCase().startsWith(lower));
      resolve(match ? match.slice(fragment.length) : "");
    }, 120);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError(signal));
      },
      { once: true },
    );
  });
}
