/** Parse URI suffixes before decoding: `%23` can be part of a real filename. */
export function localMarkdownFileLink(href: string): { path: string; line?: number; endLine?: number } | null {
  if (!href || /^(?:\/\/|#|\?)/.test(href) || /^(?![a-z]:[\\/])[a-z][a-z\d+.-]*:/i.test(href)) return null;
  const suffix = href.search(/[?#]/);
  let file = suffix < 0 ? href : href.slice(0, suffix);
  try { file = decodeURIComponent(file); } catch { /* Preserve literal percent filenames. */ }
  if (!file || file.includes("\0")) return null;
  const fragment = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
  const match = /^L([1-9]\d*)(?:-L?([1-9]\d*))?$/.exec(fragment);
  const line = Number(match?.[1]), endLine = Number(match?.[2] ?? match?.[1]);
  return match && Number.isSafeInteger(line) && Number.isSafeInteger(endLine) && endLine >= line && endLine <= 10000000
    ? { path: file, line, ...(endLine !== line ? { endLine } : {}) } : { path: file };
}
