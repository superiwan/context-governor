export function estimateTokens(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) {
    return 0;
  }

  const latinWords = trimmed.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const cjkChars = trimmed.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const punctuation = trimmed.length - latinWords - cjkChars;
  return Math.max(1, Math.ceil(latinWords * 0.8 + cjkChars + punctuation * 0.25));
}
