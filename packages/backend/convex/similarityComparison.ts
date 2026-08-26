export type SimilarityFile = { path: string; content: string };

export type MatchedSpan = {
  path: string;
  start: number;
  end: number;
  relatedPath: string;
  relatedStart: number;
  relatedEnd: number;
  text: string;
};

type Token = { value: string; start: number; end: number; ordinal: number };

const TOKEN = /[A-Za-z_]\w*|\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]/g;
const MIN_MATCH_TOKENS = 8;
const MIN_MATCH_CHARACTERS = 24;
const MAX_SPANS = 20;
const MAX_SPAN_CHARACTERS = 2_000;

function tokenize(content: string): Token[] {
  return Array.from(content.matchAll(TOKEN), (match, ordinal) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
    ordinal,
  }));
}

function authoredTokens(file: SimilarityFile, starter?: SimilarityFile) {
  const tokens = tokenize(file.content);
  if (!starter) return tokens;
  if (starter.content === file.content) return [];

  const starterTokens = tokenize(starter.content);
  const starterTriples = new Map<string, number[]>();
  for (let index = 0; index <= starterTokens.length - 3; index++) {
    const key = starterTokens
      .slice(index, index + 3)
      .map(({ value }) => value)
      .join("\0");
    const positions = starterTriples.get(key) ?? [];
    positions.push(index);
    starterTriples.set(key, positions);
  }

  const excluded = new Set<number>();
  for (let index = 0; index <= tokens.length - 3; index++) {
    const key = tokens
      .slice(index, index + 3)
      .map(({ value }) => value)
      .join("\0");
    for (const starterIndex of starterTriples.get(key) ?? []) {
      let length = 3;
      while (tokens[index + length]?.value === starterTokens[starterIndex + length]?.value) {
        length++;
      }
      for (let offset = 0; offset < length; offset++) excluded.add(index + offset);
    }
  }
  return tokens.filter((_, index) => !excluded.has(index));
}

function overlaps(start: number, end: number, ranges: { start: number; end: number }[]) {
  return ranges.some((range) => start < range.end && end > range.start);
}

export function compareSubmissionFiles(
  files: SimilarityFile[],
  relatedFiles: SimilarityFile[],
  starterFiles: SimilarityFile[],
): MatchedSpan[] {
  const starters = new Map(starterFiles.map((file) => [file.path, file]));
  const left = files.map((file) => ({
    file,
    tokens: authoredTokens(file, starters.get(file.path)),
  }));
  const right = relatedFiles.map((file) => ({
    file,
    tokens: authoredTokens(file, starters.get(file.path)),
  }));
  const candidates: (MatchedSpan & { tokenCount: number })[] = [];

  for (const leftFile of left) {
    for (const rightFile of right) {
      const positions = new Map<string, number[]>();
      for (const [index, token] of rightFile.tokens.entries()) {
        const entries = positions.get(token.value) ?? [];
        entries.push(index);
        positions.set(token.value, entries);
      }
      for (const [leftIndex, leftToken] of leftFile.tokens.entries()) {
        for (const rightIndex of positions.get(leftToken.value) ?? []) {
          const previousLeft = leftFile.tokens[leftIndex - 1];
          const previousRight = rightFile.tokens[rightIndex - 1];
          if (
            previousLeft &&
            previousRight &&
            previousLeft?.value === previousRight?.value &&
            previousLeft.ordinal + 1 === leftToken.ordinal &&
            previousRight.ordinal + 1 === rightFile.tokens[rightIndex]!.ordinal
          ) {
            continue;
          }
          let tokenCount = 0;
          while (true) {
            const leftMatch = leftFile.tokens[leftIndex + tokenCount];
            const rightMatch = rightFile.tokens[rightIndex + tokenCount];
            if (
              !leftMatch ||
              !rightMatch ||
              leftMatch.value !== rightMatch.value ||
              (tokenCount > 0 &&
                (leftMatch.ordinal !== leftFile.tokens[leftIndex + tokenCount - 1]!.ordinal + 1 ||
                  rightMatch.ordinal !==
                    rightFile.tokens[rightIndex + tokenCount - 1]!.ordinal + 1)) ||
              leftMatch.end - leftToken.start > MAX_SPAN_CHARACTERS
            ) {
              break;
            }
            tokenCount++;
          }
          if (tokenCount < MIN_MATCH_TOKENS) continue;
          const leftEnd = leftFile.tokens[leftIndex + tokenCount - 1]!.end;
          const rightStart = rightFile.tokens[rightIndex]!.start;
          const rightEnd = rightFile.tokens[rightIndex + tokenCount - 1]!.end;
          const text = leftFile.file.content.slice(leftToken.start, leftEnd);
          if (text.replace(/\s/g, "").length < MIN_MATCH_CHARACTERS) continue;
          candidates.push({
            path: leftFile.file.path,
            start: leftToken.start,
            end: leftEnd,
            relatedPath: rightFile.file.path,
            relatedStart: rightStart,
            relatedEnd: rightEnd,
            text,
            tokenCount,
          });
        }
      }
    }
  }

  candidates.sort(
    (a, b) =>
      b.tokenCount - a.tokenCount ||
      a.path.localeCompare(b.path) ||
      a.start - b.start ||
      a.relatedPath.localeCompare(b.relatedPath) ||
      a.relatedStart - b.relatedStart,
  );
  const usedLeft = new Map<string, { start: number; end: number }[]>();
  const usedRight = new Map<string, { start: number; end: number }[]>();
  const result: MatchedSpan[] = [];
  for (const { tokenCount: _, ...candidate } of candidates) {
    const leftRanges = usedLeft.get(candidate.path) ?? [];
    const rightRanges = usedRight.get(candidate.relatedPath) ?? [];
    if (
      overlaps(candidate.start, candidate.end, leftRanges) ||
      overlaps(candidate.relatedStart, candidate.relatedEnd, rightRanges)
    ) {
      continue;
    }
    result.push(candidate);
    leftRanges.push({ start: candidate.start, end: candidate.end });
    rightRanges.push({ start: candidate.relatedStart, end: candidate.relatedEnd });
    usedLeft.set(candidate.path, leftRanges);
    usedRight.set(candidate.relatedPath, rightRanges);
    if (result.length === MAX_SPANS) break;
  }
  return result;
}
