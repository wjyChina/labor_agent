// Keep full captured output in the transcript; only bounded previews enter the
// model history. Never rewrite older history items, which would break caching.
function excerpt(text: string, limit: number) {
  if (text.length <= limit) return text;
  const marker = '\n… [middle omitted] …\n';
  const remaining = Math.max(0, limit - marker.length);
  const head = Math.ceil(remaining / 2), tail = Math.floor(remaining / 2);
  return text.slice(0, head) + marker + (tail ? text.slice(-tail) : '');
}

export function toolOutputForContext(tool: string, text: string, resultId: string, maxChars: number) {
  // Detail reads are explicitly requested and already paginated by the tool.
  if (tool === 'tool_result_get' || text.length <= maxChars) return text;
  const hint = `Preview only. Use tool_result_get with result_id "${resultId}" and offset/limit to read captured output. Do not rerun the command just to recover its output.`;
  if (tool === 'bash') {
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { /* Fall back to a text preview. */ }
    if (parsed && typeof parsed.stdout === 'string' && typeof parsed.stderr === 'string') {
      // Preserve exit status and both stream tails, where failures often appear.
      let allowance = Math.max(0, maxChars - hint.length - 300);
      for (;;) {
        const stderrBudget = Math.min(parsed.stderr.length, Math.floor(allowance / 2));
        const preview = JSON.stringify({
          exit_code: parsed.exit_code, signal: parsed.signal,
          ...(parsed.error ? { error: excerpt(String(parsed.error), 200) } : {}),
          truncated: parsed.truncated,
          ...(parsed.truncation ? { truncation: parsed.truncation } : {}),
          stdout: excerpt(parsed.stdout, allowance - stderrBudget), stderr: excerpt(parsed.stderr, stderrBudget),
          context_truncated: true, result_id: resultId, total_chars: text.length, hint,
        });
        if (preview.length <= maxChars || allowance === 0) return preview;
        allowance = Math.max(0, Math.floor(allowance * 0.8));
      }
    }
  }
  const footer = `\n[${text.length} characters; result_id: ${resultId}]\n${hint}`;
  return excerpt(text, Math.max(0, maxChars - footer.length)) + footer;
}
