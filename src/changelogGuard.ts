/** Validate only the newest release notes; published history is left untouched. */
export interface ChangelogIssue {
  line: number;
  text: string;
  reason: string;
}

interface ManifestIdentity {
  version: string;
}

const INTERNAL_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  { reason: "test-coverage mention", pattern: /(?:增加|新增|补充|补齐|完善|扩展|稳定|通过|完成|优化|修复).{0,45}(?:回归(?:测试|检查|用例|覆盖)|隔离回归|浏览器回归|单元测试|单测|测试覆盖)/ },
  { reason: "test-coverage mention", pattern: /(?:通过|完成).{0,12}\d+\s*(?:项|个)\s*(?:测试|检查|用例)/ },
  { reason: "test-coverage mention", pattern: /\b(?:add(?:ed)?|extend(?:ed)?|improv(?:e|ed)|stabili[sz](?:e|ed)|run|ran|pass(?:ed)?|complete(?:d)?|fix(?:ed)?|update(?:d)?)\b.{0,90}\b(?:regression (?:tests?|checks?|coverage|cases?|suites?)|browser regression|unit tests?|test (?:coverage|suites?))\b/i },
  { reason: "test-coverage mention", pattern: /\b(?:pass(?:ed)?|complete(?:d)?)\s+(?:all\s+)?\d+\s+(?:tests?|checks?|cases?)\b/i },
  { reason: "local packaging convention", pattern: /本地测试包|测试包版本|local test package|stamp local/i },
  { reason: "author validation note", pattern: /已由作者|作者.{0,8}实测|testing by the author|(?:tested|verified|validated) by the author/i },
];

/** Development allows Unreleased; packaging requires a matching dated release. */
export function changelogIssues(text: string, manifest: ManifestIdentity, options: { requireRelease?: boolean } = {}): ChangelogIssue[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const issues: ChangelogIssue[] = [];
  const add = (index: number, reason: string) => issues.push({ line: index + 1, text: lines[index] ?? "", reason });
  let fence: { char: string; length: number } | undefined;
  const visible = lines.map(line => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { char: marker[0], length: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      return false;
    }
    return !fence;
  });
  const start = lines.findIndex((line, index) => visible[index] && /^##\s+/.test(line));
  if (start < 0) { add(0, "missing release section"); return issues; }
  const heading = lines[start].trim();
  const unreleased = /^##\s+(?:(?:未发布|待发布)\s*\/\s*)?Unreleased$/i.test(heading);
  const release = /^##\s+(\d+\.\d+\.\d+(?:-[\da-z.-]+)?)\s+—\s+(\d{4}-\d{2}-\d{2})$/i.exec(heading);
  if (!unreleased && !release) add(start, "expected ## 未发布 / Unreleased or ## <version> — YYYY-MM-DD");
  if (release) {
    const date = new Date(`${release[2]}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== release[2]) add(start, "invalid release date");
  }
  if (unreleased && options.requireRelease) add(start, "package requires a dated release section instead of Unreleased");
  if (release && release[1] !== manifest.version) add(start, `release version must match package.json (${manifest.version})`);
  const sections = new Map<string, { count: number; line: number }>();
  let language: string | undefined;
  let bullet: { index: number; text: string } | undefined;
  const flush = () => {
    if (!bullet) return;
    const match = INTERNAL_PATTERNS.find(rule => rule.pattern.test(bullet!.text));
    if (match) add(bullet.index, match.reason);
    bullet = undefined;
  };
  for (let index = start + 1; index < lines.length; index++) {
    if (!visible[index]) continue;
    const line = lines[index];
    if (/^##\s+/.test(line)) break;
    const subheading = /^###\s+(.+?)\s*$/.exec(line);
    if (subheading) {
      flush();
      language = subheading[1];
      if (language !== "中文" && language !== "English") { add(index, "expected ### 中文 or ### English"); language = undefined; }
      else if (sections.has(language)) add(index, `duplicate ${language} section`);
      else sections.set(language, { count: 0, line: index });
      continue;
    }
    const item = /^\s*[-*+]\s+(\S.*)$/.exec(line);
    if (item) {
      flush();
      if (!language) add(index, "release entry must belong to a language section");
      else sections.get(language)!.count++;
      bullet = { index, text: item[1] };
    } else if (bullet && line.trim()) bullet.text += ` ${line.trim()}`;
  }
  flush();
  for (const label of ["中文", "English"]) {
    const section = sections.get(label);
    if (!section) add(start, `missing ${label} section`);
    else if (!section.count) add(section.line, `empty ${label} section`);
  }
  return issues;
}
