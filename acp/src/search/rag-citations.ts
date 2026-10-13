/** Syntactic grounding gate, not an entailment/proof checker. Never repair invented citations. */
export function validateRagCitations(answer: string,sourceCount: number): void {
  let citations = 0;
  for(const match of answer.matchAll(/\[([^\]\n]{1,160})\]/gu)) {
    const value = match[1]!;
    if(!/\d|source|источник/iu.test(value)) continue;
    if(!/^[1-9]\d?$/u.test(value) || Number(value)>sourceCount) throw new Error("RAG returned invalid citations; retry the question");
    citations++;
  }
  if(!citations || /\bSource\s*#?\s*\d|источник\s*#?\s*\d/iu.test(answer)) {
    throw new Error("RAG returned missing or malformed citations; retry the question");
  }
}
