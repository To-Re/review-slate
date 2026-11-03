/** Clipboard denial is a presentation limitation, never a review/storage failure. */
export async function copyText(value: string, clipboard?: Pick<Clipboard, 'writeText'>): Promise<boolean> {
  if (!clipboard) return false;
  try { await clipboard.writeText(value); return true; } catch { return false; }
}
