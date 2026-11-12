export type Target = "local" | "cloud" | "held"

export interface Decision{
    target: Target;
    rule: string;
}

const SIMPLE_MAX_CHARS = 200;
const REASONING_WORDS: readonly string[] = [
  "step by step", "explain why", "analyze", "compare", "plan",
];


export function decide(message: string): Decision{
    const normalizedMessage = message.toLowerCase();
    if(REASONING_WORDS.some((word) => normalizedMessage.includes(word))) 
        return {target:"cloud", rule:"reasoning-heavy"} 
    if(message.length<=SIMPLE_MAX_CHARS)
        return  {target:"local", rule:"simple-task"}
    return {target:"cloud", rule:"default-cloud"} 
}